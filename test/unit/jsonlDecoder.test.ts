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

test('jsonlDecoder accepts a large burst of complete records in one chunk (session resume)', () => {
  // Simulates Pi replaying a whole session on resume: many small, complete
  // newline-delimited records arriving in a single stdout chunk whose total
  // size far exceeds maxBufferBytes. Each record is well under maxRecordBytes,
  // so every one must decode without a "Pending stdout buffer exceeded limit".
  const decoder = new JsonlDecoder({ maxRecordBytes: 256, maxBufferBytes: 512 });
  const records = Array.from({ length: 500 }, (_, i) => `{"i":${i},"role":"user"}`);
  const bytes = Buffer.from(records.join('\n') + '\n', 'utf8');
  assert.ok(bytes.length > 512, 'burst must exceed the buffer limit to be meaningful');
  const out = decoder.push(bytes);
  assert.equal(out.length, records.length);
  assert.deepEqual(out, records);
});

test('jsonlDecoder accepts a big single record within maxRecordBytes across many chunks', () => {
  const decoder = new JsonlDecoder({ maxRecordBytes: 1_000_000, maxBufferBytes: 2_000_000 });
  const big = `{"text":"${'x'.repeat(500_000)}"}`;
  const bytes = Buffer.from(big + '\n', 'utf8');
  const out: string[] = [];
  for (let i = 0; i < bytes.length; i += 60_000) {
    out.push(...decoder.push(bytes.subarray(i, Math.min(bytes.length, i + 60_000))));
  }
  assert.deepEqual(out, [big]);
});

test('jsonlDecoder rejects an unterminated residual that exceeds maxBufferBytes', () => {
  const decoder = new JsonlDecoder({ maxRecordBytes: 64, maxBufferBytes: 32 });
  // No newline: the residual grows unbounded and must be capped.
  assert.throws(
    () => decoder.push(Buffer.from('x'.repeat(64), 'utf8')),
    JsonlProtocolError,
    'residual over the buffer limit must throw'
  );
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
