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
  kind: 'section' | 'action' | 'summary' | 'session' | 'info';
  label: string;
  description?: string;
  detail?: string;
  tooltip?: string;
  icon?: string;
  contextValue?: string;
  command?: SidebarNodeCommand;
  accessibilityLabel?: string;
  children?: SidebarNode[];
}

export interface SessionSidebarModelInput {
  activeFolderName?: string;
  activeFolderUri?: string;
  activeState?: Pick<
    ControllerState,
    'connectionState' | 'workspaceFolderName' | 'state' | 'leafId'
  >;
  recent: RecentSessionsState;
  isTrusted: boolean;
  isFirstRun: boolean;
  now?: number;
}

function sessionDisplayName(session: RecentSessionRecord): string {
  return (
    session.displayName || session.sessionName || session.firstPromptPreview || 'Untitled session'
  );
}

function sessionDescription(
  session: RecentSessionRecord,
  currentSessionPath: string | undefined,
  now: number
): string {
  const bits = [session.workspaceLabel, formatRelativeTimestamp(session.modifiedAt, now)];
  if (session.modelLabel) {
    bits.push(session.modelLabel);
  }
  if (currentSessionPath === session.path) {
    bits.push('Current');
  }
  return bits.join(' · ');
}

function currentSessionSummary(state: SessionSidebarModelInput['activeState']): SidebarNode[] {
  if (!state) {
    return [
      {
        id: 'current.empty',
        kind: 'info',
        label: 'No workspace selected',
        description: 'Open a folder, then start or resume Pi.',
        icon: 'info',
      },
    ];
  }

  const sessionName =
    typeof state.state.sessionName === 'string' && state.state.sessionName.length > 0
      ? state.state.sessionName
      : typeof state.state.sessionFile === 'string'
        ? basename(state.state.sessionFile)
        : 'No session yet';
  const sessionState =
    state.state.isStreaming === true
      ? 'Streaming reply'
      : state.state.isCompacting === true
        ? 'Compacting context'
        : state.connectionState === 'stopped'
          ? 'Stopped'
          : state.connectionState === 'faulted'
            ? 'Needs attention'
            : 'Ready';
  const model =
    state.state.model && typeof state.state.model.provider === 'string'
      ? `${state.state.model.provider}/${String(state.state.model.id ?? 'model')}`
      : 'Model not chosen yet';
  const sessionFile =
    typeof state.state.sessionFile === 'string' ? basename(state.state.sessionFile) : 'Not started';

  return [
    {
      id: 'current.workspace',
      kind: 'summary',
      label: 'Workspace',
      description: state.workspaceFolderName,
      icon: 'folder-library',
      accessibilityLabel: `Current workspace ${state.workspaceFolderName}`,
    },
    {
      id: 'current.session',
      kind: 'summary',
      label: 'Session',
      description: sessionName,
      detail: sessionFile,
      icon: 'comment-discussion',
      accessibilityLabel: `Current session ${sessionName}`,
    },
    {
      id: 'current.model',
      kind: 'summary',
      label: 'Model',
      description: model,
      icon: 'sparkle',
      accessibilityLabel: `Current model ${model}`,
    },
    {
      id: 'current.state',
      kind: 'summary',
      label: 'Status',
      description: sessionState,
      detail:
        typeof state.state.pendingMessageCount === 'number'
          ? `${state.state.pendingMessageCount} waiting`
          : undefined,
      icon: state.connectionState === 'faulted' ? 'warning' : 'pulse',
      accessibilityLabel: `Current status ${sessionState}`,
    },
  ];
}

