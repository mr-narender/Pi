import { basename } from 'node:path';
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

function currentStatus(state: SidebarViewInput['activeState']): string {
  if (!state) {
    return 'Ready to start';
  }
  if (state.state.isStreaming === true) {
    return 'Pi is replying';
  }
  if (state.state.isCompacting === true) {
    return 'Compacting';
  }
  if (state.connectionState === 'faulted') {
    return 'Needs attention';
  }
  if (state.connectionState === 'stopped') {
    return 'Ready to start';
  }
  return 'Ready';
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
      label: 'Unsent draft and attachments stay in Current Chat.',
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

export function createCurrentChatSidebarModel(input: SidebarViewInput): SidebarNode[] {
  if (!input.activeState) {
    return [
      {
        id: 'current.empty',
        kind: 'info',
        label: 'No current chat',
        description: 'Open Current Chat to start or resume a conversation.',
        icon: 'comment-discussion',
      },
      {
        id: 'current.open.empty',
        kind: 'action',
        label: 'Open Current Chat',
        description: 'Open the main chat surface.',
        icon: 'comment-discussion',
        command: { command: 'piRpcInternal.openChat', title: 'Open Current Chat' },
      },
    ];
  }

  const model =
    input.activeState.state.model && typeof input.activeState.state.model.provider === 'string'
      ? `${input.activeState.state.model.provider}/${String(input.activeState.state.model.id ?? 'model')}`
      : 'Model';
  const sessionName =
    typeof input.activeState.state.sessionName === 'string' &&
    input.activeState.state.sessionName.length > 0
      ? input.activeState.state.sessionName
      : typeof input.activeState.state.sessionFile === 'string'
        ? basename(input.activeState.state.sessionFile)
        : 'No chat yet';

  const nodes: SidebarNode[] = [
    ...(input.showWorkspacePicker
      ? [
          {
            id: 'current.workspacePicker',
            kind: 'action' as const,
            label: 'Choose workspace',
            description: 'Switch the active workspace folder.',
            icon: 'folder-library',
            command: {
              command: 'piRpcInternal.selectWorkspaceFolder',
              title: 'Choose workspace',
            },
          },
        ]
      : []),
    {
      id: 'current.open',
      kind: 'action',
      label: 'Open Current Chat',
      description: 'Return to the main chat surface.',
      icon: 'comment-discussion',
      command: { command: 'piRpcInternal.openChat', title: 'Open Current Chat' },
    },
    {
      id: 'current.workspace',
      kind: 'summary',
      label: 'Workspace',
      description: input.activeState.workspaceFolderName,
      icon: 'folder-library',
    },
    {
      id: 'current.session',
      kind: 'summary',
      label: 'Session',
      description: sessionName,
      detail:
        typeof input.activeState.state.sessionFile === 'string'
          ? basename(input.activeState.state.sessionFile)
          : undefined,
      icon: 'comment-discussion',
    },
    {
      id: 'current.model',
      kind: 'summary',
      label: 'Model',
      description: model,
      icon: 'sparkle',
    },
    {
      id: 'current.status',
      kind: 'summary',
      label: 'Status',
      description: currentStatus(input.activeState),
      detail:
        typeof input.activeState.state.pendingMessageCount === 'number'
          ? `${input.activeState.state.pendingMessageCount} waiting`
          : undefined,
      icon: input.activeState.connectionState === 'faulted' ? 'warning' : 'pulse',
    },
    {
      id: 'current.advanced',
      kind: 'action',
      label: 'Advanced',
      description: 'Show advanced commands and diagnostics.',
      icon: 'gear',
      command: { command: 'piRpc.toggleAdvancedMode', title: 'Advanced' },
    },
  ];

  if (
    input.activeState.state.isStreaming === true ||
    input.activeState.connectionState === 'busy'
  ) {
    nodes.push({
      id: 'current.stop',
      kind: 'action',
      label: 'Stop',
      description: 'Abort the current Pi reply.',
      icon: 'debug-stop',
      command: { command: 'piRpc.abort', title: 'Stop' },
    });
  }

  return nodes;
}
