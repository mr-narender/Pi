# Claude Code VS Code observer summary

Disposable run setup:

- VS Code `1.129.1`
- extension under test: `anthropic.claude-code@2.1.215`
- isolated `HOME` and disposable `--user-data-dir`
- `security.workspace.trust.enabled: false` in disposable profile
- commands invoked by helper extension; output captured in `observer-output.json`

Sanitized observations from `observer-output.json`:

- Initial `claudeCode.preferredLocation` resolved to `panel`.
- `claude-vscode.editor.openLast` opened a `Claude Code` webview tab in a second editor group (`ViewColumn 2`).
- Invoking `claude-vscode.editor.openLast` again created another `Claude Code` tab in the same second group rather than reusing the first visible tab.
- `claude-vscode.editor.open` added a third `Claude Code` tab in the same second group.
- `claude-vscode.primaryEditor.open` added a `Claude Code` tab to the primary editor group (`ViewColumn 1`) while prior `Claude Code` tabs remained in the second group.
- `claude-vscode.sidebar.open` caused no observable editor-tab change in this unauthenticated run.
- `claude-vscode.newConversation` caused no observable editor-tab change in this unauthenticated run.
- Closing the primary-group `Claude Code` tab left the other `Claude Code` tabs open in the second group.
- `claude-vscode.reopenClosedSession`, `claude-vscode.showLogs`, and `claude-vscode.openWalkthrough` caused no observable editor-tab change in this unauthenticated run.

Interpretation boundary:

- The run confirms editor-group/tab lifecycle and command availability.
- It does **not** reveal authenticated transcript/session content.
- No UI copy from inside the unauthenticated webview was captured.
