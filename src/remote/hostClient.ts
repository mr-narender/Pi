// Remote broker HOST client. The extension dials OUT to the broker
// (wss://…/host), streams WebviewSnapshots up, and applies inbound driver
// prompts. Nothing listens on this machine. See docs/design/remote-broker-plan.html.

import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { URL } from 'node:url';
import WebSocket from 'ws';
import type { SecretStorage } from 'vscode';

import { hostWsUrl, httpBase } from './remoteConfig';

// Cloudflare (bot-fight / browser-integrity) rejects requests with no
// User-Agent (HTTP 403, error 1010). Node's http/ws send none by default, so we
// set an explicit one on every request and on the WebSocket handshake.
const USER_AGENT = 'PiYours-VSCode/1.0';

export interface RemoteSession {
  sessionId: string;
  hostToken: string;
  pairingCode: string;
  pin: string;
  expiresAt: number;
}

type Json = Record<string, unknown>;

export class RemoteHostClient {
  private static readonly persistedSessionKey = 'pi.remote.hostSession';
  private socket: WebSocket | undefined;
  private session: RemoteSession | undefined;
  private brokerUrl = '';
  private promptHandler: ((message: string) => void) | undefined;
  private stateHandler: ((connected: boolean) => void) | undefined;
  private viewerHandler: ((event: 'joined' | 'left', count: number) => void) | undefined;
  private presenceHandler:
    | ((devices: Array<{ id: string; name: string; role: string }>, count: number) => void)
    | undefined;
  private chatSelectHandler: ((chatId: string) => void) | undefined;
  private chatListRequestHandler: (() => void) | undefined;

  public constructor(private readonly secrets?: SecretStorage) {}

  public onPrompt(handler: (message: string) => void): void {
    this.promptHandler = handler;
  }

  /** Notified when a phone/viewer connects to or leaves the session. */
  public onViewer(handler: (event: 'joined' | 'left', count: number) => void): void {
    this.viewerHandler = handler;
  }

  /** Notified with the authoritative device list (presence). */
  public onPresence(
    handler: (devices: Array<{ id: string; name: string; role: string }>, count: number) => void
  ): void {
    this.presenceHandler = handler;
  }

  public onStateChange(handler: (connected: boolean) => void): void {
    this.stateHandler = handler;
  }

  public onChatSelect(handler: (chatId: string) => void): void {
    this.chatSelectHandler = handler;
  }

  public onChatListRequest(handler: () => void): void {
    this.chatListRequestHandler = handler;
  }

