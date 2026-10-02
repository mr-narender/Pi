import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import { createNativeFixture, spawnNativeSdkHost } from '../helpers/nativeFixture';

// Owned synthetic 2100x1 PNG, no external assets or image libraries.
function image() {
  const crc = (b: Buffer) => {
    let n = 0xffffffff;
    for (const v of b) {
      n ^= v;
      for (let i = 0; i < 8; i++) n = (n >>> 1) ^ (n & 1 ? 0xedb88320 : 0);
    }
    return (n ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const b = Buffer.concat([Buffer.from(type), data]);
    const len = Buffer.alloc(4),
      sum = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    sum.writeUInt32BE(crc(b));
    return Buffer.concat([len, b, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(2100, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.alloc(1 + 2100 * 3, 0))),
    chunk('IEND', Buffer.alloc(0)),
  ]).toString('base64');
}

for (const mode of ['shared', 'dedicated'] as const) {
  test(
    `NAMED owned synthetic loopback image-effects ${mode}: native model-input block and resize`,
    { timeout: 60000 },
    async () => {
      const f = await createNativeFixture('image-effects');
      let child: Awaited<ReturnType<typeof spawnNativeSdkHost>>['child'] | undefined;
      try {
        const started = await spawnNativeSdkHost(f, mode);
        child = started.child;
        let buf = '',
          seq = 0;
        const pending = new Map<string, (r: any) => void>();
        child.stdout!.on('data', (c) => {
          buf += c;
          let i;
          while ((i = buf.indexOf('\n')) >= 0) {
            const { d } = JSON.parse(buf.slice(0, i));
            buf = buf.slice(i + 1);
            if (d.type === 'response') {
              pending.get(d.id ?? d.command)?.(d);
              pending.delete(d.id ?? d.command);
            }
          }
        });
        const rpc = async (d: any) => {
          const id = d.type === 'open' ? undefined : String(++seq);
          const p = new Promise<any>((r) => pending.set(id ?? 'open', r));
          child!.stdin!.write(JSON.stringify({ k: 'owned', d: { ...d, id } }) + '\n');
          const r = await p;
          if (!r.success) throw new Error(r.error);
          return r.data;
        };
        await rpc(started.open);
        const original = image();
        let count = 0;
        for (const resize of [false, true])
          for (const block of [false, true]) {
            await rpc({ type: 'new_session' });
            let snap = await rpc({ type: 'get_preferences' });
            for (const [key, value] of [
              ['imageAutoResize', resize],
              ['blockImages', block],
            ] as const) {
              snap = await rpc({
                type: 'save_preference',
                key,
                value,
                expectedRevision: snap.revision,
                confirmGlobal: true,
              });
              assert.equal(snap.rows.find((r: any) => r.key === key).active, value);
            }
            await rpc({
              type: 'prompt',
              message: 'Owned synthetic image-effects probe',
              images: [{ type: 'image', data: original, mimeType: 'image/png' }],
            });
            for (let i = 0; i < 200; i++) {
              const state = await rpc({ type: 'get_state' });
              if (!state.isStreaming && !state.isRetrying && f.requests > count) break;
              await new Promise((r) => setTimeout(r, 10));
            }
            count++;
            assert.equal(
              f.requests,
              count,
              'exactly one intended dummy-credential loopback request per probe'
            );
            const payload = f.summaryRequests.at(-1) as any;
            const parts = payload.messages.flatMap((m: any) =>
              Array.isArray(m.content) ? m.content : []
            );
            const images = parts.filter((p: any) => p.type === 'image_url');
            assert.equal(images.length, block ? 0 : 1, 'actual provider model-input exclusion');
            if (!block) {
              const data = images[0].image_url.url.split(',')[1];
              if (!resize)
                assert.equal(
                  data,
                  original,
                  'native autoResize=false leaves image bytes unchanged'
                );
              else {
                assert.notEqual(data, original, 'native image transformation must change bytes');
                const messages = await rpc({ type: 'get_messages' });
                assert.match(JSON.stringify(messages), /original 2100x1, displayed at 2000x1/);
              }
            }
          }
        assert.equal(f.requests, 4);
        assert.equal(await readFile(f.networkLog, 'utf8'), '');
      } finally {
        child?.stdin?.end();
        child?.kill();
        if (child && child.exitCode === null) await new Promise((r) => child!.once('exit', r));
        await f.dispose();
      }
    }
  );
}
