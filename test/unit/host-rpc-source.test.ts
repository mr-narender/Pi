import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

// Execute the actual maintained host cases, never import the host or SDK.
const source = readFileSync('host/pi-multi-host.mjs', 'utf8');
const cases = source.slice(
  source.indexOf("      case 'steer': {"),
  source.indexOf("      case 'abort': {")
);
assert.ok(cases.includes("case 'follow_up'"));
const ackHelper = source.slice(
  source.indexOf('  const success = (id, command, data, origin)'),
  source.indexOf('  const error = (id, command, message)')
);
assert.ok(ackHelper.includes("type: 'response'"));
const dispatch = vm.runInNewContext(`(async (session, command) => {
  const id = command.id;
  ${ackHelper}
  switch (command.type) { ${cases} }
})`);

for (const [command, method] of [
  ['steer', 'steer'],
  ['follow_up', 'followUp'],
] as const) {
  for (const disposition of ['handled', 'transformed', 'queued', 'throws']) {
    test(`host RPC ${command}: rpc hook ${disposition}, one legacy ACK without disposition metadata`, async () => {
      let calls = 0;
      const queue: string[] = [];
      const images = [{ type: 'image', mimeType: 'image/png', data: 'AAAA' }];
      const session = {
        [method]: async (message: string, actualImages: unknown, options: { source: string }) => {
          calls++;
          assert.equal(options?.source, 'rpc');
          assert.equal(actualImages, images);
          if (disposition === 'throws') throw new Error('hook rejected');
          if (disposition !== 'handled')
            queue.push(disposition === 'transformed' ? 'rewritten' : message);
          return { disposition: disposition === 'handled' ? 'handled' : 'queued' };
        },
      };
      const run = dispatch(session, { type: command, id: 'fixture', message: 'benign', images });
      if (disposition === 'throws') await assert.rejects(run, /hook rejected/);
      else {
        const ack = await run;
        assert.deepEqual(JSON.parse(JSON.stringify(ack)), {
          type: 'response',
          id: 'fixture',
          command,
          success: true,
        });
        assert.equal('data' in ack, false); // Native RPC disposition payload is NOT legacy parity.
        assert.deepEqual(
          queue,
          disposition === 'handled' ? [] : [disposition === 'transformed' ? 'rewritten' : 'benign']
        );
      }
      assert.equal(calls, 1);
    });
  }
}
