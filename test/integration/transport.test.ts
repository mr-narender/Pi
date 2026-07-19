import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { once } from 'node:events';
import { RpcTransport } from '../../src/rpc/transport';

class SlowWritable extends Writable {
  public writes: string[] = [];
  private first = true;

  public override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void
  ): void {
    this.writes.push(chunk.toString('utf8'));
    callback();
    if (this.first) {
      this.first = false;
      setTimeout(() => this.emit('drain'), 20);
    }
  }

  public override write(
    chunk: string | Uint8Array,
    encoding?: BufferEncoding | ((error: Error | null | undefined) => void),
    cb?: (error: Error | null | undefined) => void
  ): boolean {
    super.write(
      chunk,
      typeof encoding === 'function' ? 'utf8' : (encoding ?? 'utf8'),
      typeof encoding === 'function' ? encoding : cb
    );
    return !this.first;
  }
}

test('RpcTransport correlates responses and honours write drain', async () => {
  const stdin = new SlowWritable();
  const stdout = new PassThrough();
  const transport = new RpcTransport(stdin, stdout, null, {
    maxRecordBytes: 1024,
    maxBufferBytes: 1024,
    maxPendingRequests: 8,
    maxQueuedWrites: 8,
  });

  const request = transport.request({ id: '1', type: 'get_state' });
  await once(stdin, 'drain');
  stdout.write(
    '{"id":"1","type":"response","command":"get_state","success":true,"data":{"sessionId":"abc"}}\n'
  );
  const response = await request;
  assert.equal(response.success, true);
  assert.match(stdin.writes[0] ?? '', /"type":"get_state"/);
});

test('RpcTransport rejects pending requests on disconnect', async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const transport = new RpcTransport(stdin, stdout, null, {
    maxRecordBytes: 1024,
    maxBufferBytes: 1024,
    maxPendingRequests: 8,
    maxQueuedWrites: 8,
  });
  const request = transport.request({ id: '1', type: 'get_state' });
  transport.disconnect(new Error('lost'));
  await assert.rejects(request, /lost/);
});

test('RpcTransport preserves unknown non-response envelopes without disconnecting', async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const transport = new RpcTransport(stdin, stdout, null, {
    maxRecordBytes: 1024,
    maxBufferBytes: 1024,
    maxPendingRequests: 8,
    maxQueuedWrites: 8,
  });

  let faulted = false;
  let disconnected = false;
  transport.on('protocolFault', () => {
    faulted = true;
  });
  transport.on('disconnected', () => {
    disconnected = true;
  });

  const compatibility = once(transport, 'event');
  stdout.write('{"type":"new_unknown_event","note":"token=secret"}\n');
  const [event] = await compatibility;
  assert.equal((event as { type: string }).type, 'new_unknown_event');
  assert.equal((event as { compatibility?: true }).compatibility, true);

  const request = transport.request({ id: '1', type: 'get_state' });
  stdout.write('{"id":"1","type":"response","command":"get_state","success":true,"data":{}}\n');
  const response = await request;
  assert.equal(response.success, true);
  assert.equal(faulted, false);
  assert.equal(disconnected, false);
});

test('RpcTransport faults on malformed correlated compatibility envelopes', async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const transport = new RpcTransport(stdin, stdout, null, {
    maxRecordBytes: 1024,
    maxBufferBytes: 1024,
    maxPendingRequests: 8,
    maxQueuedWrites: 8,
  });

  const pending = transport.request({ id: '1', type: 'get_state' });
  const fault = once(transport, 'protocolFault');
  const disconnected = once(transport, 'disconnected');
  stdout.write('{"id":"1","type":"new_unknown_event","command":"get_state"}\n');
  const [error] = await fault;
  await disconnected;
  await assert.rejects(pending, /Unexpected compatibility envelope for pending id: 1/);
  assert.match(
    String((error as Error).message),
    /Unexpected compatibility envelope for pending id: 1/
  );
});

test('RpcTransport faults on orphan responses', async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const transport = new RpcTransport(stdin, stdout, null, {
    maxRecordBytes: 1024,
    maxBufferBytes: 1024,
    maxPendingRequests: 8,
    maxQueuedWrites: 8,
  });
  const fault = once(transport, 'protocolFault');
  stdout.write(
    '{"id":"orphan","type":"response","command":"get_state","success":true,"data":{}}\n'
  );
  const [error] = await fault;
  assert.match(String((error as Error).message), /Orphan response id/);
});
