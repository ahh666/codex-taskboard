export function postEmbeddedHostMessage(message: Record<string, unknown>): void;
export function installEmbeddedExternalLinkHandler(): () => void;
export function setEmbeddedFrameChallenge(challenge: string): void;
export function isEmbeddedTaskboardTransport(): boolean;
export function fetchTaskboard(path: string, init?: RequestInit): Promise<Response>;
