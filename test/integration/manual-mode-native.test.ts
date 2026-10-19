import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { resolveNativeCli } from '../helpers/nativeFixture';

test('native Pi loads Manual Mode gate and observes every tool and live toggle without reloading', async () => {
  await mkdir('/tmp/pi-extension', { recursive: true });
  const cwd = await mkdtemp('/tmp/pi-extension/manual-mode-');
  try {
    const { root } = await resolveNativeCli();
    const { loadExtensions } = await import(
      pathToFileURL(join(root, 'dist/core/extensions/loader.js')).href
    );
    const extensionsDir = join(cwd, '.pi/extensions');
    await mkdir(extensionsDir, { recursive: true });
    const gate = join(extensionsDir, 'pi-approval-gate.ts');
    const mode = join(cwd, '.pi/pi-vscode-manual-mode.json');
    await copyFile(resolve('resources/pi-approval-gate.ts'), gate);
    await writeFile(mode, JSON.stringify({ enabled: false }));
    const loaded = await loadExtensions([gate], cwd);
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.extensions.length, 1);
    const handler = loaded.extensions[0].handlers.get('tool_call')[0];
    const prompts: string[] = [];
    let choice: string | undefined = 'Allow';
    const ctx = {
      hasUI: true,
      ui: {
        select: async (title: string, options: string[]) => {
          prompts.push(title);
          assert.deepEqual(options, ['Allow', 'Deny']);
          return choice;
        },
      },
    };
    const tools = ['read', 'bash', 'write', 'edit', 'mcp__query', 'delegate_tasks'];
    for (const toolName of tools) {
      assert.equal(await handler({ toolName, input: { command: 'owned test' } }, ctx), undefined);
    }
    assert.equal(prompts.length, 0, 'default automatic mode never prompts');
    await writeFile(mode, JSON.stringify({ enabled: true }));
    for (const toolName of tools) {
      const event = { toolName, input: { command: 'owned test' } };
      assert.equal(await handler(event, ctx), undefined);
      assert.equal(await handler(event, ctx), undefined);
    }
    assert.equal(prompts.length, tools.length * 2, 'every action needs fresh approval');
    assert.match(prompts[0]!, /Allow read/);
    choice = 'Deny';
    assert.equal((await handler({ toolName: 'bash' }, ctx)).block, true);
    choice = undefined;
    assert.equal((await handler({ toolName: 'write' }, ctx)).block, true, 'cancel blocks');
    assert.equal((await handler({ toolName: 'read' }, { hasUI: false })).block, true);
    let answer!: (value: string | undefined) => void;
    let settled = false;
    const waiting = handler(
      { toolName: 'write' },
      {
        hasUI: true,
        ui: {
          select: () =>
            new Promise<string | undefined>((resolve) => {
              answer = resolve;
            }),
        },
      }
    ).then((result: unknown) => {
      settled = true;
      return result;
    });
    while (!answer) await new Promise<void>((resolve) => setImmediate(resolve));
    await writeFile(mode, JSON.stringify({ enabled: false }));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(settled, false, 'disabling does not silently approve an outstanding prompt');
    answer(undefined);
    assert.equal(((await waiting) as { block: boolean }).block, true);
    const count = prompts.length;
    assert.equal(await handler({ toolName: 'read' }, ctx), undefined);
    assert.equal(prompts.length, count, 'same loaded session becomes automatic');
    await writeFile(mode, '{"enabled":"invalid"}');
    assert.equal((await handler({ toolName: 'read' }, ctx)).block, true);
    await rm(mode);
    assert.equal((await handler({ toolName: 'read' }, ctx)).block, true);
    assert.match(await readFile(gate, 'utf8'), /import\.meta\.url/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
