import test from 'node:test';
import assert from 'node:assert/strict';
import { JsonlDecoder, JsonlProtocolError } from '../../src/rpc/jsonlDecoder';

function chunks(value: Uint8Array, sizes: number[]): Uint8Array[] {
  const out: Uint8Array[] = [];
  let offset = 0;
  for (const size of sizes) {
    out.push(value.subarray(offset, Math.min(value.length, offset + size)));
    offset += size;
  }
  if (offset < value.length) {
    out.push(value.subarray(offset));
  }
  return out;
}

test('jsonlDecoder accepts split UTF-8 and final EOF record', () => {
  const decoder = new JsonlDecoder({ maxRecordBytes: 1024, maxBufferBytes: 1024 });
  const bytes = Buffer.from('{"a":"🙂"}\n{"b":"last"}', 'utf8');
  const out: string[] = [];
  for (const chunk of chunks(bytes, [1, 2, 3, 1, 4])) {
    out.push(...decoder.push(chunk));
  }
  out.push(...decoder.end());
  assert.deepEqual(out, ['{"a":"🙂"}', '{"b":"last"}']);
});

test('jsonlDecoder preserves U+2028 and U+2029 inside JSON strings', () => {
  const decoder = new JsonlDecoder({ maxRecordBytes: 1024, maxBufferBytes: 1024 });
  const input = Buffer.from('{"text":"line\u2028sep\u2029ok"}\n', 'utf8');
  const out = decoder.push(input);
  assert.equal(out[0], '{"text":"line\u2028sep\u2029ok"}');
});

test('jsonlDecoder strips one trailing CR only', () => {
  const decoder = new JsonlDecoder({ maxRecordBytes: 1024, maxBufferBytes: 1024 });
  const out = decoder.push(Buffer.from('{"a":1}\r\n', 'utf8'));
  assert.deepEqual(out, ['{"a":1}']);
});

test('jsonlDecoder rejects blank records', () => {
  const decoder = new JsonlDecoder({ maxRecordBytes: 1024, maxBufferBytes: 1024 });
  assert.throws(() => decoder.push(Buffer.from('\n', 'utf8')), JsonlProtocolError);
});

test('jsonlDecoder rejects malformed UTF-8', () => {
  const decoder = new JsonlDecoder({ maxRecordBytes: 1024, maxBufferBytes: 1024 });
  assert.throws(() => decoder.push(Uint8Array.from([0xc3, 0x28, 0x0a])), JsonlProtocolError);
});

test('jsonlDecoder enforces record size limits', () => {
  const decoder = new JsonlDecoder({ maxRecordBytes: 8, maxBufferBytes: 16 });
  assert.throws(() => decoder.push(Buffer.from('{"long":true}\n', 'utf8')), JsonlProtocolError);
});

test('jsonlDecoder random chunking property', () => {
  const source = ['{"a":1}', '{"b":"two"}', '{"c":[1,2,3]}'].join('\n');
  for (let seed = 1; seed < 50; seed += 1) {
    const decoder = new JsonlDecoder({ maxRecordBytes: 1024, maxBufferBytes: 1024 });
    const bytes = Buffer.from(source, 'utf8');
    let index = 0;
    const out: string[] = [];
    while (index < bytes.length) {
      const size = ((seed * 17 + index) % 5) + 1;
      out.push(...decoder.push(bytes.subarray(index, Math.min(bytes.length, index + size))));
      index += size;
    }
    out.push(...decoder.end());
    assert.deepEqual(out, ['{"a":1}', '{"b":"two"}', '{"c":[1,2,3]}']);
  }
});
