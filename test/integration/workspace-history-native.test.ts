import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveNativeCli } from '../helpers/nativeFixture';
import {
  getDefaultSessionDirForWorkspace,
  readRecentSessionsIndex,
} from '../../src/sessions/recentSessions';

test('native Pi folder and saved-workspace cwd spellings discover and reopen both histories', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-native-workspace-history-'));
  const folder = join(root, 'project');
  const alias = join(root, 'workspace-alias');
  const agentDir = join(root, 'agent');
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    await mkdir(folder);
    await symlink(folder, alias, 'junction');
    const canonical = await realpath(folder);
    const native = await resolveNativeCli();
    const sdk = await import(pathToFileURL(join(native.root, 'dist/core/session-manager.js')).href);
    const files: string[] = [];
    for (const cwd of [canonical, alias]) {
      assert.equal(
        getDefaultSessionDirForWorkspace(cwd, agentDir),
        sdk.getDefaultSessionDir(cwd, agentDir)
      );
      const manager = sdk.SessionManager.create(cwd);
      manager.appendMessage({
        role: 'user',
        content: 'Workspace history regression',
        timestamp: Date.now(),
      });
      files.push(manager.getSessionFile());
    }
    for (const workspacePath of [canonical, alias]) {
      const index = await readRecentSessionsIndex({ workspaceName: 'Project', workspacePath });
      assert.deepEqual(index.sessions.map((s) => s.path).sort(), [...files].sort());
      for (const record of index.sessions) {
        const reopened = sdk.SessionManager.open(record.path, undefined, workspacePath);
        assert.equal(
          reopened.getSessionFile(),
          record.path,
          'resume keeps the discovered JSONL path verbatim'
        );
        assert.equal(reopened.getHeader().id, record.id);
        assert.ok(
          reopened.getEntries().some((entry: { type: string }) => entry.type === 'message')
        );
      }
    }
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});
