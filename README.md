# Pi RPC VS Code Extension

Direct VS Code integration for Pi `0.80.10` RPC mode.

## Features

- One Pi RPC subprocess per selected workspace folder
- Strict UTF-8 LF-only JSONL transport with correlated requests
- Activity Bar views for sessions, outline, queue, workflow, and diagnostics
- Secure chat webview with streamed transcript, queue controls, status/widgets/title support
- Direct `get_commands` discovery for Pi extensions, prompts, skills, and packages
- Restricted-mode aware startup with `--no-approve`
- Redacted diagnostics and health export

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
