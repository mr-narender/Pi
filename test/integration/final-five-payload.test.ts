import test from 'node:test';
import assert from 'node:assert/strict';
import { bugZip } from '../../src/commands/bugArchive';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
test('ZIP contains only fixed reviewed report/diagnostic/transcript bytes, no paths or env collection', () => {
  const data = [
    { name: 'report.json' as const, data: '{"hint":"owned"}', contentType: 'application/json' },
    { name: 'diagnostics.json' as const, data: '{"count":1}', contentType: 'application/json' },
    {
      name: 'session.jsonl' as const,
      data: '{"role":"user"}\n',
      contentType: 'application/x-ndjson',
    },
  ];
  const bytes = bugZip(data);
  let offset = 0;
  const names: string[] = [];
  for (const file of data) {
    assert.equal(bytes.readUInt32LE(offset), 0x04034b50);
    const size = bytes.readUInt32LE(offset + 18),
      length = bytes.readUInt16LE(offset + 26);
    const name = bytes.subarray(offset + 30, offset + 30 + length).toString();
    names.push(name);
    assert.equal(
      bytes.subarray(offset + 30 + length, offset + 30 + length + size).toString(),
      file.data
    );
    offset += 30 + length + size;
  }
  assert.deepEqual(names, ['report.json', 'diagnostics.json', 'session.jsonl']);
  assert.equal(bytes.readUInt32LE(offset), 0x02014b50);
  assert.equal(bytes.readUInt32LE(bytes.length - 22), 0x06054b50);
  assert.throws(() =>
    bugZip([{ name: '../../env' as any, data: 'secret', contentType: 'text/plain' }])
  );
});
test('strict import validates v1/2/3 without altering bytes; rejects cycle/unknown/invalid usage/content', async () => {
  const url = pathToFileURL(resolve('host/import-validation.mjs')).href;
  const { validateImport } = await import(url);
  const timestamp = '2024-01-01T00:00:00.000Z';
  for (const version of [1, 2, 3]) {
    const bytes = Buffer.from(
      [
        { type: 'session', version, id: 'owned', cwd: '/owned', timestamp },
        {
          type: 'message',
          ...(version > 1 ? { id: 'a', parentId: null } : {}),
          timestamp,
          message: { role: 'user', content: [{ type: 'text', text: 'owned' }], timestamp: 1 },
        },
      ]
        .map((e) => JSON.stringify(e))
        .join('\n') + '\n'
    );
    const copy = Buffer.from(bytes);
    assert.equal(validateImport(bytes).version, version);
    assert.deepEqual(bytes, copy);
  }
  const header = { type: 'session', version: 3, id: 'owned', cwd: '/owned', timestamp };
  for (const entry of [
    {
      type: 'message',
      message: {
        role: 'assistant',
        content: [],
        timestamp: 1,
        api: 'x',
        provider: 'x',
        model: 'x',
        stopReason: 'stop',
        usage: {},
      },
    },
    { type: 'unknown' },
    { type: 'message', message: { role: 'system', content: [{ type: 'toolCall' }], timestamp: 1 } },
  ])
    assert.throws(() =>
      validateImport(
        Buffer.from(
          [header, { id: 'a', parentId: null, timestamp, ...entry }]
            .map((e) => JSON.stringify(e))
            .join('\n')
        )
      )
    );
  assert.throws(() =>
    validateImport(
      Buffer.from(
        [
          header,
          { type: 'custom', id: 'a', parentId: 'b', timestamp, customType: 'x' },
          { type: 'custom', id: 'b', parentId: 'a', timestamp, customType: 'x' },
        ]
          .map((e) => JSON.stringify(e))
          .join('\n')
      )
    )
  );
});
