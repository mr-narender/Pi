import type { ControllerState } from '../../state/types';
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
}

export interface SidebarViewInput {
  activeFolderName?: string;
  activeState?: Pick<ControllerState, 'connectionState' | 'workspaceFolderName' | 'state'>;
  recent: RecentSessionsState;
  hasDraft: boolean;
  hasPendingAttachments: boolean;
  showWorkspacePicker?: boolean;
  now?: number;
}

function sessionDisplayName(session: RecentSessionRecord): string {
  return (
    session.displayName || session.sessionName || session.firstPromptPreview || 'Untitled chat'
  );
}

export function createNewChatSidebarModel(input: SidebarViewInput): SidebarNode[] {
  const nodes: SidebarNode[] = [
    {
      id: 'new.info',
      kind: 'info',
      label: 'Start fresh with Pi in this workspace',
      description: input.activeFolderName
        ? `Workspace: ${input.activeFolderName}`
        : 'Choose a workspace to begin.',
      icon: 'add',
    },
    {
      id: 'new.action',
      kind: 'action',
      label: 'New Chat',
      description: 'Start fresh or continue from the current chat as parent.',
      icon: 'add',
      command: { command: 'piRpc.newSession', title: 'New Chat' },
      accessibilityLabel: 'Start a new Pi chat',
    },
  ];

  if (input.hasDraft || input.hasPendingAttachments) {
    nodes.push({
      id: 'new.warning',
      kind: 'info',
      label: 'Unsent draft and attachments stay in the active chat tab.',
      description: "They won't be sent or copied.",
      icon: 'warning',
    });
  }

  return nodes;
}

export function createResumeChatSidebarModel(input: SidebarViewInput): SidebarNode[] {
  const now = input.now ?? Date.now();
  const currentSessionPath =
    typeof input.activeState?.state.sessionFile === 'string'
      ? input.activeState.state.sessionFile
      : undefined;
  const nodes: SidebarNode[] = [
    {
      id: 'resume.search',
      kind: 'action',
      label: input.recent.filterText ? `Search: ${input.recent.filterText}` : 'Search recent chats',
      description: input.recent.filterText
        ? 'Change or clear the current filter.'
        : 'Find a recent chat by title, prompt, workspace, or model.',
      icon: 'search',
      command: { command: 'piRpcInternal.filterRecentSessions', title: 'Search recent chats' },
    },
    {
      id: 'resume.refresh',
      kind: 'action',
      label: 'Refresh',
      description: 'Read the latest saved chats.',
      icon: 'refresh',
      command: { command: 'piRpcInternal.refreshRecentSessions', title: 'Refresh recent chats' },
    },
  ];

  if (input.recent.filterText) {
    nodes.push({
      id: 'resume.clear',
      kind: 'action',
      label: 'Clear search',
      description: 'Show every recent chat again.',
      icon: 'close',
      command: {
        command: 'piRpcInternal.clearRecentSessionFilter',
        title: 'Clear recent chat search',
      },
    });
  }

  if (input.recent.loading) {
    nodes.push({
      id: 'resume.loading',
      kind: 'info',
      label: 'Loading recent chats',
      description: 'Reading saved Pi chats.',
      icon: 'loading~spin',
    });
    return nodes;
  }

  if (input.recent.error) {
    nodes.push({
      id: 'resume.error',
      kind: 'info',
      label: "Couldn't read recent chats",
      description: input.recent.error,
      icon: 'warning',
    });
    nodes.push({
      id: 'resume.retry',
      kind: 'action',
      label: 'Try again',
      description: 'Refresh the recent chat list.',
      icon: 'refresh',
      command: { command: 'piRpcInternal.refreshRecentSessions', title: 'Try again' },
    });
    return nodes;
  }

  if (input.recent.items.length === 0) {
    nodes.push({
      id: 'resume.empty',
      kind: 'info',
      label: 'No recent chats yet',
      description: 'Start a new chat and it will appear here.',
      icon: 'history',
    });
    return nodes;
  }

  for (const session of input.recent.items.slice(0, 25)) {
    const label = sessionDisplayName(session);
    const description = [
      session.workspaceLabel,
      formatRelativeTimestamp(session.modifiedAt, now),
      session.modelLabel,
      currentSessionPath === session.path ? 'Current' : undefined,
    ]
      .filter(Boolean)
      .join(' · ');
    nodes.push({
      id: `resume.${session.id}`,
      kind: 'session',
      label,
      description,
      detail:
        session.firstPromptPreview && session.firstPromptPreview !== label
          ? session.firstPromptPreview
          : undefined,
      tooltip: `${label}\n${description}\n${session.path}`,
      icon: currentSessionPath === session.path ? 'check' : 'history',
      contextValue: 'piRpc.recentSession',
      command: {
        command: 'piRpc.switchSession',
        title: 'Resume Chat',
        arguments: [{ sessionPath: session.path, label }],
      },
      accessibilityLabel: `${label}. ${description}`,
    });
  }

  return nodes;
}
