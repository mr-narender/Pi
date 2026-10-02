import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RpcClient } from '../../src/rpc/client';
import { RpcTransport } from '../../src/rpc/transport';
import { createNativeFixture, nativeSpawnPlan, type NativeFixture } from './nativeFixture';

export interface SpawnedRpc {
  child: ChildProcessWithoutNullStreams;
  transport: RpcTransport;
  client: RpcClient;
  cwd: string;
  fixture?: NativeFixture;
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

export async function spawnRealPi(
  extraArgs: string[] = [],
  suppliedFixture?: NativeFixture
): Promise<SpawnedRpc> {
  const fixture = suppliedFixture ?? (await createNativeFixture());
  let plan;
  try {
    plan = await nativeSpawnPlan(fixture, extraArgs);
  } catch (error) {
    // A rejected supplied object is not trusted enough to invoke its callbacks.
    if (!suppliedFixture) await fixture.dispose();
    throw error;
  }
  const cwd = plan.cwd;
  const child = spawn(plan.command, plan.args, { cwd, stdio: 'pipe', env: plan.env });
  const transport = new RpcTransport(child.stdin, child.stdout, child.stderr, {
    maxRecordBytes: 1_000_000,
    maxBufferBytes: 1_000_000,
    maxPendingRequests: 64,
    maxQueuedWrites: 64,
  });
  const client = new RpcClient(1, transport, { shortTimeoutMs: 10000, longTimeoutMs: 10000 });
  return { child, transport, client, cwd, fixture };
}

export async function shutdown(spawned: SpawnedRpc): Promise<void> {
  spawned.transport.disconnect(new Error('test shutdown'));
  if (spawned.child.exitCode === null && spawned.child.signalCode === null) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => spawned.child.kill('SIGKILL'), 1000);
      spawned.child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      spawned.child.kill('SIGTERM');
    });
  }
  spawned.child.stdin.destroy();
  spawned.child.stdout.destroy();
  spawned.child.stderr.destroy();
  if (spawned.fixture) {
    const attempts = await readFile(spawned.fixture.networkLog, 'utf8');
    await spawned.fixture.dispose();
    if (attempts.trim())
      throw new Error('Native CLI attempted forbidden network access (fixture guard denied it)');
  }
}
