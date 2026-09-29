import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FOLLOW_BURST_ABSORB_THRESHOLD,
  type FollowMessageLike,
  type FollowTabState,
  planFollowDelta,
  planTabEviction,
} from '../../src/live/followPlan';

function editBlock(
  callId: string,
  path: string,
  extra = ''
): FollowMessageLike['blocks'] extends Array<infer B> | undefined ? B : never {
  return {
    kind: 'tool',
    callId,
    name: 'edit',
    args: JSON.stringify({ path, newString: `changed text for ${path} ${extra}` }),
  };
}

function readBlock(callId: string, path: string): ReturnType<typeof editBlock> {
  return { kind: 'tool', callId, name: 'read', args: JSON.stringify({ path }) };
}

function bashBlock(callId: string): ReturnType<typeof editBlock> {
  return { kind: 'tool', callId, name: 'bash', args: JSON.stringify({ command: 'ls' }) };
}

function messagesOf(...blocks: Array<ReturnType<typeof editBlock>>): FollowMessageLike[] {
  return [{ blocks }];
}

// --- planFollowDelta: history vs live ---------------------------------------

test('follow-plan: first snapshot seeds history without acting, regardless of size or timing', () => {
  const seen = new Map<string, number>();
  const messages: FollowMessageLike[] = [
    { blocks: [editBlock('c1', '/w/a.ts'), readBlock('c2', '/w/b.ts')] },
    { blocks: [editBlock('c3', '/w/c.ts')] },
  ];
  const plan = planFollowDelta(messages, seen, 0, true, false);
  assert.equal(plan.act.length, 0, 'history must never be acted on');
  assert.equal(plan.absorbed, 3);
  assert.equal(plan.hwm, 2);
  assert.equal(seen.size, 3, 'all history callIds marked seen');
});

test('follow-plan: big transcript landing AFTER the first snapshot (slow hydration) is absorbed, not followed', () => {
  const seen = new Map<string, number>();
  // First snapshot: empty (chat switch/reload delivers empty, then full transcript).
  const first = planFollowDelta([], seen, 0, false, false);
  assert.equal(first.act.length, 0);
  // Full transcript lands much later (no wall-clock involved) while NOT busy.
  const transcript: FollowMessageLike[] = Array.from({ length: 50 }, (_, index) => ({
    blocks: [editBlock(`h${index}`, `/w/file${index}.ts`)],
  }));
  const plan = planFollowDelta(transcript, seen, first.hwm, false, true);
  assert.equal(plan.act.length, 0, 'late history backfill must not open editors');
  assert.equal(plan.absorbed, 50);
  assert.equal(plan.hwm, 50);
});

test('follow-plan: while busy, a hydration burst larger than the threshold is absorbed as history', () => {
  const seen = new Map<string, number>();
  const seedPlan = planFollowDelta([], seen, 0, true, false);
  const burst: FollowMessageLike[] = Array.from(
    { length: FOLLOW_BURST_ABSORB_THRESHOLD + 5 },
    (_, index) => ({ blocks: [editBlock(`b${index}`, `/w/burst${index}.ts`)] })
  );
  const plan = planFollowDelta(burst, seen, seedPlan.hwm, true, true);
  assert.equal(plan.act.length, 0, 'burst = backfill, not live typing');
  assert.equal(plan.absorbed, FOLLOW_BURST_ABSORB_THRESHOLD + 5);
});

test('follow-plan: live single edit while busy acts; non-file tools never act', () => {
  const seen = new Map<string, number>();
  const history = messagesOf(editBlock('old', '/w/old.ts'));
  const seedPlan = planFollowDelta(history, seen, 0, true, false);
  const next: FollowMessageLike[] = [
    ...history,
    { blocks: [bashBlock('sh1'), editBlock('new1', '/w/live.ts')] },
  ];
  const plan = planFollowDelta(next, seen, seedPlan.hwm, true, true);
  assert.equal(plan.act.length, 1);
  assert.equal(plan.act[0]!.callId, 'new1');
  assert.equal(plan.act[0]!.activity.kind, 'editing');
  assert.equal(plan.act[0]!.activity.path, '/w/live.ts');
  assert.equal(plan.absorbed, 0);
});

test('follow-plan: new calls arriving while NOT busy are absorbed (render replays, chat switches)', () => {
  const seen = new Map<string, number>();
  const seedPlan = planFollowDelta([], seen, 0, false, false);
  const next = messagesOf(editBlock('idle1', '/w/idle.ts'));
  const plan = planFollowDelta(next, seen, seedPlan.hwm, false, true);
  assert.equal(plan.act.length, 0);
  assert.equal(plan.absorbed, 1);
});