function recentSessionNodes(
  recent: RecentSessionsState,
  currentSessionPath: string | undefined,
  now: number
): SidebarNode[] {
  const nodes: SidebarNode[] = [
    {
      id: 'recent.search',
      kind: 'action',
      label: recent.filterText ? `Filter: ${recent.filterText}` : 'Search recent sessions',
      description: recent.filterText
        ? 'Change or clear the current filter.'
        : 'Find by name, workspace, model, or first prompt.',
      icon: 'search',
      command: {
        command: 'piRpcInternal.filterRecentSessions',
        title: 'Search recent sessions',
      },
      accessibilityLabel: recent.filterText
        ? `Recent session filter ${recent.filterText}`
        : 'Search recent sessions',
    },
  ];

  if (recent.filterText) {
    nodes.push({
      id: 'recent.clear',
      kind: 'action',
      label: 'Clear session search',
      description: 'Show the full recent session list again.',
      icon: 'close',
      command: {
        command: 'piRpcInternal.clearRecentSessionFilter',
        title: 'Clear recent session search',
      },
    });
  }

  if (recent.loading) {
    nodes.push({
      id: 'recent.loading',
      kind: 'info',
      label: 'Loading recent sessions…',
      description: 'Reading Pi session files safely.',
      icon: 'loading~spin',
    });
    return nodes;
  }

  if (recent.error) {
    nodes.push({
      id: 'recent.error',
      kind: 'info',
      label: 'Could not read recent sessions',
      description: recent.error,
      icon: 'warning',
    });
    return nodes;
  }

  if (recent.items.length === 0) {
    nodes.push({
      id: 'recent.empty',
      kind: 'info',
      label: recent.filterText ? 'No sessions match this search' : 'No recent sessions yet',
      description: recent.filterText
        ? 'Try a different search term or clear the filter.'
        : 'Start Pi, then create or resume a session here.',
      icon: 'history',
    });
    return nodes;
  }

  for (const session of recent.items.slice(0, 25)) {
    const label = sessionDisplayName(session);
    const description = sessionDescription(session, currentSessionPath, now);
    nodes.push({
      id: `recent.${session.id}`,
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
        title: 'Resume Session',
        arguments: [{ sessionPath: session.path, label }],
      },
      accessibilityLabel: `${label}. ${description}`,
    });
  }

  return nodes;
}

export function createSessionSidebarModel(input: SessionSidebarModelInput): SidebarNode[] {
  const currentSessionPath =
    typeof input.activeState?.state.sessionFile === 'string'
      ? input.activeState.state.sessionFile
      : undefined;
  const now = input.now ?? Date.now();

  const quickStartDescription = input.isTrusted
    ? 'Start Pi, create a fresh session, resume a saved session, or open chat.'
    : 'Restricted Mode keeps write actions disabled until you trust this workspace.';

  return [
    {
      id: 'section.quickStart',
      kind: 'section',
      label: 'Quick Start',
      description: quickStartDescription,
      icon: 'rocket',
      children: [
        {
          id: 'quick.workspace',
          kind: 'action',
          label: 'Choose Workspace',
          description: 'Switch the active workspace when you have more than one folder open.',
          icon: 'folder-library',
          command: {
            command: 'piRpcInternal.selectWorkspaceFolder',
            title: 'Choose Workspace',
          },
          accessibilityLabel: 'Choose the active workspace folder',
        },
        {
          id: 'quick.start',
          kind: 'action',
          label: 'Start Pi',
          description: 'Launch Pi for the selected workspace.',
          icon: 'play-circle',
          command: { command: 'piRpcInternal.start', title: 'Start Pi' },
          accessibilityLabel: 'Start Pi for the selected workspace',
        },
        {
          id: 'quick.new',
          kind: 'action',
          label: 'New Session',
          description: 'Start a fresh conversation or continue from this one.',
          icon: 'add',
          command: { command: 'piRpc.newSession', title: 'New Session' },
          accessibilityLabel: 'Create a new session',
        },
        {
          id: 'quick.resume',
          kind: 'action',
          label: 'Resume Session',
          description: 'Pick a saved session from the recent list.',
          icon: 'history',
          command: { command: 'piRpc.switchSession', title: 'Resume Session' },
          accessibilityLabel: 'Resume a saved session',
        },
        {
          id: 'quick.chat',
          kind: 'action',
          label: 'Open Chat',
          description: 'Open the chat panel with session controls and messages.',
          icon: 'comment-discussion',
          command: { command: 'piRpcInternal.openChat', title: 'Open Chat' },
          accessibilityLabel: 'Open chat',
        },
      ],
    },
    {
      id: 'section.current',
      kind: 'section',
      label: 'Current Session',
      description: input.activeFolderName
        ? `Active workspace: ${input.activeFolderName}`
        : 'Choose a workspace to see the current session.',
      icon: 'comment-discussion',
      children: currentSessionSummary(input.activeState),
    },
    {
      id: 'section.recent',
      kind: 'section',
      label: 'Recent Sessions',
      description: 'Saved Pi sessions for this workspace.',
      icon: 'history',
      children: recentSessionNodes(input.recent, currentSessionPath, now),
    },
    {
      id: 'section.firstRun',
      kind: 'section',
      label: input.isFirstRun ? 'First Run Tips' : 'Need a refresher?',
      description: input.isFirstRun
        ? 'Follow these steps the first time you use Pi in VS Code.'
        : 'Helpful reminders for branching, resuming, and chat.',
      icon: 'lightbulb',
      children: [
        {
          id: 'tips.start',
          kind: 'info',
          label: '1. Start Pi for this workspace',
          description: 'Use Start Pi above or the toolbar button.',
          icon: 'play-circle',
        },
        {
          id: 'tips.resume',
          kind: 'info',
          label: '2. Choose New Session or Resume Session',
          description: 'New Session starts fresh. Resume Session reopens a saved conversation.',
          icon: 'history',
        },
        {
          id: 'tips.branch',
          kind: 'info',
          label: '3. Branches let you explore without losing your place',
          description:
            'In Conversation & Branches, select a user message to start a branch there. Duplicate Path copies the current path as a new branch.',
          icon: 'git-branch',
        },
      ],
    },
  ];
}

