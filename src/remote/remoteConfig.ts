// Pure (vscode-free) URL helpers for the remote broker host client.

/** Normalize a broker base URL and switch http(s) → ws(s). */
export function toWsBase(brokerUrl: string): string {
  const trimmed = brokerUrl.trim().replace(/\/+$/, '');
  if (/^https:\/\//i.test(trimmed)) {
    return trimmed.replace(/^https:\/\//i, 'wss://');
  }
  if (/^http:\/\//i.test(trimmed)) {
    return trimmed.replace(/^http:\/\//i, 'ws://');
  }
  // Assume TLS if no scheme given.
  return `wss://${trimmed}`;
}

export function httpBase(brokerUrl: string): string {
  return brokerUrl.trim().replace(/\/+$/, '');
}

/** Outbound host WebSocket URL (the extension dials this). */
export function hostWsUrl(brokerUrl: string, sessionId: string, hostToken: string): string {
  return `${toWsBase(brokerUrl)}/host?session=${encodeURIComponent(sessionId)}&token=${encodeURIComponent(hostToken)}`;
}

/** Pairing link shown as a QR — carries only the one-time code, in the fragment. */
export function pairingLink(brokerUrl: string, pairingCode: string): string {
  return `${httpBase(brokerUrl)}/p#${encodeURIComponent(pairingCode)}`;
}
