# Security and Privacy Plan

## Security boundary

Pi and its extensions run with the extension-host user’s full permissions. Workspace Trust is an input-loading guard, not a sandbox. The VS Code extension cannot promise that model-generated tool calls, repository context, skills, packages, or extensions are safe. For untrusted/unattended work, require an OS/container/VM boundary and least-privilege mounts/credentials.

Protected assets include provider credentials/OAuth tokens, environment variables, source and session content, image data, context files, extension data, filesystem paths, command output, webview integrity, and process control.

## Threats and controls

| Threat                                                 | Required control                                                                                                                                                                                                                                                | Verification                                                        |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Untrusted project extensions/settings/packages execute | In Restricted Mode launch `--no-approve`, no project resource flags, no mutable tools; trusted mode asks separately before `--approve`; show effective Pi trust.                                                                                                | Restricted/trusted Extension Host tests and manual cases SEC-01/02. |
| Prompt injection/model misuse                          | Explain limitation; show every running tool, provide abort, diff/review workflow; optional read-only tools profile; no claims of sandboxing.                                                                                                                    | UI copy and read-only integration test.                             |
| Command/argv injection                                 | `spawn(executable, argv, {shell:false})` except narrowly tested Windows launcher handling; no user-composed shell string; validate flag/value allowlist.                                                                                                        | Metacharacter/space/Windows tests.                                  |
| Secret exposure                                        | Never read `auth.json`; prohibit persisted/argv API keys; inherit minimal environment; SecretStorage only for extension-owned future secrets; redact logs/errors/diagnostic export/webview; file mode remains Pi-owned.                                         | Canary-secret search over logs, state, webview, VSIX.               |
| Malicious stdout/protocol desync                       | Byte-level LF splitter, one-trailing-CR rule, fatal UTF-8/JSON/object/size validation, unique correlation, unknown-safe codecs, accepted final non-empty EOF record, and connection fault on malformed records.                                                 | Parser fuzz and hostile fixture suite.                              |
| Memory/CPU denial                                      | Limits for frame, buffers, pending requests, event/UI queues, stderr, transcript, snapshots, images; coalescing/yielding and process termination on violation.                                                                                                  | Flood/backpressure/oversize tests.                                  |
| Webview script/HTML injection                          | `enableScripts` only where needed; random nonce; CSP `default-src 'none'`; script/style nonce or bundled local URI; `img-src` limited to webview/local data types required; no remote fonts/scripts; sanitize markdown and disable raw HTML; safe link schemes. | CSP snapshot and XSS corpus.                                        |
| Forged webview messages                                | Runtime schema, discriminated allowlist, request nonce/generation, size limit, controller ownership checks; never trust path/command/id from DOM.                                                                                                               | Hostile message tests.                                              |
| Filesystem escape/symlink/path spoof                   | Resolve on extension host, canonicalize existing paths, associate controller cwd, allow workspace paths by default; explicit confirmation outside workspace; reject NUL/invalid schemes; re-check at action time.                                               | Traversal/symlink/multi-root/remote tests.                          |
| Unsafe export/diff/file opening                        | Save/Open dialogs; no auto-open external URL; readonly virtual diff docs; never apply/revert automatically; safe URI schemes.                                                                                                                                   | Navigation tests and manual NAV cases.                              |
| Image exfiltration/bombs                               | Explicit user attachment; magic-byte MIME check, allowed MIME list, count/encoded+decoded size/dimension limits, local resize/metadata stripping where possible; model capability and Pi image-block setting warning; never log base64.                         | Polyglot/bomb/oversize/model tests.                                 |
| Extension UI spoofing/permission fatigue               | Label dialog as originating from Pi extension, show sanitized title/details, serialize dialogs, safe cancellation/default, cap queue, honor timeout.                                                                                                            | Official rpc-demo and timeout/race tests.                           |
| Stale/foreign process control                          | Track child PID/generation only; process-tree kill only for owned child; generation-tag every request/event; dispose on folder removal.                                                                                                                         | Restart/race/process tests.                                         |
| Unapproved network/telemetry                           | Extension telemetry off by default; no updater/download; launch child with `PI_TELEMETRY=0`, `PI_SKIP_VERSION_CHECK=1` by default and offer offline mode; document provider calls still occur for prompts.                                                      | Network monitor smoke and settings tests.                           |
| Package supply chain                                   | Never auto-install from extension; display Pi-discovered command provenance; package admin opens terminal with user confirmation; dependency lock/audit/license/SBOM/VSIX inventory.                                                                            | Release checklist and provenance tests.                             |

## Workspace Trust policy

