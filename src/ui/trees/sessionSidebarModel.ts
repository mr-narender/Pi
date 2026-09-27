import { formatRelativeTimestamp, type RecentSessionRecord } from '../../sessions/recentSessions';
import type { RecentSessionsState } from '../../sessions/recentSessionService';

export interface SidebarNodeCommand {
  command: string;
  title: string;
  arguments?: unknown[];
}

export interface SidebarNode {
  id: string;
  kind: 'action' | 'summary' | 'session' | 'info';
  label: string;
  description?: string;
  detail?: string;
  tooltip?: string;
  icon?: string;
  contextValue?: string;
  command?: SidebarNodeCommand;
  accessibilityLabel?: string;
  sessionPath?: string;
  sessionLabel?: string;
}

function sessionDisplayName(session: RecentSessionRecord): string {
  return (
    session.displayName || session.sessionName || session.firstPromptPreview || 'Untitled chat'
  );
}

// --- Agentic Mode: ONE consolidated "Open Chat List" ---
// Replaces the earlier attempt (SessionsTreeProvider + ResumeChatTreeProvider
// as two separate stacked views) that shipped with a real, reported bug:
// both drew from the SAME `recent.items` array with different slice limits,
// so "Open" and "Recent" showed near-duplicate content — there was never an
// actual distinct "currently open" data source behind it. This version uses
// the real one (ChatTabManager.listOpenChats()) and dedupes Recent against
// it by session file path, so nothing appears twice.
export interface OpenChatEntry {
  /** Resource URI as a string \u2014 stable identity for the reveal command. */
  resource: string;
  title: string;
  sessionFile?: string;
  /** The tab currently visible/focused, for the check-vs-bubble icon. */
  active: boolean;
}

export interface OpenChatListInput {
  openChats: OpenChatEntry[];
  recent: RecentSessionsState;
  now?: number;
}

export function createOpenChatListModel(input: OpenChatListInput): SidebarNode[] {
  const now = input.now ?? Date.now();
  const nodes: SidebarNode[] = [
    {
      id: 'list.new',
      kind: 'action',
      label: 'New Chat',
      icon: 'add',
      command: { command: 'piRpc.newSession', title: 'New Chat' },
      accessibilityLabel: 'Start a new Pi chat',
    },
  ];

  if (input.openChats.length > 0) {
    nodes.push({ id: 'list.open.header', kind: 'summary', label: 'Open' });
    for (const chat of input.openChats) {
      nodes.push({
        id: `list.open.${chat.resource}`,
        kind: 'session',
        label: chat.title,
        description: chat.active ? 'Current' : undefined,
        icon: chat.active ? 'check' : 'comment-discussion',
        contextValue: 'piRpc.openChat',
        command: {
          command: 'piRpcInternal.revealOpenChat',
          title: 'Open Chat',
          arguments: [{ resource: chat.resource }],
        },
        accessibilityLabel: `${chat.title}${chat.active ? '. Current' : ''}`,
      });
    }
  }

  const openSessionFiles = new Set(
    input.openChats.map((chat) => chat.sessionFile).filter((path): path is string => Boolean(path))
  );

  if (input.recent.loading) {
    nodes.push({ id: 'list.recent.loading', kind: 'info', label: 'Loading chats', icon: 'loading~spin' });
    return nodes;
  }
  if (input.recent.error) {
    nodes.push({ id: 'list.recent.error', kind: 'info', label: "Couldn't read chats", description: input.recent.error, icon: 'warning' });
    nodes.push({
      id: 'list.recent.retry',
      kind: 'action',
      label: 'Try again',
      icon: 'refresh',
      command: { command: 'piRpcInternal.refreshRecentSessions', title: 'Try again' },
    });
    return nodes;
  }

  const recentOnly = input.recent.items.filter((session) => !openSessionFiles.has(session.path));
  if (recentOnly.length > 0) {
    nodes.push({ id: 'list.recent.header', kind: 'summary', label: 'Recent' });
    // Capped smaller than the old dormant code's 30 — a real user's actual
    // session history (Claude imports, old experiments) made the list feel
    // dense/overwhelming rather than scannable. Full history stays one
    // click away via piRpc.quickSwitchChat's search-everything QuickPick.
    for (const session of recentOnly.slice(0, 12)) {
      const label = sessionDisplayName(session);
      const description = [
        session.workspaceLabel,
        formatRelativeTimestamp(session.modifiedAt, now),
        session.modelLabel,
      ]
        .filter(Boolean)
        .join(' · ');
      nodes.push({
        id: `list.recent.${session.id}`,
        kind: 'session',
        label,
        description,
        detail:
          session.firstPromptPreview && session.firstPromptPreview !== label
            ? session.firstPromptPreview
            : undefined,
        tooltip: `${label}\n${description}\n${session.path}`,
        icon: 'history',
        contextValue: 'piRpc.recentSession',
        command: {
          command: 'piRpc.switchSession',
          title: 'Resume Chat',
          arguments: [{ sessionPath: session.path, label }],
        },
        sessionPath: session.path,
        sessionLabel: label,
        accessibilityLabel: `${label}. ${description}`,
      });
    }
  }

  if (input.openChats.length === 0 && recentOnly.length === 0) {
    nodes.push({ id: 'list.empty', kind: 'info', label: 'No chats yet', description: 'Start a new chat and it will appear here.', icon: 'comment' });
  }

  return nodes;
}

