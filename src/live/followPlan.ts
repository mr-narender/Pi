// Pure planning logic for the follow-agent service — vscode-free so unit tests
// can exercise the freeze/storm/eviction rules directly. AgentFollowService
// adapts these plans onto real editors/tabs.
import { type ToolActivity, toolActivity } from './toolActivity';

export interface FollowBlockLike {
  kind: string;
  callId?: string;
  name?: string;
  args?: string;
}

export interface FollowMessageLike {
  blocks?: FollowBlockLike[];
}

export interface FollowActCandidate {
  callId: string;
  name?: string;
  args?: string;
  activity: ToolActivity;
}

export interface FollowDeltaPlan {
  /** File-touching tool calls to act on (status bar / side pane), oldest-first. */
  act: FollowActCandidate[];
  /** Already-acted edit calls whose args grew (streaming edit still writing). */
  grown: FollowActCandidate[];
  /** File-touching calls treated as history this tick (never acted on). */
  absorbed: number;
  /** Transcript shrank/was replaced — seen set was reseeded from scratch. */
  reset: boolean;
  /** Next message high-water mark to store for this chat. */
  hwm: number;
}

/** More unseen file-touching calls than this in ONE tick = history backfill. */
export const FOLLOW_BURST_ABSORB_THRESHOLD = 3;

/**
 * Decide what the follow pane should do for one snapshot tick.
 *
 * Structural history detection — no wall clocks. A tool call is only "live"
 * when (a) this chat was already seeded, (b) the transcript did not shrink,
 * (c) the snapshot arrived while the chat is busy, and (d) it appeared in a
 * small enough burst to be human-scale streaming rather than backfill.
 * Everything else is history: marked seen, never acted on. The scan is
 * incremental — only messages at/after the high-water mark are visited, so
 * huge resumed transcripts cost O(delta) per tick, not O(transcript).
 *
 * `seen` is this chat's working set (callId → last args length) and is
 * mutated in place — copying it per tick is exactly the kind of work this
 * module exists to avoid.
 */
export function planFollowDelta(
  messages: FollowMessageLike[],
  seen: Map<string, number>,
  hwm: number,
  busy: boolean,
  seeded: boolean
): FollowDeltaPlan {
  const reset = seeded && messages.length < hwm;
  const seedAll = !seeded || reset;
  if (reset) {
    seen.clear();
  }
  const scanFrom = seedAll ? 0 : Math.max(0, hwm - 1);

  const candidates: FollowActCandidate[] = [];
  const grown: FollowActCandidate[] = [];
  let absorbed = 0;

  for (let index = scanFrom; index < messages.length; index += 1) {
    for (const block of messages[index]?.blocks ?? []) {
      if (block.kind !== 'tool' || !block.callId) {
        continue;
      }
      const argsLen = (block.args ?? '').length;
      const prior = seen.get(block.callId);
      if (prior === undefined) {
        seen.set(block.callId, argsLen);
        const activity = toolActivity(block.name, block.args);
        if (!activity) {
          continue;
        }
        if (seedAll || !busy) {
          absorbed += 1;
        } else {
          candidates.push({ callId: block.callId, name: block.name, args: block.args, activity });
        }
      } else if (argsLen > prior) {
        seen.set(block.callId, argsLen);
        const activity = toolActivity(block.name, block.args);
        if (activity?.kind === 'editing') {
          grown.push({ callId: block.callId, name: block.name, args: block.args, activity });
        }
      }
    }
  }

  if (candidates.length > FOLLOW_BURST_ABSORB_THRESHOLD) {
    return { act: [], grown, absorbed: absorbed + candidates.length, reset, hwm: messages.length };
  }
  return { act: candidates, grown, absorbed, reset, hwm: messages.length };
}

export interface FollowTabState {
  exists: boolean;
  pinned?: boolean;
  dirty?: boolean;
  active?: boolean;
}

export interface TrackedFollowTab {
  path: string;
  openedAt: number;
}

export interface TabEvictionPlan {
  /** Paths whose editor tabs should be closed (oldest follow-opened first). */
  close: string[];
  /** Paths to stop tracking (closed by user, or user now owns them). */
  untrack: string[];
}

/**
 * Keep the follow pane's managed tab list bounded. Only tabs the follow pane
 * itself opened are candidates; pinned/dirty/active tabs (and tabs the user
 * closed) leave the managed list without being touched — the user owns them
 * now. The newest tab always survives (cap clamps to ≥1).
 */
export function planTabEviction(
  tracked: TrackedFollowTab[],
  cap: number,
  stateOf: (path: string) => FollowTabState
): TabEvictionPlan {
  const boundedCap = Math.max(1, Math.floor(cap));
  const close: string[] = [];
  const untrack: string[] = [];

  const live: TrackedFollowTab[] = [];
  for (const entry of tracked) {
    if (stateOf(entry.path).exists) {
      live.push(entry);
    } else {
      untrack.push(entry.path);
    }
  }
  live.sort((a, b) => a.openedAt - b.openedAt);

  let managed = live.length;
  for (const entry of live) {
    if (managed <= boundedCap) {
      break;
    }
    const state = stateOf(entry.path);
    if (!(state.pinned || state.dirty || state.active)) {
      close.push(entry.path);
    }
    untrack.push(entry.path);
    managed -= 1;
  }
  return { close, untrack };
}
