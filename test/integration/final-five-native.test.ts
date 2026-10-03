import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createNativeFixture,
  spawnNativeSdkHost,
  spawnNativePublicAuth,
} from '../helpers/nativeFixture';

test(
  'fixed owned actual public ModelRuntime OAuth callbacks/store/cancellation without accounts',
  { timeout: 15000 },
  async () => {
    const fixture = await createNativeFixture('scopes');
    try {
      const child = await spawnNativePublicAuth(fixture);
      let stdout = '',
        stderr = '';
      child.stdout!.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr!.on('data', (chunk) => {
        stderr += chunk;
      });
      const code = await new Promise((r) => child.once('close', r));
      assert.equal(code, 0, stderr);
      assert.deepEqual(JSON.parse(stdout.trim()), {
        oauthStore: true,
        logout: true,
        cancel: true,
        secretWire: false,
      });
      assert.equal(fixture.requests, 0);
    } finally {
      await fixture.dispose();
    }
  }
);

for (const mode of ['shared', 'dedicated'] as const)
  test(
    `final five actual ${mode} public login/store/logout/import/branch payload`,
    { timeout: 25000 },
    async () => {
      const fixture = await createNativeFixture('scopes');
      let host: Awaited<ReturnType<typeof spawnNativeSdkHost>> | undefined;
      try {
        host = await spawnNativeSdkHost(fixture, mode, 'engine');
        let buffer = '',
          sequence = 0;
        const pending = new Map<string, (reply: any) => void>();
        host.child.stdout!.on('data', (chunk) => {
          buffer += chunk;
          let index;
          while ((index = buffer.indexOf('\n')) >= 0) {
            const { k, d } = JSON.parse(buffer.slice(0, index));
            buffer = buffer.slice(index + 1);
            if (d.type === 'response') {
              pending.get(`${k}:${d.id ?? 'open'}`)?.(d);
              pending.delete(`${k}:${d.id ?? 'open'}`);
            }
          }
        });
        const request = async (command: any, key = 'one') => {
          const id = command.type === 'open' ? undefined : String(++sequence);
          const reply = new Promise<any>((resolve) =>
            pending.set(`${key}:${id ?? 'open'}`, resolve)
          );
          host!.child.stdin!.write(JSON.stringify({ k: key, d: { ...command, id } }) + '\n');
          const result = await reply;
          if (!result.success) throw new Error(result.error);
          return result.data;
        };
        await request(host.open);
        if (mode === 'shared') await request(host.open, 'other');
        const other = mode === 'shared' ? await request({ type: 'get_state' }, 'other') : undefined;
        const origin = async () => {
          const state = await request({ type: 'get_state' });
          return {
            sessionId: state.sessionId,
            sessionFile: state.sessionFile,
            leafId: (await request({ type: 'get_entries' })).leafId,
          };
        };
        const command = async (type: string, payload = {}) =>
          request({ type, guiLifecycle: true, origin: await origin(), ...payload });
        const metadata = await command('auth_providers');
        assert.ok(
          metadata.providers.some(
            (p: any) => p.providerId === 'fixture-alpha' && p.types.includes('api_key')
          )
        );
        assert.ok(!JSON.stringify(metadata).includes('fixture-key'));
        const before = await request({ type: 'get_state' });
        const cancelledFlow = await command('auth_login', {
          providerId: 'fixture-alpha',
          authType: 'api_key',
        });
        const staleOrigin = { ...(await origin()), leafId: 'owned-stale-leaf' };
        await assert.rejects(
          request({
            type: 'auth_response',
            guiLifecycle: true,
            origin: staleOrigin,
            nonce: cancelledFlow.nonce,
            value: 'PRIVATE_STALE_CANARY',
          }),
          /STALE_ORIGIN/
        );
        await request({
          type: 'auth_response',
          guiLifecycle: true,
          origin: staleOrigin,
          nonce: cancelledFlow.nonce,
          value: null,
        });
        for (let i = 0; i < 100; i++) {
          const status = await request({
            type: 'auth_poll',
            guiLifecycle: true,
            origin: staleOrigin,
            nonce: cancelledFlow.nonce,
          });
          if (status.status === 'cancelled') break;
          await new Promise((r) => setTimeout(r, 10));
        }
        const start = await command('auth_login', {
          providerId: 'fixture-alpha',
          authType: 'api_key',
        });
        let step;
        for (let i = 0; i < 100; i++) {
          step = await command('auth_poll', { nonce: start.nonce });
          if (step.prompt) break;
          await new Promise((r) => setTimeout(r, 10));
        }
        assert.equal(step.prompt.type, 'secret');
        await assert.rejects(
          command('auth_response', {
            nonce: start.nonce,
            promptNonce: 'wrong',
            value: 'owned-dummy',
          })
        );
        await command('auth_response', {
          nonce: start.nonce,
          promptNonce: step.prompt.nonce,
          value: 'owned-dummy-api-key',
        });
        for (let i = 0; i < 100; i++) {
          step = await command('auth_poll', { nonce: start.nonce });
          if (step.status !== 'pending') break;
          await new Promise((r) => setTimeout(r, 10));
        }
        assert.equal(step.status, 'applied');
        assert.equal(
          JSON.parse(await readFile(fixture.authFile, 'utf8'))['fixture-alpha'].key,
          'owned-dummy-api-key'
        );
        assert.deepEqual(await request({ type: 'get_state' }), before);
        await command('auth_logout', { providerId: 'fixture-alpha' });
        assert.equal(
          JSON.parse(await readFile(fixture.authFile, 'utf8'))['fixture-alpha'],
          undefined
        );
        const cancelled = await command('auth_login', {
          providerId: 'fixture-alpha',
          authType: 'api_key',
        });
        await command('auth_response', { nonce: cancelled.nonce, value: null });
        await new Promise((r) => setTimeout(r, 30));
        assert.equal((await command('auth_poll', { nonce: cancelled.nonce })).status, 'cancelled');
        const timestamp = '2024-01-01T00:00:00.000Z';
        const seed = join(fixture.cwd, 'seed.jsonl');
        await writeFile(
          seed,
          JSON.stringify({ type: 'session', version: 3, id: 'seed', cwd: fixture.cwd, timestamp }) +
            '\n'
        );
        await request({ type: 'switch_session', sessionPath: seed });
        for (const version of [1, 2, 3]) {
          const path = join(fixture.cwd, `owned-import-${version}.jsonl`);
          const bytes =
            [
              {
                type: 'session',
                version,
                id: `owned-import-${version}`,
                cwd: fixture.cwd,
                timestamp,
              },
              {
                type: 'message',
                ...(version > 1 ? { id: 'user', parentId: null } : {}),
                timestamp,
                message: { role: 'user', content: `version ${version}`, timestamp: 1 },
              },
            ]
              .map((e) => JSON.stringify(e))
              .join('\n') + '\n';
          await writeFile(path, bytes);
          const preview = await command('import_prepare', { sessionPath: path });
          const result = await command('import_session', { nonce: preview.nonce });
          assert.equal(result.cancelled, false);
          assert.equal((await request({ type: 'get_state' })).sessionId, `owned-import-${version}`);
          assert.equal(await readFile(path, 'utf8'), bytes);
          assert.equal(
            (await request({ type: 'get_messages' })).messages.at(-1).content,
            `version ${version}`
          );
          const share = await command('delivery_payload', { share: true });
          const rows = share.jsonl.trim().split('\n').map(JSON.parse);
          assert.equal(rows.at(-1).customType, 'pi.share');
          assert.equal(typeof rows.at(-1).data.systemPrompt, 'string');
          assert.ok(Array.isArray(rows.at(-1).data.tools));
        }
        const bad = join(fixture.cwd, 'bad.jsonl');
        await writeFile(
          bad,
          [
            { type: 'session', version: 3, id: 'bad', cwd: fixture.cwd, timestamp },
            { type: 'custom', id: 'a', parentId: 'b', timestamp, customType: 'x' },
            { type: 'custom', id: 'b', parentId: 'a', timestamp, customType: 'x' },
          ]
            .map((e) => JSON.stringify(e))
            .join('\n')
        );
        const state = await request({ type: 'get_state' });
        await assert.rejects(command('import_prepare', { sessionPath: bad }));
        assert.deepEqual(await request({ type: 'get_state' }), state);
        if (mode === 'shared')
          assert.deepEqual(await request({ type: 'get_state' }, 'other'), other);
        assert.equal(fixture.requests, 0);
      } finally {
        if (host) {
          host.child.stdin!.end();
          await new Promise<void>((r) => host!.child.once('close', () => r()));
        }
        await fixture.dispose();
      }
    }
  );
