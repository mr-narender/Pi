# Pi RPC VS Code Extension

Direct VS Code integration for Pi `0.80.10` RPC mode.

## Features

- One Pi RPC subprocess per selected workspace folder
- Strict UTF-8 LF-only JSONL transport with correlated requests
- Activity Bar launcher/history sidebar with New Chat, Resume Chat, and recent-session search
- Stable `pi-chat:` custom editor tabs with native reveal/dedup, multi-session/multi-root isolation, and reopen-safe session identity
- Safe recent-session discovery from Pi session files/session metadata, with search, refresh, current markers, and resume actions
- Secure in-editor Pi chat surface with streamed transcript, per-tab composer/attachments, status/widgets/title support, and progressive disclosure
- Direct `get_commands` discovery for Pi extensions, prompts, skills, and packages
- Restricted-mode aware startup with `--no-approve`
- Redacted diagnostics and health export

## Session workflow

```text
Sidebar
  ├─ New Chat
  └─ Resume Chat / Search / Recent Sessions

Pi editor tab
  ├─ Current session status in the active tab
  ├─ Model / New / History / More
  ├─ Current or cached transcript
  ├─ Composer, attachments, preview, and send/stop
  └─ Advanced commands, diagnostics, widgets, and context tools
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