export interface HelpSidebarModelInput {
  isFirstRun: boolean;
}

export function createHelpSidebarModel(input: HelpSidebarModelInput): SidebarNode[] {
  return [
    {
      id: 'help.walkthrough',
      kind: 'section',
      label: input.isFirstRun ? 'Start here' : 'Session guide',
      description: input.isFirstRun
        ? 'Everything you need for your first Pi session.'
        : 'Quick reminders for common session tasks.',
      icon: 'book',
      children: [
        {
          id: 'help.start',
          kind: 'action',
          label: 'Start Pi',
          description: 'Connect Pi to the selected workspace.',
          icon: 'play-circle',
          command: { command: 'piRpcInternal.start', title: 'Start Pi' },
        },
        {
          id: 'help.new',
          kind: 'action',
          label: 'New Session',
          description: 'Begin a fresh conversation and keep the current one saved.',
          icon: 'add',
          command: { command: 'piRpc.newSession', title: 'New Session' },
        },
        {
          id: 'help.resume',
          kind: 'action',
          label: 'Resume Session',
          description: 'Reopen a saved session from the recent list.',
          icon: 'history',
          command: { command: 'piRpc.switchSession', title: 'Resume Session' },
        },
        {
          id: 'help.chat',
          kind: 'action',
          label: 'Open Chat',
          description: 'See the active conversation, status, and controls.',
          icon: 'comment-discussion',
          command: { command: 'piRpcInternal.openChat', title: 'Open Chat' },
        },
      ],
    },
    {
      id: 'help.words',
      kind: 'section',
      label: 'Plain-language guide',
      description: 'What the session tools mean in this extension.',
      icon: 'question',
      children: [
        {
          id: 'help.branch',
          kind: 'info',
          label: 'Start Branch',
          description:
            'Create a new direction from an earlier user message without deleting the current path.',
          icon: 'git-branch',
        },
        {
          id: 'help.clone',
          kind: 'info',
          label: 'Duplicate Path',
          description:
            'Copy the current conversation path into a new branch so you can try another idea.',
          icon: 'copy',
        },
        {
          id: 'help.tree',
          kind: 'info',
          label: 'Conversation Map',
          description:
            'Show the saved conversation tree so you can inspect branches and the current marker.',
          icon: 'type-hierarchy-sub',
        },
      ],
    },
  ];
}
