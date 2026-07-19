# LOCAL-001 Implementation Plan

## Product definition

Build a production VS Code desktop/remote extension that owns one direct Pi 0.80.10 RPC subprocess per selected workspace folder, renders its complete protocol, and never proxies through ACP. Primary surfaces:

- Activity Bar container with Sessions, Conversation Outline, Queue, Tools/Workflow, and Diagnostics tree views.
- A retained-context chat webview panel/view with streamed markdown, thinking disclosure, tool cards, images, extension widgets, queue composer, and accessible live status.
- Status bar items for connection/run state, model/thinking, context usage/cost, and extension statuses.
- Command Palette and context menus for every RPC command in [RPC_COVERAGE.md](RPC_COVERAGE.md).
- VS Code settings for executable, folder/session selection, startup argv, trust policy, rendering, telemetry, limits, and diagnostics.

## Proposed package architecture

```text
src/
  extension.ts                    activation, registrations, disposables
  commands/                       command handlers and argument gathering
  config/                         schema, migration, argv builder, version gate
  process/                        executable resolution, spawn, supervisor, stderr ring
  rpc/
    jsonlDecoder.ts               strict LF UTF-8 framing
    transport.ts                  bounded writes, request correlation, timeouts
    codecs.ts                     runtime validation + forward-compatible unknowns
    protocol.ts                   local wire types pinned to 0.80.10
    client.ts                     complete command API and UI responses
  sessions/
    sessionController.ts          one controller state machine per folder
    sessionRegistry.ts            multi-root ownership and persistence
    reconciliation.ts             state/messages/entries/tree refresh
    discovery.ts                  read-only session listing metadata
  state/
    reducer.ts                    event reducer; immutable normalized state
    selectors.ts                  derived queue/run/usage/view state
  ui/
    trees/ status/ notifications/ quickPicks/ editors/ diffs/ navigation/
  webview/
    provider.ts                   CSP/nonces/resource roots/message validation
    model.ts                      redacted serializable view model
    media/                        bundled JS/CSS only
  security/                       trust gate, path policy, secret redaction
  telemetry/                      disabled-by-default local facade
  diagnostics/                    output channel, health report, export redaction
  test/fixtures/                  mock RPC child scripts and protocol fixtures
```

Do not import Pi internals at runtime. Pin local protocol types/validators to 0.80.10 and detect `pi --version` before normal launch. The optional official typed client is reference only: it does not support extension UI, strict malformed-record handling, write backpressure, or recovery to production requirements.

## State machines

### Process/connection

`unconfigured -> locating -> versionChecking -> starting -> handshaking -> ready <-> busy -> stopping -> stopped` with terminal `unsupported` and recoverable `faulted/backoff` states.

- Handshake sends correlated `get_state`, `get_available_models`, `get_commands`, `get_entries`, `get_messages`, and `get_session_stats` after listeners are attached.
- `busy` is derived from lifecycle plus `isStreaming/isCompacting/retry/bash`; only `agent_settled` ends an accepted prompt workflow.
- Child exit rejects every pending request exactly once. Graceful stop sends abort/abort_bash/abort_retry as applicable, closes stdin, waits, SIGTERM, then platform-appropriate tree kill after timeout. Never auto-kill unrelated `pi` processes.
- Unexpected exit enters bounded exponential backoff with jitter only if the folder remains open and user has not stopped it. Maximum attempts/cooldown are configurable. Recovery never replays writes or prompts.

### Request lifecycle

`created -> queuedForWrite -> writing -> awaitingResponse -> succeeded|failed|timedOut|connectionLost|cancelledLocally`.

- Monotonic IDs include controller generation and counter; extension UI ids occupy a separate map.
- Validate response `id`, `command`, shape, and single completion. Unknown/orphan/duplicate responses are protocol diagnostics.
- Per-command timeout classes: short state commands, long compaction/bash/export, no timeout for accepted agent work (tracked via events). Cancellation sends the corresponding Pi abort command; it does not pretend the original request was cancelled.

### Agent/workflow

`idle -> accepting -> running -> {tooling,compacting,retrying,queuedContinuation}* -> settled`; an orthogonal bash state is `idle|running|aborting`. `agent_end(willRetry)` does not settle. Events are reduced idempotently by message content index and toolCallId; tool status is monotonic. Reconciliation after reconnect/session replacement resets transient state and fetches authoritative data.

### Extension UI

