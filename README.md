# Pi RPC VS Code Extension

Direct VS Code integration for Pi `0.80.10` RPC mode.

## Features

- One Pi RPC subprocess per selected workspace folder
- Strict UTF-8 LF-only JSONL transport with correlated requests
- Start & Sessions sidebar with Quick Start, Current Session, Recent Sessions, and Help
- Safe recent-session discovery from Pi session files/session metadata, with search, refresh, current markers, and resume actions
- Conversation & Branches, Queues, Workflow, and Advanced & Diagnostics views with clearer plain-language labels
- Secure chat webview with streamed transcript, current session header, queue controls, status/widgets/title support, and progressive disclosure
- Direct `get_commands` discovery for Pi extensions, prompts, skills, and packages
- Restricted-mode aware startup with `--no-approve`
- Redacted diagnostics and health export

## Session workflow

```text
Start & Sessions
  ├─ Start Pi
  ├─ New Session / Resume Session
  ├─ Open Chat
  └─ Recent Sessions (search, refresh, resume)

Open Chat
  ├─ Current workspace / session / model / status
  ├─ Ask Pi
  └─ Conversation, Queues, Workflow, Session Tools, Advanced

Conversation & Branches
  └─ Start Branch from an earlier user message or open the Conversation Map
```

## Settings

See `package.json` for the contributed `piRpc.*` settings.

## Development

```bash
npm ci
npm run build
npm test
npm run package:vsix
```

## Notes

- The extension never reads Pi auth files.
- `--api-key` is rejected from persisted settings.
- Unsupported local-only RPC compatibility APIs remain explicit no-op/disabled capabilities rather than fabricated UI.
