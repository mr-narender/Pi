import { createHash } from 'node:crypto';
import { canonicalChatTarget, chatTargetSessionKey, type ChatTabTarget } from './uriContract';

/**
 * Short-id URI scheme for chat tabs.
 *
 * The chat editor URI must be BOTH:
 *   - short/clean (it drives the editor breadcrumb), and
 *   - restore-safe (VS Code re-resolves custom editors via the URI alone, and
 *     does not reliably preserve a URI's query on restore).
 *
 * We satisfy both by putting a short, deterministic id in the PATH and keeping
 * a `path -> identity` map persisted in workspace state. The id is a stable
 * hash of the target identity, so the URI is deterministic (safe for tab
 * keying) and the breadcrumb stays clean. On restore, the map is rehydrated
 * and `lookupChatUri` recovers the full identity from the path.
 */

const STORE_KEY = 'piRpc.chatUriMap';
const MAX_ENTRIES = 500;

interface Memento {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): Thenable<void>;
}

let store = new Map<string, ChatTabTarget>();
let memento: Memento | undefined;

/** Deterministic short id (10 hex chars) for a target's identity. */
export function chatShortId(target: ChatTabTarget): string {
  const key = chatTargetSessionKey(canonicalChatTarget(target));
  return createHash('sha256').update(key).digest('hex').slice(0, 10);
}

function labelFor(target: ChatTabTarget): string {
  return canonicalChatTarget(target).kind === 'workspaceDraft' ? 'New Chat' : 'Chat';
}

/**
 * Short, human-friendly, deterministic, UNIQUE URI path for a target, e.g.
 * `/Chat 3f9a2c8b1d.chat`. Uniqueness comes from the identity hash; the label
 * is purely cosmetic (for the breadcrumb).
 */
export function chatPathFor(target: ChatTabTarget): string {
  return `/${labelFor(target)} ${chatShortId(target)}.chat`;
}

/** Load the persisted path -> identity map (call once on activation). */
export function initChatUriRegistry(store_: Memento): void {
  memento = store_;
  const saved = store_.get<Record<string, ChatTabTarget>>(STORE_KEY, {});
  store = new Map(
    Object.entries(saved).map(([path, target]) => [path, canonicalChatTarget(target)])
  );
}

/** Remember (and persist) the identity behind a chat URI path. */
export function rememberChatUri(path: string, target: ChatTabTarget): void {
  const canonical = canonicalChatTarget(target);
  // Re-insert at the end so eviction is roughly least-recently-used.
  store.delete(path);
  store.set(path, canonical);
  while (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    store.delete(oldest);
  }
  void memento?.update(STORE_KEY, Object.fromEntries(store));
}

/** Recover the identity behind a chat URI path, if known. */
export function lookupChatUri(path: string): ChatTabTarget | undefined {
  return store.get(path);
}

/** Test-only: reset in-memory registry state. */
export function __resetChatUriRegistry(): void {
  store = new Map();
  memento = undefined;
}