Per dialog: `received -> presented -> responding -> completed` or `received -> timedOutByPi/stale -> dismissed`. Only one foreground dialog is presented at a time per controller; additional dialogs queue FIFO with a cap. Fire-and-forget state is keyed (`statusKey`, `widgetKey`). Dispose/restart cancels visible/queued dialogs when transport is still writable, then clears them. A local timeout only dismisses after Pi’s declared timeout plus grace; it must not send a late answer.

## Strict JSONL transport

1. Accumulate stdout as bytes and split on literal LF (`0x0A`) only; never use generic line readers that also treat U+2028/U+2029 as delimiters.
2. For each completed record, strip exactly one trailing CR (`0x0D`) before decoding; do not trim any other payload bytes.
3. Decode each record with byte-level `TextDecoder('utf-8', { fatal: true })`; reject malformed UTF-8, blank records, invalid JSON, non-object roots, and oversized records.
4. On EOF, decode and accept one final non-empty buffered record using the same LF/CR/UTF-8 rules; EOF with an empty buffer emits nothing.
5. Bound pending undecoded bytes, decoded record length, stderr ring, pending requests, outbound queue, event backlog, transcript cache, image bytes, and tool output shown in the webview. Defaults become documented settings; limit violations fault the generation.
6. Serialize one object plus `\n`; queue writes; pause on `write() === false` until `drain`; reject on stdin error/close. No concurrent direct writes.
7. Event reduction is chunked/yielded to the extension host; coalesce high-frequency text/thinking and accumulated tool updates while preserving lifecycle order. Webview updates use sequence numbers and snapshots to recover dropped renders.

Tests: arbitrary chunk boundaries, split multibyte code points, CRLF, literal U+2028/U+2029, braces/newlines escaped in JSON, multiple frames/chunk, accepted final non-empty EOF record, empty EOF after trailing LF, malformed UTF-8, oversized, malformed/non-object/blank, slow stdin, drain/error/close, stdout flood, stderr flood, duplicate/orphan/mismatched responses, and process exit mid-write/mid-request.

## Lifecycle, folder, and remote behavior

- `SessionRegistry` keys controllers by canonical workspace-folder URI, not path string. Multi-root commands require a folder Quick Pick and remember the active controller in workspace state. Never merge sessions across folders.
- Spawn cwd is the selected folder’s `fsPath`; non-file virtual workspaces are unsupported with a clear message. In Remote SSH/WSL/Dev Container/Codespaces, extension kind is workspace so Pi runs where files and terminal live. Executable resolution and PATH checks happen on the remote extension host.
- Session paths and tool paths belong to the process host. Use `Uri.file` only in that host and require a path to be within a workspace or explicitly confirmed before opening. Handle Windows `pi.cmd` with argv-safe spawn rules; never concatenate a shell command.
- Persist only controller selection, session file/id, last acknowledged entry cursor, non-secret UI preferences, and safe per-workspace/session composer metadata. Persist draft text, focus target, and safe refs/metadata for local file/selection/diagnostic chips only; never persist file snapshots, diagnostic bodies, accepted-send payloads, or base64 image bytes across VS Code restart. On activation, ask before reattaching; then `--session <path>` and reconcile. Session switching to another cwd may alter trust/resources, so update ownership or reject cross-folder switches after confirmation.
- Worktree command: resolve a returned/selected filesystem path, verify directory, then `vscode.openFolder(uri, {forceNewWindow:true})`; no git mutation is performed by the extension.

## VS Code surface design

### Chat

- User composer supports text, editor selection/reference insertion, diagnostic insertion, files, and PNG/JPEG/GIF/WebP images. Validate MIME by bytes, cap count/decoded size/dimensions, optionally resize locally, strip metadata where practical, and warn if selected model lacks image input or Pi blocks images.
- Define a client-side `PendingContextItem` discriminated union for `activeFile`, `pickedFile`, `selection`, and `diagnostics`. Each item carries workspace-relative path, bounded line range, sanitized captured content, and safe persisted metadata; diagnostics additionally carry bounded severity/issue metadata. Keep a per-workspace/session composer state with `draft`, `pendingContextItems`, `pendingImages`, `focus`, and `acceptedSendSnapshot`.
- Non-image chips are never sent as synthetic RPC attachments. At the send boundary, serialize them deterministically into one escaped text envelope appended to the RPC `message`; images remain exact RPC `images` objects `{type:'image',data,mimeType}` and are omitted entirely when there are no pending images. Preview must show the exact final `message` string and exact `images` list before send acceptance.
- Composer sends map to exact wire shapes only: idle send => `prompt`, busy send-next => `follow_up`, advanced steer => `steer`. Do not invent a separate `context` or non-image `images` payload, and do not rely on `prompt.streamingBehavior` for Simple Mode sends.
- After preflight acceptance, move draft, chips, images, serialized envelope, and exact RPC payload into an immutable `acceptedSendSnapshot` until `agent_settled`. On accepted-send failure, never auto-resend; `Copy to composer` reconstructs user text plus still-valid local refs, restores only still-in-memory images, and requires explicit reselection for expired images.
- Invalidate local context chips on file/workspace/session/trust changes, file content drift, diagnostic drift, and explicit removal. Stale chips stay visible but blocked from send until refreshed or removed.
- Stream text by content index. Render sanitized markdown with no raw HTML/script execution; links require explicit open and safe schemes. Thinking is collapsed by default and labeled for screen readers. Tool calls show name, validated args, status, incremental output, error state, and file/diff actions.
- Composer switches among normal prompt, steer, and follow-up while running. Queue view mirrors authoritative `queue_update`; abort explains that Pi restores/clears queue semantics and reconciliation follows.
- `set_editor_text` updates draft without stealing focus or silently overwriting non-empty text: prompt to replace/append unless unchanged.

