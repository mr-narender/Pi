import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { shutdown, spawnRealPi } from '../helpers/rpc';

const execFileAsync = promisify(execFile);

test('pi-agent-workflow archived source is discoverable through get_commands', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-agent-workflow-'));
  await execFileAsync('bash', [
    '-lc',
    `git -C /Users/narender/dev/agent-registry archive --format=tar --prefix=pi-agent-workflow/ origin/feat/pi-agent-workflow:pi-agent-workflow | tar -xf - -C ${JSON.stringify(root)}`,
  ]);
  const spawned = await spawnRealPi(['-e', join(root, 'pi-agent-workflow')]);
  try {
    const commands = await spawned.client.getCommands();
    const names = Array.isArray(commands?.commands)
      ? commands.commands.map((command) => String((command as Record<string, unknown>).name ?? ''))
      : [];
    assert.ok(names.includes('workflow'));
    assert.ok(names.includes('workflow-status'));
    assert.ok(names.includes('skill:pi-agent-workflow'));
  } finally {
    await shutdown(spawned);
  }
});
