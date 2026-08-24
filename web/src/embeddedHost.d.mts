export function postEmbeddedHostMessage(message: Record<string, unknown>): void;
export function installEmbeddedExternalLinkHandler(): () => void;
export function setEmbeddedFrameChallenge(challenge: string): void;
export function requestEmbeddedHostApi(
  request: {
    path: string;
    method: string;
    headers: Record<string, string>;
    body: string | null;
  },
  signal?: AbortSignal,
): Promise<{
  status: number;
  headers: Record<string, string>;
  body: string;
}>;