### Files and diffs

- Resolve `path`/`file_path` arguments against controller cwd. For read/find/grep/list results expose open/reveal actions. Parse source locations defensively.
- Prefer tool result `details.patch` unified patch or `details.diff`; otherwise snapshot workspace files at `tool_execution_start` for edit/write and compare on end. Keep bounded snapshots, never read outside policy silently, and label inferred diffs.
- Use readonly virtual documents and `vscode.diff`; retain toolCallId-to-diff navigation. Support next/previous changed hunk through built-in diff editor commands where available, with fallback quick navigation. Never apply/revert a diff automatically.

### Extension UI mapping

- select/input: Quick Pick/Input Box; confirm: warning modal; editor: untitled document/custom editor wait flow with explicit Submit/Cancel; notify: VS Code notifications; status: keyed status bar; widget: keyed accessible chat regions; title: sanitized panel title; set editor text: composer draft.
- Only the nine wire methods in [RPC_COVERAGE.md](RPC_COVERAGE.md#extension-ui-requests) emit `extension_ui_request`. Every installed local/degraded `ExtensionUIContext` member in [RPC_COVERAGE.md](RPC_COVERAGE.md#local-unsupporteddegraded-extensionuicontext-api) stays local-only compatibility behavior: no invented wire methods, no fabricated TUI surfaces, and explicit tests for each return value/no-op path.
- Unsupported TUI methods remain Pi-defined degradation. Surface a one-time diagnostic when an extension apparently relies on unsupported custom UI, not fabricated behavior.

### Accessibility

- Keyboard-only operation for composer, queue, transcript/tool cards, dialogs, tree views, and diff actions.
- Semantic headings/lists/buttons, visible focus, VS Code theme tokens, no color-only status, reduced-motion support, zoom/high-contrast testing, alt text for images, and `aria-live=polite` throttled summaries (never token-by-token spam).
- Commands have titles/categories and keybindings are opt-in to avoid conflicts.

## Security and privacy implementation

Implement [SECURITY.md](SECURITY.md) as a release gate. Key points: Workspace Trust enforcement, no shell interpolation, no secrets in settings/argv/logs/webview/telemetry, narrow CSP, local-resource roots, message schema validation both directions, path confirmations, HTML/markdown sanitization, and telemetry off by default. Pi auth remains in its `0600` auth file/environment; provide “Open Terminal for Pi Login” rather than reading credentials.

## Diagnostics and observability

- Dedicated redacted output channel records timestamps, generation, command type/id hash, lifecycle, exit status, latency, byte counts, and stderr tail. Prompt text, image data, message content, env values, model headers, auth paths/content, and full workspace paths are omitted or hashed/basename-only.
- “Pi RPC: Show Health” includes versions, selected folder, state, queue lengths, limits, last event, pending request types, trust mode, and restart count.
- “Export Diagnostics” previews a redacted JSON report and asks for destination. No automatic upload.
- Extension telemetry is disabled by default and has a setting/command to inspect and opt in/out. If later enabled, collect only coarse command success/latency/version; never content, paths, model/provider credential status, extension names, or session ids. Child Pi starts with `PI_TELEMETRY=0` and `PI_SKIP_VERSION_CHECK=1` by default; users can independently opt into Pi behavior.

## Implementation phases and gates

### P0 — Scaffold and contracts

Create TypeScript VS Code extension package, engine/version policy, lint/typecheck/test/build scripts, generated command/settings contributions, license/notices, protocol validators, and fixture taxonomy. Gate: package activates with no Pi process until user action; all command IDs unique.

### P1 — Transport and supervisor

Implement strict decoder, writer/backpressure, correlation, process/version resolution, state machines, shutdown, redacted diagnostics, and mocked child fixtures. Gate: transport suite covers every framing/failure case and has no leaked process/request/timer.

### P2 — Complete protocol client and reducer

Implement every matrix command/event/UI request, local degraded `ExtensionUIContext` compatibility behavior, full data codecs, authoritative reconciliation, queue/compaction/retry/bash/session state, unknown compatibility events, and command handlers. Gate: automated matrix check proves all `C/E/U/X/D` row IDs, concrete `piRpc.` action IDs, and protocol discriminants unique and covered by tests.

### P3 — Native surfaces

Activity Bar trees, status bars, Quick Picks, dialogs, output/health, file/worktree navigation, session/tree/fork/clone/export/bash/model/thinking commands. Gate: Extension Host tests execute every contributed command with mocked RPC and validate enablement/trust clauses.

### P4 — Secure chat webview

Streaming transcript, markdown/content blocks, tools, queue composer, images, widgets/status/title/editor text, diff views, CSP and message validation, persistence/resync, accessibility. Gate: security tests reject injection/path/scheme/oversize payloads; axe/manual keyboard/high-contrast checks pass.

### P5 — Real Pi integration

Use an isolated `PI_CODING_AGENT_DIR`, temp workspace, `--offline`, `--no-approve`, and mock/local provider where possible. Exercise extension `rpc-demo.ts`, every command not requiring paid inference, synthetic event streams, cancellation, reconnect, session replacement, trust transitions, and discovered package commands. For `pi-agent-workflow`, source compatibility evidence from a deterministic temporary `git archive` extraction of the existing `origin/feat/pi-agent-workflow` remote branch when that branch is available; do not make product code depend on npm publication or a developer checkout path. Gate: extension commands from `get_commands` execute directly (including the workflow package fixture), all nine wire UI methods render/respond correctly, and all local degraded/no-op `ExtensionUIContext` members match the installed RPC-mode compatibility matrix.

### P6 — Packaging and release

Bundle production dependencies, exclude source maps/secrets/fixtures as policy dictates, add README/changelog/license/third-party notices, run `vsce ls`, dependency/license/vulnerability review, deterministic `vsce package`, install VSIX into isolated VS Code profile, desktop and remote smoke tests, uninstall/reinstall/upgrade tests. Gate: packaged artifact has no credentials, absolute developer paths, hidden network calls, or undeclared files.

## Test strategy

- Unit: parser/writer/codecs/reducer/state machines/redaction/argv/trust/path/image/markdown/diff/session discovery plus composer-state serialization, invalidation, restart persistence, accepted-send snapshot, and `Copy to composer` recovery.
- Property/fuzz: random chunking and Unicode JSON records; event sequences; hostile webview messages and paths; deterministic context-envelope escaping and size-cap boundaries.
- Mock RPC integration: executable fixtures for every command response, event, UI request, malformed/flood/backpressure/exit/race scenario, and exact `prompt`/`follow_up`/`steer` request-shape verification with message-envelope + RPC-image transport.
- Pi integration: installed 0.80.10 with isolated config and official RPC UI demo; no unapproved remote writes or paid provider calls.
- VS Code Extension Host: activation, commands/views/status/webview messaging, multi-root, trust change, workspace close, remote URI assumptions, diff/open-folder behavior.
- VSIX: contents snapshot, install into `--user-data-dir` and `--extensions-dir`, launch/smoke, upgrade, uninstall, offline start.
- Manual: [MANUAL_ACCEPTANCE.md](MANUAL_ACCEPTANCE.md).

## Definition of done

1. Every matrix row, including local `ExtensionUIContext` compatibility rows, is implemented and has the named automated test plus manual acceptance evidence.
2. Direct extension/prompt/skill commands returned by Pi remain invokable; no ACP translation layer exists.
3. Strict framing, limits, correlation, backpressure, cancellation, lifecycle, reconnect, trust, and webview security gates pass.
4. Desktop macOS/Linux/Windows and at least Remote SSH or Dev Container are tested; multi-root and restricted mode pass.
5. Accessibility and telemetry opt-out are verified.
6. A clean VSIX installs and passes documented smoke tests without credentials or unapproved writes.

## Halt/discrepancy policy

The exact inconsistencies and conservative choices are recorded in [RECON.md](RECON.md#documentation-discrepancies-and-conservative-decisions). Implementation must encode them as compatibility tests and must stop for a new contradiction that changes safety or wire semantics. Do not infer unsupported RPC commands from SDK/TUI APIs.
