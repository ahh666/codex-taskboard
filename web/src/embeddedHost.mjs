function frameCapability() {
  return typeof globalThis.__CODEX_TASKBOARD_FRAME_CAPABILITY__ === "string"
    ? globalThis.__CODEX_TASKBOARD_FRAME_CAPABILITY__
    : "";
}

let activeFrameChallenge = "";
let requestSequence = 0;
const pendingApiRequests = new Map();
let apiResponseListenerInstalled = false;

export function setEmbeddedFrameChallenge(challenge) {
  activeFrameChallenge = typeof challenge === "string" ? challenge : "";
}

export function postEmbeddedHostMessage(message) {
  window.parent.postMessage({
    ...message,
    capability: frameCapability(),
    challenge: activeFrameChallenge,
  }, "*");
}

function installApiResponseListener() {
  if (apiResponseListenerInstalled) return;
  apiResponseListenerInstalled = true;
  window.addEventListener("message", (event) => {
    if (event.source !== window.parent) return;
    const message = event.data;
    if (message?.type !== "taskboard:api-response") return;
    const payload = message.payload;
    if (!payload || typeof payload.requestId !== "string") return;
    const pending = pendingApiRequests.get(payload.requestId);
    if (!pending) return;
    pendingApiRequests.delete(payload.requestId);
    window.clearTimeout(pending.timeoutId);
    if (payload.ok === false) {
      pending.reject(new Error(
        typeof payload.error === "string" ? payload.error : "Taskboard API request failed",
      ));
      return;
    }
    pending.resolve(payload);
  });
}

export function requestEmbeddedHostApi(request, signal) {
  installApiResponseListener();
  const requestId = `${Date.now().toString(36)}-${(++requestSequence).toString(36)}`;
  return new Promise((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      pendingApiRequests.delete(requestId);
      reject(new Error("Taskboard API request timed out"));
    }, 30_000);
    const abort = () => {
      pendingApiRequests.delete(requestId);
      window.clearTimeout(timeoutId);
      reject(new DOMException("The operation was aborted", "AbortError"));
    };
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
    pendingApiRequests.set(requestId, {
      timeoutId,
      resolve: (payload) => {
        signal?.removeEventListener("abort", abort);
        resolve(payload);
      },
      reject: (error) => {
        signal?.removeEventListener("abort", abort);
        reject(error);
      },
    });
    postEmbeddedHostMessage({
      type: "taskboard:api-request",
      payload: { ...request, requestId },
    });
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
