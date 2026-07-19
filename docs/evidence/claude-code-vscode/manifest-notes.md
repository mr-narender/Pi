# Manifest and README notes

Primary public sources:

- `README.md`
- `package.json`

Verified-by-manifest highlights:

- Activation: `onStartupFinished`, `onWebviewPanel:claudeVSCodePanel`.
- Default location setting: `claudeCode.preferredLocation` enum `sidebar | panel`, default `panel`.
- Editor/open commands: `claude-vscode.editor.openLast`, `claude-vscode.editor.open`, `claude-vscode.primaryEditor.open`, `claude-vscode.sidebar.open`, `claude-vscode.window.open`, `claude-vscode.terminal.open`.
- Session commands: `claude-vscode.newConversation`, `claude-vscode.reopenClosedSession`, `claude-vscode.logout`, `claude-vscode.showLogs`, `claude-vscode.openWalkthrough`.
- Contextual editor actions: `claude-vscode.acceptProposedDiff`, `claude-vscode.rejectProposedDiff`, `claude-vscode.insertAtMention`.
- Keybindings: `Ctrl/Cmd+Escape` focus/blur Claude, `Ctrl/Cmd+Shift+Escape` open Claude in new tab, optional `Ctrl/Cmd+N` new conversation, optional `Ctrl/Cmd+Shift+T` reopen closed session, `Alt+K` insert mention.
- Editor title menu contributes Claude launcher when `!config.claudeCode.useTerminal`.
- Views/containers: alternate Claude containers exist in `activitybar` and `secondarySidebar`; an optional sessions-list container/view exists behind `claude-vscode.sessionsListEnabled`.
- No status-bar contribution is declared in the public manifest.

Verified-by-public-doc highlights:

- Walkthrough steps explicitly mention `Past Conversations`, `/resume`, and `New Chat`.
- README says native UI is the preferred experience.
- README says terminal mode is a switchable fallback (`claudeCode.useTerminal`).
- README says current file and current selection are first-class context inputs.
