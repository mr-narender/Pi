import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSidebarState } from '../../src/ui/sidebar/state';

test('buildSidebarState maps recent sessions and marks the active one', () => {
  const now = Date.now();
  const state = buildSidebarState(
    {
      loading: false,
      items: [
        { path: '/tmp/a.jsonl', displayName: 'Session 2', modifiedAt: now, modelLabel: 'sonnet' },
        {
          path: '/tmp/b.jsonl',
          displayName: 'Session 1',
          modifiedAt: now - 60000,
          modelLabel: 'sonnet',
        },
      ],
    },
    '/tmp/a.jsonl',
    now
  );
  assert.equal(state.sessions.length, 2);
  assert.equal(state.sessions[0]?.name, 'Session 2');
  assert.equal(state.sessions[0]?.active, true);
  assert.equal(state.sessions[1]?.active, false);
  assert.match(state.sessions[0]?.meta, /sonnet/);
});

test('buildSidebarState handles the empty case', () => {
  const state = buildSidebarState({ loading: false, items: [] }, undefined);
  assert.equal(state.sessions.length, 0);
  assert.equal(state.loading, false);
});

test('buildSidebarState pins float to the top and expose pinned flag (#7)', () => {
  const now = Date.now();
  const state = buildSidebarState(
    {
      loading: false,
      items: [
        { path: '/tmp/a.jsonl', displayName: 'Newest', modifiedAt: now },
        { path: '/tmp/b.jsonl', displayName: 'Older', modifiedAt: now - 60000 },
        { path: '/tmp/c.jsonl', displayName: 'Oldest', modifiedAt: now - 120000 },
      ],
    },
    undefined,
    now,
    new Set(['/tmp/c.jsonl'])
  );
  assert.equal(state.sessions[0]?.name, 'Oldest'); // pinned floats up
  assert.equal(state.sessions[0]?.pinned, true);
  assert.equal(state.sessions[1]?.name, 'Newest'); // recency preserved within group
  assert.equal(state.sessions[2]?.pinned, false);
});