test('follow-plan: transcript shrink (branch switch / fork / edit-resend) reseeds instead of acting', () => {
  const seen = new Map<string, number>();
  const long: FollowMessageLike[] = Array.from({ length: 10 }, (_, index) => ({
    blocks: [editBlock(`m${index}`, `/w/m${index}.ts`)],
  }));
  const seedPlan = planFollowDelta(long, seen, 0, true, false);
  const shrunk: FollowMessageLike[] = [
    { blocks: [editBlock('other1', '/w/other.ts')] },
    { blocks: [editBlock('other2', '/w/other2.ts')] },
  ];
  const plan = planFollowDelta(shrunk, seen, seedPlan.hwm, true, true);
  assert.equal(plan.reset, true);
  assert.equal(plan.act.length, 0, 'a replaced transcript is history, not live edits');
  assert.equal(plan.hwm, 2);
  assert.equal(seen.size, 2, 'seen reseeded to the new transcript only');
});

test('follow-plan: only the tail is rescanned — earlier messages are never re-iterated', () => {
  const seen = new Map<string, number>();
  const poisoned: FollowMessageLike[] = [
    {
      get blocks(): FollowBlockLikeArray {
        throw new Error('scanned below the high-water mark');
      },
    } as unknown as FollowMessageLike,
    { blocks: [editBlock('tail0', '/w/tail0.ts')] },
  ];
  type FollowBlockLikeArray = Array<ReturnType<typeof editBlock>>;
  // hwm=2 → scan starts at index 1; the poisoned message 0 must not be touched.
  const seenPre = new Map([['tail0', 10]]);
  const plan = planFollowDelta(poisoned, seenPre, 2, true, true);
  assert.equal(plan.act.length, 0);
  void seen;
});

test('follow-plan: streaming arg growth on an already-seen edit reports grown, not act', () => {
  const seen = new Map<string, number>();
  const v1 = messagesOf(editBlock('e1', '/w/grow.ts'));
  const seedPlan = planFollowDelta(v1, seen, 0, true, false);
  const v2 = messagesOf(editBlock('e1', '/w/grow.ts', 'plus more streamed content'));
  const plan = planFollowDelta(v2, seen, seedPlan.hwm, true, true);
  assert.equal(plan.act.length, 0);
  assert.equal(plan.grown.length, 1);
  assert.equal(plan.grown[0]!.callId, 'e1');
});

// --- planTabEviction ---------------------------------------------------------

const openTab: FollowTabState = { exists: true };

test('follow-plan eviction: under the cap nothing closes', () => {
  const tracked = [
    { path: '/w/a.ts', openedAt: 1 },
    { path: '/w/b.ts', openedAt: 2 },
  ];
  const plan = planTabEviction(tracked, 10, () => openTab);
  assert.deepEqual(plan.close, []);
  assert.deepEqual(plan.untrack, []);
});

test('follow-plan eviction: over the cap closes oldest follow-opened tabs first', () => {
  const tracked = Array.from({ length: 12 }, (_, index) => ({
    path: `/w/f${index}.ts`,
    openedAt: index,
  }));
  const plan = planTabEviction(tracked, 10, () => openTab);
  assert.deepEqual(plan.close, ['/w/f0.ts', '/w/f1.ts']);
});

test('follow-plan eviction: pinned, dirty, and active tabs are never closed — ownership moves to the user', () => {
  const tracked = [
    { path: '/w/pinned.ts', openedAt: 1 },
    { path: '/w/dirty.ts', openedAt: 2 },
    { path: '/w/active.ts', openedAt: 3 },
    { path: '/w/plain.ts', openedAt: 4 },
    { path: '/w/newest.ts', openedAt: 5 },
  ];
  const states: Record<string, FollowTabState> = {
    '/w/pinned.ts': { exists: true, pinned: true },
    '/w/dirty.ts': { exists: true, dirty: true },
    '/w/active.ts': { exists: true, active: true },
    '/w/plain.ts': { exists: true },
    '/w/newest.ts': { exists: true },
  };
  const plan = planTabEviction(tracked, 1, (path) => states[path]!);
  assert.deepEqual(plan.close, ['/w/plain.ts'], 'only the unprotected non-newest tab closes');
  assert.deepEqual(
    plan.untrack.sort(),
    ['/w/active.ts', '/w/dirty.ts', '/w/pinned.ts', '/w/plain.ts'].sort(),
    'protected tabs leave the managed list; closed tabs are untracked too'
  );
});

test('follow-plan eviction: tabs the user already closed are untracked without close calls', () => {
  const tracked = [
    { path: '/w/gone.ts', openedAt: 1 },
    { path: '/w/here.ts', openedAt: 2 },
  ];
  const plan = planTabEviction(tracked, 1, (path) =>
    path === '/w/gone.ts' ? { exists: false } : openTab
  );
  assert.deepEqual(plan.close, []);
  assert.deepEqual(plan.untrack, ['/w/gone.ts']);
});

test('follow-plan eviction: cap is clamped to at least 1', () => {
  const tracked = [
    { path: '/w/a.ts', openedAt: 1 },
    { path: '/w/b.ts', openedAt: 2 },
  ];
  const plan = planTabEviction(tracked, 0, () => openTab);
  assert.deepEqual(plan.close, ['/w/a.ts'], 'newest tab always survives');
});
