import { formatRelativeTimestamp } from '../../sessions/recentSessions';

export interface SidebarSessionItem {
  path: string;
  name: string;
  meta: string;
  active: boolean;
  pinned: boolean;
}

export interface SidebarState {
  loading: boolean;
  error?: string;
  sessions: SidebarSessionItem[];
}

/**
 * Pure state builder (unit-testable, no vscode dependency) that turns the
 * recent-session service output plus the active session path into the sidebar
 * view model.
 */
export function buildSidebarState(
  recent: {
    loading: boolean;
    error?: string;
    items: Array<{ path: string; displayName: string; modifiedAt: number; modelLabel?: string }>;
  },
  activePath: string | undefined,
  now = Date.now(),
  pinnedPaths: ReadonlySet<string> = new Set()
): SidebarState {
  const items = (recent.items ?? []).slice(0, 100).map((item) => ({
    path: item.path,
    name: item.displayName,
    meta: [formatRelativeTimestamp(item.modifiedAt, now), item.modelLabel]
      .filter(Boolean)
      .join(' \u00b7 '),
    active: item.path === activePath,
    pinned: pinnedPaths.has(item.path),
  }));
  // Stable sort keeps recency order within each group; pinned items float up.
  const sessions = [...items].sort((a, b) => Number(b.pinned) - Number(a.pinned));
  return {
    loading: recent.loading,
    error: recent.error,
    sessions,
  };
}
