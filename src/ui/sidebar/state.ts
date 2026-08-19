import { formatRelativeTimestamp } from '../../sessions/recentSessions';

export interface SidebarSessionItem {
  path: string;
  name: string;
  meta: string;
  active: boolean;
  pinned: boolean;
  /** Chat from ANOTHER project (different cwd); opens with its own cwd. */
  other?: boolean;
  cwd?: string;
  project?: string;
  /** Live state badge: generating (busy) or blocked on an approval (waiting). */
  status?: 'busy' | 'waiting';
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
    others?: Array<{
      path: string;
      displayName: string;
      modifiedAt: number;
      modelLabel?: string;
      cwd: string;
      workspaceLabel: string;
    }>;
  },
  activePath: string | undefined,
  now = Date.now(),
  pinnedPaths: ReadonlySet<string> = new Set()
): SidebarState {
  const items: SidebarSessionItem[] = (recent.items ?? []).slice(0, 300).map((item) => ({
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
  // "Other projects": every chat from every other cwd, so ALL chats are
  // reachable from any window. Rendered after the current workspace's chats.
  for (const item of recent.others ?? []) {
    sessions.push({
      path: item.path,
      name: item.displayName,
      meta: [item.workspaceLabel, formatRelativeTimestamp(item.modifiedAt, now), item.modelLabel]
        .filter(Boolean)
        .join(' \u00b7 '),
      active: item.path === activePath,
      pinned: pinnedPaths.has(item.path),
      other: true,
      cwd: item.cwd,
      project: item.workspaceLabel,
    });
  }
  return {
    loading: recent.loading,
    error: recent.error,
    sessions,
  };
}
