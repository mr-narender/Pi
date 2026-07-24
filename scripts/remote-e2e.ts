import WebSocket from 'ws';
import { request } from 'node:http';
import { RemoteHostClient } from '../src/remote/hostClient';

const BROKER = 'http://localhost:8765';
function post(path: string, body: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = request(
      BROKER + path,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const t = Buffer.concat(chunks).toString();
          res.statusCode! >= 400
            ? reject(new Error(`${res.statusCode} ${t}`))
            : resolve(JSON.parse(t || '{}'));
        });
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const client = new RemoteHostClient();
  let gotPrompt = '';
  client.onPrompt((m) => {
    gotPrompt = m;
  });
  const session = await client.start(BROKER, 'localsecret');
  console.log('HOST connected. session', session.sessionId.slice(0, 8) + '…', 'pin', session.pin);

  const pair = await post('/pair', { pairing_code: session.pairingCode, pin: session.pin });
  const vt = pair.viewer_token as string;
  console.log('PHONE paired. viewer token len', vt.length);

  const view = new WebSocket(`ws://localhost:8765/view?session=${session.sessionId}&token=${vt}`);
  let snapText = '';
  view.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.type === 'snapshot') snapText = m.snapshot.messages[0].text;
  });
  await new Promise<void>((res, rej) => {
    view.on('open', () => res());
    view.on('error', rej);
  });
  await sleep(150);

  client.pushSnapshot({ messages: [{ id: 'x', role: 'assistant', text: 'hello-from-vscode' }] });
  await sleep(200);
  console.log('PHONE received snapshot text:', snapText);

  view.send(JSON.stringify({ type: 'claimDriver' }));
  await sleep(150);
  view.send(JSON.stringify({ type: 'prompt', message: 'drive-from-phone' }));
  await sleep(250);
  console.log('HOST received prompt:', gotPrompt);

  await client.stop();
  view.close();
  const ok = snapText === 'hello-from-vscode' && gotPrompt === 'drive-from-phone';
  console.log(ok ? 'E2E PASS' : 'E2E FAIL');
  process.exit(ok ? 0 : 1);
}
main().catch((e) => {
  console.error('E2E ERROR', e);
  process.exit(1);
});
