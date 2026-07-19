import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RpcClient } from '../../src/rpc/client';
import { RpcTransport } from '../../src/rpc/transport';

export interface SpawnedRpc {
  child: ChildProcessWithoutNullStreams;
  transport: RpcTransport;
  client: RpcClient;
  cwd: string;
}

export async function spawnMockPi(): Promise<SpawnedRpc> {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-rpc-test-'));
  const child = spawn(process.execPath, ['--import', 'tsx', 'test/fixtures/mock-pi-child.ts'], {
    cwd: process.cwd(),
    stdio: 'pipe',
    env: { ...process.env },
  });
  const transport = new RpcTransport(child.stdin, child.stdout, child.stderr, {
    maxRecordBytes: 1_000_000,
    maxBufferBytes: 1_000_000,
    maxPendingRequests: 64,
    maxQueuedWrites: 64,
  });
  const client = new RpcClient(1, transport, { shortTimeoutMs: 5000, longTimeoutMs: 5000 });
  return { child, transport, client, cwd };
}

export async function spawnRealPi(extraArgs: string[] = []): Promise<SpawnedRpc> {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-rpc-real-'));
  const child = spawn(
    'pi',
    ['--mode', 'rpc', '--offline', '--no-approve', '--no-session', ...extraArgs],
    {
      cwd,
      stdio: 'pipe',
      env: { ...process.env, PI_TELEMETRY: '0', PI_SKIP_VERSION_CHECK: '1', PI_OFFLINE: '1' },
    }
  );
  const transport = new RpcTransport(child.stdin, child.stdout, child.stderr, {
    maxRecordBytes: 1_000_000,
    maxBufferBytes: 1_000_000,
    maxPendingRequests: 64,
    maxQueuedWrites: 64,
  });
  const client = new RpcClient(1, transport, { shortTimeoutMs: 10000, longTimeoutMs: 10000 });
  return { child, transport, client, cwd };
}

export async function shutdown(spawned: SpawnedRpc): Promise<void> {
  spawned.transport.disconnect(new Error('test shutdown'));
  spawned.child.kill('SIGTERM');
  await new Promise<void>((resolve) => {
    spawned.child.once('exit', () => resolve());
    setTimeout(resolve, 1000);
  });
}
