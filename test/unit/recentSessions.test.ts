import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  filterRecentSessions,
  formatRelativeTimestamp,
  getDefaultSessionDirForWorkspace,
  readRecentSessionsIndex,
} from '../../src/sessions/recentSessions';

async function writeSession(
  filePath: string,
  header: Record<string, unknown>,
  entries: Record<string, unknown>[]
): Promise<void> {
  await writeFile(
    filePath,
    [JSON.stringify(header), ...entries.map((entry) => JSON.stringify(entry))].join('\n') + '\n',
    'utf8'
  );
}

test('readRecentSessionsIndex loads and sorts sessions from the default Pi session directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-rpc-recent-'));
  const workspace = join(root, 'workspace');
  const agentDir = join(root, 'agent');
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  await mkdir(workspace, { recursive: true });
  await mkdir(agentDir, { recursive: true });

  try {
    const sessionDir = getDefaultSessionDirForWorkspace(workspace, agentDir);
    await mkdir(sessionDir, { recursive: true });
    await writeSession(
      join(sessionDir, 'older.jsonl'),
      {
        type: 'session',
        id: 'older',
        timestamp: '2024-01-01T00:00:00.000Z',
        cwd: workspace,
      },
      [
        { type: 'session_info', name: 'Named session' },
        {
          type: 'message',
          timestamp: '2024-01-01T00:10:00.000Z',
          message: { role: 'user', content: 'show me the build plan' },
        },
      ]
    );
    await writeSession(
      join(sessionDir, 'newer.jsonl'),
      {
        type: 'session',
        id: 'newer',
        timestamp: '2024-01-02T00:00:00.000Z',
        cwd: workspace,
      },
      [
        { type: 'model_change', provider: 'mock', modelId: 'demo' },
        {
          type: 'message',
          timestamp: '2024-01-02T00:20:00.000Z',
          message: { role: 'user', content: 'token=secret-value should be hidden' },
        },
      ]
    );

    const index = await readRecentSessionsIndex({
      workspaceName: 'workspace',
      workspacePath: workspace,
    });

    assert.equal(index.sessions.length, 2);
    assert.equal(index.sessions[0]?.id, 'newer');
    assert.equal(index.sessions[0]?.displayName.includes('[REDACTED]'), true);
    assert.equal(index.sessions[0]?.modelLabel, 'mock/demo');
    assert.equal(index.sessions[1]?.displayName, 'Named session');
  } finally {
    if (previous === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previous;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test('readRecentSessionsIndex filters a shared custom session directory by workspace cwd', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-rpc-recent-shared-'));
  const workspaceA = join(root, 'workspace-a');
  const workspaceB = join(root, 'workspace-b');
  const sharedDir = join(root, 'shared-sessions');
  await mkdir(workspaceA, { recursive: true });
  await mkdir(workspaceB, { recursive: true });
  await mkdir(sharedDir, { recursive: true });

  try {
    await writeSession(
      join(sharedDir, 'a.jsonl'),
      { type: 'session', id: 'a', timestamp: '2024-01-01T00:00:00.000Z', cwd: workspaceA },
      [
        {
          type: 'message',
          timestamp: '2024-01-01T00:20:00.000Z',
          message: { role: 'user', content: 'workspace alpha prompt' },
        },
      ]
    );
    await writeSession(
      join(sharedDir, 'b.jsonl'),
      { type: 'session', id: 'b', timestamp: '2024-01-01T00:00:00.000Z', cwd: workspaceB },
      [
        {
          type: 'message',
          timestamp: '2024-01-01T00:20:00.000Z',
          message: { role: 'user', content: 'workspace beta prompt' },
        },
      ]
    );

    const index = await readRecentSessionsIndex({
      workspaceName: 'workspace-a',
      workspacePath: workspaceA,
      additionalArgs: ['--session-dir', sharedDir],
    });

    assert.equal(index.filterByWorkspaceCwd, true);
    assert.deepEqual(
      index.sessions.map((session) => session.id),
      ['a']
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('readRecentSessionsIndex falls back to filesystem mtimes, rejects skewed timestamps, and keeps unknown dates last', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-rpc-recent-fallback-'));
  const workspace = join(root, 'workspace');
  const agentDir = join(root, 'agent');
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  await mkdir(workspace, { recursive: true });
  await mkdir(agentDir, { recursive: true });

  const validTime = new Date('2024-01-04T01:00:00.000Z');
  const badHeaderMtime = new Date('2024-01-03T00:00:00.000Z');
  const futureHeaderMtime = new Date('2024-01-02T18:00:00.000Z');
  const invalidEntryMtime = new Date('2024-01-02T12:00:00.000Z');
  const invalidFutureTime = new Date(Date.now() + 365 * 24 * 60 * 60_000);

  try {
    const sessionDir = getDefaultSessionDirForWorkspace(workspace, agentDir);
    await mkdir(sessionDir, { recursive: true });

    await writeSession(
      join(sessionDir, 'valid.jsonl'),
      {
        type: 'session',
        id: 'valid',
        timestamp: '2024-01-04T00:00:00.000Z',
        cwd: workspace,
      },
      [
        {
          type: 'message',
          timestamp: '2024-01-04T01:00:00.000Z',
          message: { role: 'user', content: 'still valid' },
        },
      ]
    );
    await writeSession(
      join(sessionDir, 'bad-header.jsonl'),
      {
        type: 'session',
        id: 'bad-header',
        timestamp: 'not-a-time',
        cwd: workspace,
      },
      [{ type: 'session_info', name: 'Broken ts' }]
    );
    await writeSession(
      join(sessionDir, 'future-header.jsonl'),
      {
        type: 'session',
        id: 'future-header',
        timestamp: invalidFutureTime.toISOString(),
        cwd: workspace,
      },
      []
    );
    await writeSession(
      join(sessionDir, 'invalid-entry.jsonl'),
      {
        type: 'session',
        id: 'invalid-entry',
        timestamp: '2024-01-02T00:00:00.000Z',
        cwd: workspace,
      },
      [
        {
          type: 'message',
          timestamp: 'also-not-a-time',
          message: { role: 'user', timestamp: 9_999_999_999_999, content: 'bad activity ts' },
        },
      ]
    );
    await writeSession(
      join(sessionDir, 'unknown-a.jsonl'),
      {
        type: 'session',
        id: 'unknown-a',
        timestamp: 'not-a-time',
        cwd: workspace,
      },
      [
        {
          type: 'message',
          timestamp: 'still-not-a-time',
          message: { role: 'user', timestamp: -1, content: 'unknown' },
        },
      ]
    );
    await writeSession(
      join(sessionDir, 'unknown-b.jsonl'),
      {
        type: 'session',
        id: 'unknown-b',
        timestamp: 'not-a-time',
        cwd: workspace,
      },
      []
    );

    await utimes(join(sessionDir, 'valid.jsonl'), validTime, validTime);
    await utimes(join(sessionDir, 'bad-header.jsonl'), badHeaderMtime, badHeaderMtime);
    await utimes(join(sessionDir, 'future-header.jsonl'), futureHeaderMtime, futureHeaderMtime);
    await utimes(join(sessionDir, 'invalid-entry.jsonl'), invalidEntryMtime, invalidEntryMtime);
    await utimes(join(sessionDir, 'unknown-a.jsonl'), invalidFutureTime, invalidFutureTime);
    await utimes(join(sessionDir, 'unknown-b.jsonl'), invalidFutureTime, invalidFutureTime);

    const index = await readRecentSessionsIndex({
      workspaceName: 'workspace',
      workspacePath: workspace,
    });
    const byId = new Map(index.sessions.map((session) => [session.id, session]));

    assert.deepEqual(
      index.sessions.map((session) => session.id),
      ['valid', 'bad-header', 'future-header', 'invalid-entry', 'unknown-a', 'unknown-b']
    );
    assert.equal(byId.get('bad-header')?.createdAt, badHeaderMtime.getTime());
    assert.equal(byId.get('bad-header')?.modifiedAt, badHeaderMtime.getTime());
    assert.equal(byId.get('future-header')?.createdAt, futureHeaderMtime.getTime());
    assert.equal(byId.get('future-header')?.modifiedAt, futureHeaderMtime.getTime());
    assert.equal(byId.get('invalid-entry')?.createdAt, Date.UTC(2024, 0, 2, 0, 0, 0));
    assert.equal(byId.get('invalid-entry')?.modifiedAt, invalidEntryMtime.getTime());
    assert.equal(byId.get('unknown-a')?.createdAt, 0);
    assert.equal(byId.get('unknown-a')?.modifiedAt, 0);
    assert.equal(byId.get('unknown-b')?.createdAt, 0);
    assert.equal(byId.get('unknown-b')?.modifiedAt, 0);
  } finally {
    if (previous === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previous;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test('filterRecentSessions matches name, model, workspace, and first prompt text', () => {
  const sessions = [
    {
      id: 'a',
      path: '/tmp/a.jsonl',
      cwd: '/tmp/workspace-a',
      workspaceLabel: 'workspace-a',
      displayName: 'Build bugfix',
      firstPromptPreview: 'find the regression',
      messageCount: 2,
      modifiedAt: 2,
      createdAt: 1,
      modelLabel: 'mock/one',
    },
    {
      id: 'b',
      path: '/tmp/b.jsonl',
      cwd: '/tmp/workspace-b',
      workspaceLabel: 'workspace-b',
      displayName: 'Refactor flow',
      firstPromptPreview: 'rename the session tree',
      messageCount: 2,
      modifiedAt: 4,
      createdAt: 3,
      modelLabel: 'mock/two',
    },
  ];

  assert.deepEqual(
    filterRecentSessions(sessions, 'bug').map((session) => session.id),
    ['a']
  );
  assert.deepEqual(
    filterRecentSessions(sessions, 'workspace-b').map((session) => session.id),
    ['b']
  );
  assert.deepEqual(
    filterRecentSessions(sessions, 'mock/two').map((session) => session.id),
    ['b']
  );
  assert.deepEqual(
    filterRecentSessions(sessions, 'rename').map((session) => session.id),
    ['b']
  );
});

test('formatRelativeTimestamp renders compact relative labels and hides invalid values', () => {
  const now = Date.UTC(2024, 0, 2, 12, 0, 0);
  assert.equal(formatRelativeTimestamp(now - 30_000, now), 'just now');
  assert.equal(formatRelativeTimestamp(now - 5 * 60_000, now), '5m ago');
  assert.equal(formatRelativeTimestamp(now - 3 * 60 * 60_000, now), '3h ago');
  assert.equal(formatRelativeTimestamp(now - 2 * 24 * 60 * 60_000, now), '2d ago');
  assert.equal(formatRelativeTimestamp(0, now), 'Unknown');
  assert.equal(formatRelativeTimestamp(Number.NaN, now), 'Unknown');
  assert.equal(formatRelativeTimestamp(now - 60_000, Number.NaN), 'Unknown');
});

test('a chat started in the terminal (session header + name, no messages) is still listed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-rpc-term-'));
  const workspace = join(root, 'workspace');
  const agentDir = join(root, 'agent');
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  await mkdir(workspace, { recursive: true });
  try {
    const sessionDir = getDefaultSessionDirForWorkspace(workspace, agentDir);
    await mkdir(sessionDir, { recursive: true });
    // Mimic a session Pi created from the terminal: header + a session_info name.
    await writeSession(
      join(sessionDir, '2026-07-19T03-06-22-397Z_019f7856.jsonl'),
      { type: 'session', id: 'term1234', timestamp: '2026-07-19T03:06:22.000Z', cwd: workspace },
      [{ type: 'session_info', name: 'Shell chat' }]
    );
    const index = await readRecentSessionsIndex({
      workspaceName: 'workspace',
      workspacePath: workspace,
      additionalArgs: [],
    });
    assert.equal(index.sessions.length, 1);
    assert.equal(index.sessions[0]?.displayName, 'Shell chat');
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

import { normalizeWorkspaceCwd, sameWorkspaceCwd } from '../../src/sessions/recentSessions';

test('sameWorkspaceCwd tolerates trailing slashes and non-normalized paths', () => {
  const base = tmpdir();
  assert.equal(sameWorkspaceCwd(base + '/', base), true);
  assert.equal(sameWorkspaceCwd(base + '/sub/..', base), true);
  assert.equal(normalizeWorkspaceCwd(base + '///'), normalizeWorkspaceCwd(base));
});

test('sameWorkspaceCwd is lenient for sessions with no recorded cwd', () => {
  assert.equal(sameWorkspaceCwd(undefined, '/any/where'), true);
  assert.equal(sameWorkspaceCwd('', '/any/where'), true);
  assert.equal(sameWorkspaceCwd('   ', '/any/where'), true);
});

test('sameWorkspaceCwd rejects genuinely different directories', () => {
  assert.equal(sameWorkspaceCwd('/Users/x/other', '/Users/x/proj'), false);
});
