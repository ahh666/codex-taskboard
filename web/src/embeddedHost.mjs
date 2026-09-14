function frameCapability() {
  return typeof globalThis.__CODEX_TASKBOARD_FRAME_CAPABILITY__ === "string"
    ? globalThis.__CODEX_TASKBOARD_FRAME_CAPABILITY__
    : "";
}

let activeFrameChallenge = "";
let embeddedHttpRequestSequence = 0;
const pendingEmbeddedHttpRequests = new Map();
const EMBEDDED_HTTP_TIMEOUT_MS = 65_000;

export function isEmbeddedTaskboardTransport() {
  if (typeof window === "undefined" || typeof document === "undefined") return false;
  if (window.parent === window) return false;
  try {
    return new URL(document.baseURI).searchParams.get("host") === "codex";
  } catch {
    return false;
  }
}

function flushEmbeddedHttpRequests() {
  if (!activeFrameChallenge) return;
  for (const pending of pendingEmbeddedHttpRequests.values()) {
    if (pending.sent) continue;
    pending.sent = true;
    postEmbeddedHostMessage({
      type: "taskboard:http-request",
      payload: pending.payload,
    });
  }
}

export function setEmbeddedFrameChallenge(challenge) {
  activeFrameChallenge = typeof challenge === "string" ? challenge : "";
  flushEmbeddedHttpRequests();
}

export function postEmbeddedHostMessage(message) {
  window.parent.postMessage({
    ...message,
    capability: frameCapability(),
    challenge: activeFrameChallenge,
  }, "*");
}

function abortError() {
  return new DOMException("The operation was aborted", "AbortError");
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 32 * 1024;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

async function encodeRequestBody(body) {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") {
    return bytesToBase64(new TextEncoder().encode(body));
  }
  if (body instanceof Blob) {
    return bytesToBase64(new Uint8Array(await body.arrayBuffer()));
  }
  if (body instanceof ArrayBuffer) {
    return bytesToBase64(new Uint8Array(body));
  }
  if (ArrayBuffer.isView(body)) {
    return bytesToBase64(new Uint8Array(body.buffer, body.byteOffset, body.byteLength));
  }
  throw new TypeError("Unsupported Taskboard request body");
}

function receiveEmbeddedHostMessage(event) {
  if (event.source !== window.parent || !event.data || typeof event.data !== "object") return;
  const message = event.data;
  if (message.type === "taskboard:frame-challenge") {
    const challenge = message.payload?.challenge;
    if (typeof challenge === "string" && challenge) setEmbeddedFrameChallenge(challenge);
    return;
  }
  if (message.type !== "taskboard:http-response") return;
  const payload = message.payload;
  if (!payload || typeof payload.requestId !== "string") return;
  if (payload.challenge !== activeFrameChallenge) return;
  const pending = pendingEmbeddedHttpRequests.get(payload.requestId);
  if (!pending) return;
  pendingEmbeddedHttpRequests.delete(payload.requestId);
  window.clearTimeout(pending.timeoutId);
  pending.signal?.removeEventListener("abort", pending.abort);
  if (!payload.ok) {
    pending.reject(new TypeError(
      typeof payload.error === "string" ? payload.error : "Taskboard host request failed",
    ));
    return;
  }
  const status = Number(payload.status);
  if (!Number.isInteger(status) || status < 200 || status > 599) {
    pending.reject(new TypeError("Taskboard host returned an invalid status"));
    return;
  }
  const noBody = status === 204 || status === 205 || status === 304;
  pending.resolve(new Response(noBody ? null : String(payload.bodyText ?? ""), {
    status,
    statusText: typeof payload.statusText === "string" ? payload.statusText : "",
    headers: typeof payload.contentType === "string" && payload.contentType
      ? { "content-type": payload.contentType }
      : undefined,
  }));
}

if (typeof window !== "undefined") {
  window.addEventListener("message", receiveEmbeddedHostMessage);
}

export async function fetchTaskboard(path, init = {}) {
  if (!isEmbeddedTaskboardTransport()) {
    return fetch(new URL(String(path).replace(/^\//, ""), document.baseURI).href, init);
  }
  if (init.signal?.aborted) throw abortError();

  const requestId = `${Date.now().toString(36)}-${(++embeddedHttpRequestSequence).toString(36)}`;
  const headers = Object.fromEntries(new Headers(init.headers).entries());
  const bodyBase64 = await encodeRequestBody(init.body);
  if (init.signal?.aborted) throw abortError();

  return new Promise((resolve, reject) => {
    const abort = () => {
      const pending = pendingEmbeddedHttpRequests.get(requestId);
      if (!pending) return;
      pendingEmbeddedHttpRequests.delete(requestId);
      window.clearTimeout(pending.timeoutId);
      reject(abortError());
    };
    const timeoutId = window.setTimeout(() => {
      const pending = pendingEmbeddedHttpRequests.get(requestId);
      if (!pending) return;
      pendingEmbeddedHttpRequests.delete(requestId);
      pending.signal?.removeEventListener("abort", pending.abort);
      reject(new TypeError("Taskboard host request timed out"));
    }, EMBEDDED_HTTP_TIMEOUT_MS);
    const pending = {
      abort,
      payload: {
        requestId,
        method: String(init.method ?? "GET").toUpperCase(),
        path: String(path),
        headers,
        ...(bodyBase64 === undefined ? {} : { bodyBase64 }),
      },
      reject,
      resolve,
      sent: false,
      signal: init.signal,
      timeoutId,
    };
    pendingEmbeddedHttpRequests.set(requestId, pending);
    init.signal?.addEventListener("abort", abort, { once: true });
    if (activeFrameChallenge) flushEmbeddedHttpRequests();
    else postEmbeddedHostMessage({ type: "taskboard:frame-awaiting-challenge" });
  });
}

export function installEmbeddedExternalLinkHandler() {
  const handleClick = (event) => {
    const link = event.target instanceof Element
      ? event.target.closest('a[target="_blank"]')
      : null;
    if (!link) return;

    const rawHref = link.getAttribute("href");
    if (!rawHref) return;

    let url;
    try {
      url = new URL(rawHref);
    } catch {
      return;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return;
    event.preventDefault();
    postEmbeddedHostMessage({
      type: "taskboard:open-external",
      payload: { url: url.href },
    });
  };

  document.addEventListener("click", handleClick, true);
  return () => document.removeEventListener("click", handleClick, true);
}