1. No workspace: do not spawn; show Open Folder.
2. Untrusted workspace: `--no-approve`; disable prompt/bash/mutating session actions and image/file attachment; optionally allow state/session inspection using a read-only tool allowlist only after explicit start. Never pass project `-e`, skills, prompts, themes, settings-derived extra flags.
3. On VS Code trust grant: stop old child, explain that project code may execute, then start a fresh generation. Trust cannot be hot-applied.
4. Trusted workspace: default still follows Pi saved/global trust. Passing `--approve` requires a separate extension setting or per-launch confirmation because VS Code trust and Pi package trust have different meanings.
5. Multi-root: trust/action/cwd is per folder; one trusted folder never authorizes another. Session switches across cwd require reassignment confirmation and restart.

## Secrets and authentication

- Authentication is performed by Pi in an integrated terminal (`pi` then `/login`) on the same local/remote host. The extension only observes model availability/errors.
- Do not parse, watch, copy, chmod, back up, or expose `~/.pi/agent/auth.json`, `models.json` resolved values, provider headers, or shell-command key output.
- Environment construction starts from extension-host environment for compatibility, removes known editor IPC/debug variables not needed by Pi where safe, overlays only documented non-secret controls, and redacts all values from diagnostics. A future minimal-env mode is opt-in because provider/cloud auth may depend on ambient variables.
- Never put API keys in VS Code configuration sync. Reject `--api-key` in additional args; if a one-run key feature is ever added it must use SecretStorage and an environment pipe, not argv.

## Webview policy

- `localResourceRoots` includes only packaged media; workspace resources are converted to bounded in-memory/data representations after host validation, not generally exposed.
- CSP example target: `default-src 'none'; img-src <webview-source> data:; style-src <webview-source> 'nonce-…'; script-src 'nonce-…'; font-src <webview-source>; connect-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'`. Tighten style nonce based on implementation and avoid `unsafe-inline`.
- Use DOM text APIs, a configured markdown sanitizer, and no `innerHTML` from protocol values. Tool JSON is text. Links allow `https`, `http` (confirmation as configured), `mailto`, and validated workspace `file` actions mediated by host; reject `javascript`, `command`, arbitrary `vscode`, and data links.
- Webview state contains presentation state only, never complete base64 images, secrets, raw environment, unrestricted filesystem paths, or pending UI response capabilities. On restore request a generation-tagged snapshot.

## Logging, diagnostics, and telemetry

Default log level is lifecycle only. Ring buffers are bounded and redacted before storage, not only on display. Redact token/key patterns, Authorization/cookie/header values, environment assignments, home/workspace prefixes, image data, prompts/messages/tool output, URLs with credentials/query, and extension UI input. Stderr is treated as potentially secret.

Extension telemetry defaults off. Opt-in is explicit and revocable; a local “Show telemetry payload” command precedes any future transmission. Permitted metrics are extension/Pi/VS Code versions, platform class, command category, success category, coarse latency bucket, and protocol fault category. Forbidden: content, paths, URIs, session/request/tool ids, command arguments/output, extension/package/skill names, provider/model identifiers, auth state, images, and error strings. No telemetry endpoint ships until separately reviewed.

Pi’s install telemetry and update check are separate controls. Child defaults use `PI_TELEMETRY=0` and `PI_SKIP_VERSION_CHECK=1`; `--offline`/`PI_OFFLINE=1` additionally disables startup package/model checks but does not prevent deliberate provider calls required for a prompt.

## Remote and containment guidance

In SSH/WSL/containers/Codespaces, Pi, credentials, sessions, extensions, and paths live on the remote extension host. UI must label the host and never attempt local path access. Recommend Dev Container/VM/read-only mounts for untrusted work. If users route only built-in tools into a sandbox, warn that other extension tools still run beside the host Pi process.

## Incident/failure response

On protocol/security-limit fault: stop accepting actions, reject pending requests, terminate only the owned child, clear UI capabilities and image/snapshot buffers, preserve a redacted health record, and require user-visible recovery. Never silently skip malformed stdout. On suspected secret leakage, do not include the suspect value in notification or telemetry; direct users to rotate credentials and delete diagnostics explicitly.

## Release security gate

- Dependency lock, `npm audit` triage, license/notice review, SBOM and `vsce ls` review.
- Grep source, built output, tests, docs, and VSIX for canary credentials, home paths, `.env`, auth/session fixtures, source maps policy, and private keys.
- XSS/CSP/webview message suite, path traversal/symlink suite, parser fuzz/limits, trust transition, telemetry/network monitor, remote-host, and Windows argv tests pass.
- Manual reviewer confirms permissions, settings descriptions, trust warnings, telemetry default, and containment documentation are accurate.