  public pushChatList(chats: unknown[]): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: 'chatList', chats }));
    }
  }

  public get active(): boolean {
    return this.socket !== undefined;
  }

  public get currentSession(): RemoteSession | undefined {
    return this.session;
  }

  /** POST /session (host secret), then open the outbound /host WebSocket. */
  public async start(brokerUrl: string, hostSecret: string): Promise<RemoteSession> {
    await this.stop();
    this.brokerUrl = httpBase(brokerUrl);
    const data = await postJson(
      `${this.brokerUrl}/session`,
      {},
      { Authorization: `Bearer ${hostSecret}` }
    );
    const session: RemoteSession = {
      sessionId: String(data.session_id ?? ''),
      hostToken: String(data.host_token ?? ''),
      pairingCode: String(data.pairing_code ?? ''),
      pin: String(data.pin ?? ''),
      expiresAt: Number(data.expires_at ?? 0),
    };
    if (!session.sessionId || !session.hostToken) {
      throw new Error('Broker did not return a session.');
    }
    this.session = session;
    await this.openSocket(session);
    await this.persistSession();
    return session;
  }

  /** Reconnect a session preserved across an extension/VS Code reload. */
  public async restore(): Promise<boolean> {
    if (!this.secrets) {
      return false;
    }
    const raw = await this.secrets.get(RemoteHostClient.persistedSessionKey);
    if (!raw) {
      return false;
    }
    try {
      const saved = JSON.parse(raw) as { brokerUrl?: unknown; session?: RemoteSession };
      if (
        typeof saved.brokerUrl !== 'string' ||
        !saved.brokerUrl ||
        !saved.session?.sessionId ||
        !saved.session.hostToken
      ) {
        throw new Error('invalid persisted remote session');
      }
      this.brokerUrl = saved.brokerUrl;
      this.session = saved.session;
      await this.openSocket(saved.session);
      return true;
    } catch {
      this.socket = undefined;
      this.stateHandler?.(false);
      return false;
    }
  }

  /** Disconnect transport only; the broker session remains resumable. */
  public disconnect(): void {
    const socket = this.socket;
    this.socket = undefined;
    socket?.close();
    this.stateHandler?.(false);
  }

  /** Forward the active chat's snapshot to remote viewers (best-effort). */
  public pushSnapshot(snapshot: unknown): void {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: 'snapshot', snapshot }));
    }
  }

  public async stop(): Promise<void> {
    const session = this.session;
    const brokerUrl = this.brokerUrl;
    const socket = this.socket;
    this.socket = undefined;
    this.session = undefined;
    if (socket) {
      try {
        socket.close();
      } catch {
        /* ignore */
      }
    }
    if (session && brokerUrl) {
      try {
        await postJson(`${brokerUrl}/stop`, {
          session_id: session.sessionId,
          host_token: session.hostToken,
        });
      } catch {
        /* best-effort teardown */
      }
    }
    await this.secrets?.delete(RemoteHostClient.persistedSessionKey);
    this.stateHandler?.(false);
  }

  private async persistSession(): Promise<void> {
    if (this.secrets && this.session && this.brokerUrl) {
      await this.secrets.store(
        RemoteHostClient.persistedSessionKey,
        JSON.stringify({ brokerUrl: this.brokerUrl, session: this.session })
      );
    }
  }

  private openSocket(session: RemoteSession): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(hostWsUrl(this.brokerUrl, session.sessionId, session.hostToken), {
        headers: { 'User-Agent': USER_AGENT },
      });
      this.socket = ws;
      ws.on('open', () => {
        this.stateHandler?.(true);
        resolve();
      });
      ws.on('message', (data: WebSocket.RawData) => {
        try {
          const message = JSON.parse(data.toString()) as Json;
          if (message.type === 'prompt' && typeof message.message === 'string') {
            this.promptHandler?.(message.message);
          } else if (message.type === 'selectChat' && typeof message.chatId === 'string') {
            this.chatSelectHandler?.(message.chatId);
          } else if (message.type === 'requestChatList') {
            this.chatListRequestHandler?.();
          } else if (message.type === 'viewer') {
            const event = message.event === 'left' ? 'left' : 'joined';
            const count = typeof message.count === 'number' ? message.count : 0;
            this.viewerHandler?.(event, count);
          } else if (message.type === 'presence') {
            const devices = Array.isArray(message.devices)
              ? (message.devices as Array<{ id: string; name: string; role: string }>)
              : [];
            const count = typeof message.count === 'number' ? message.count : devices.length;
            this.presenceHandler?.(devices, count);
          }
        } catch {
          /* ignore malformed frames */
        }
      });
      ws.on('error', (error: Error) => {
        if (this.socket === ws) {
          this.socket = undefined;
        }
        reject(error);
      });
      ws.on('close', () => {
        if (this.socket === ws) {
          this.socket = undefined;
        }
        this.stateHandler?.(false);
      });
    });
  }
}

function postJson(url: string, body: Json, headers: Record<string, string> = {}): Promise<Json> {
  return new Promise<Json>((resolve, reject) => {
    const target = new URL(url);
    const payload = JSON.stringify(body ?? {});
    const transport = target.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = transport(
      target,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'User-Agent': USER_AGENT,
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          const status = res.statusCode ?? 500;
          if (status >= 400) {
            reject(new Error(`HTTP ${status}: ${text.slice(0, 200)}`));
            return;
          }
          try {
            resolve(text ? (JSON.parse(text) as Json) : {});
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        });
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}
