// Remote broker HOST client. The extension dials OUT to the broker
// (wss://…/host), streams WebviewSnapshots up, and applies inbound driver
// prompts. Nothing listens on this machine. See docs/design/remote-broker-plan.html.

import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { URL } from 'node:url';
import WebSocket from 'ws';

import { hostWsUrl, httpBase } from './remoteConfig';

export interface RemoteSession {
  sessionId: string;
  hostToken: string;
  pairingCode: string;
  pin: string;
  expiresAt: number;
}

type Json = Record<string, unknown>;

export class RemoteHostClient {
  private socket: WebSocket | undefined;
  private session: RemoteSession | undefined;
  private brokerUrl = '';
  private promptHandler: ((message: string) => void) | undefined;
  private stateHandler: ((connected: boolean) => void) | undefined;

  public onPrompt(handler: (message: string) => void): void {
    this.promptHandler = handler;
  }

  public onStateChange(handler: (connected: boolean) => void): void {
    this.stateHandler = handler;
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
    return session;
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
    this.stateHandler?.(false);
  }

  private openSocket(session: RemoteSession): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(hostWsUrl(this.brokerUrl, session.sessionId, session.hostToken));
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
