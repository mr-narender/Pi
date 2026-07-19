# LOCAL-001 — Build a comprehensive Pi RPC VS Code extension

State: open
Agent: pi
Kind: feature

## Acceptance criteria

- [x] Spawn and supervise `pi --mode rpc` with strict LF-delimited JSONL framing, request correlation, cancellation, recovery, and diagnostics.
- [x] Expose every command and event documented by the installed Pi 0.80.10 RPC protocol through an appropriate VS Code GUI or command.
- [x] Support extension UI requests/responses, sessions and trees, models/thinking, queues, compaction/retry, bash, commands, images, editor context, diagnostics, usage, export, and workflow status.
- [x] Provide native Activity Bar/sidebar, chat webview, status bar, settings, Command Palette actions, diff/file navigation, and worktree opening.
- [x] Integrate with installed Pi packages including `pi-agent-workflow` without losing extension commands.
- [x] Include protocol coverage matrix, architecture/design, security model, troubleshooting, installation, packaging, and manual acceptance documentation.
- [x] Include unit, integration, mocked-RPC, and VS Code Extension Host tests plus a packaged VSIX.
- [x] Install the VSIX into VS Code and execute a documented smoke test without exposing credentials or performing unapproved remote writes.

## Context

Direct task requested by the user. Repository is local-only at `~/dev/pi-extension`; development occurs in the Worktrunk task worktree.
