# LOCAL-001 Reconnaissance

## Scope and baseline

- Repository baseline: `.gitignore` plus `docs/issues/LOCAL-001.md`; no extension implementation, package manifest, tests, or build configuration.
- Installed Pi: `@earendil-works/pi-coding-agent` **0.80.10**, Node requirement `>=22.19.0`, MIT license.
- Required integration boundary: a child process running `pi --mode rpc`; do not replace this with ACP or the in-process SDK, because direct RPC preserves Pi extension commands and the extension UI sub-protocol.
- `pi-agent-workflow` is not installed or published in this environment, but source is available from the existing agent-registry checkout via remote-tracking branch `origin/feat/pi-agent-workflow` and subtree `pi-agent-workflow/`. Compatibility evidence should use a deterministic temporary `git archive` extraction from that branch into an isolated temp directory; product code and checked-in settings must not hard-code `/Users/narender/dev/agent-registry`. If a target environment lacks that remote branch, final package-compatibility acceptance remains explicitly blocked.

## Sources read completely

Installed package root: `/Users/narender/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent`.

- `README.md`; `docs/rpc.md`, `sdk.md`, `session-format.md`, `sessions.md`, `settings.md`, `extensions.md`, `tui.md`, `packages.md`, `skills.md`, `prompt-templates.md`, `models.md`, `custom-provider.md`, `providers.md`, `compaction.md`, `security.md`, `containerization.md`, `windows.md`, and `json.md`.
- Official examples `examples/rpc-extension-ui.ts` and `examples/extensions/rpc-demo.ts`.
- Official typed client and protocol artifacts: `dist/modes/rpc/rpc-client.{d.ts,js}`, `rpc-types.d.ts`, `jsonl.js`, and relevant declarations in `dist/core/agent-session.d.ts`, `session-manager.d.ts`, `messages.d.ts`, `bash-executor.d.ts`, `compaction/compaction.d.ts`, and `source-info.d.ts`.
- Runtime help from `PI_OFFLINE=1 pi --version` and `PI_OFFLINE=1 pi --help`.
- Reference only: npm package `pi-acp@0.0.31` README, package metadata, MIT license (copyright Sergii Kozak), and complete bundled `dist/index.js`. No pi-acp code is to be copied. Useful patterns were process ownership, request correlation, session reattachment, ordered UI emission, tool-call status monotonicity, pre-edit snapshots, absolute path resolution, Windows `.cmd` launch handling, and auth-error UX. Its use of Node `readline`, client-side queue replacement, omission of extension commands, and partial extension UI are specifically unsuitable here.

## Protocol inventory summary

The canonical row-by-row inventory is [RPC_COVERAGE.md](RPC_COVERAGE.md).

### Wire and process rules

- stdin commands and stdout responses/events are UTF-8 JSON objects framed by **LF only**. Strip one trailing `\r` for CRLF compatibility, and accept one final non-empty buffered record at EOF. U+2028/U+2029 inside JSON strings are data, not delimiters.
- Every client command gets a unique string `id`; only responses correlate by that id. Events have no command request id. Extension UI requests have their own unique id namespace and use `extension_ui_response` for dialog completion.
- A successful `prompt` response means accepted, queued, or handled, not completed. Completion is `agent_settled`, not `agent_end`.
- stdout is protocol-only; stderr is diagnostics. Invalid JSON from stdout is a protocol fault, not ignorable decoration.
- Pi itself waits for raw-stdout backpressure. The client must also honor child stdin `write()` backpressure and bound all buffers/queues.

### Documented command set (32)

`prompt`, `steer`, `follow_up`, `abort`, `new_session`, `get_state`, `get_messages`, `set_model`, `cycle_model`, `get_available_models`, `set_thinking_level`, `cycle_thinking_level`, `set_steering_mode`, `set_follow_up_mode`, `compact`, `set_auto_compaction`, `set_auto_retry`, `abort_retry`, `bash`, `abort_bash`, `get_session_stats`, `export_html`, `switch_session`, `fork`, `clone`, `get_fork_messages`, `get_entries`, `get_tree`, `get_last_assistant_text`, `set_session_name`, `get_commands`, and dialog-side `extension_ui_response`.

All normal responses are `{id?,type:"response",command,success}` with command-specific `data`; failure adds `error`. Parser failures use `command:"parse"`. `extension_ui_response` is not answered with a normal response.

### Documented streamed events (17)

`agent_start`, `agent_end`, `agent_settled`, `turn_start`, `turn_end`, `message_start`, `message_update`, `message_end`, `tool_execution_start`, `tool_execution_update`, `tool_execution_end`, `queue_update`, `compaction_start`, `compaction_end`, `auto_retry_start`, `auto_retry_end`, and `extension_error`.

`message_update.assistantMessageEvent.type` is one of `start`, `text_start`, `text_delta`, `text_end`, `thinking_start`, `thinking_delta`, `thinking_end`, `toolcall_start`, `toolcall_delta`, `toolcall_end`, `done`, or `error`. `done.reason` is `stop|length|toolUse`; `error.reason` is `aborted|error`.

### Extension UI wire methods (9)

Dialogs: `select`, `confirm`, `input`, `editor`. Fire-and-forget: `notify`, `setStatus`, `setWidget`, `setTitle`, `set_editor_text`. Dialog cancellation maps to `undefined` except `confirm`, which maps to `false`. Agent-side timeout resolves defaults; the client must safely dismiss stale UI without racing a late response.

### Local unsupported/degraded `ExtensionUIContext` compatibility surface (19)

These are **not** extra wire methods. Installed RPC mode keeps them local-only compatibility behavior: `onTerminalInput()` returns a no-op disposer; `setWorkingMessage()`, `setWorkingVisible()`, `setWorkingIndicator()`, `setHiddenThinkingLabel()`, `setFooter()`, `setHeader()`, `addAutocompleteProvider()`, `setEditorComponent()`, and `setToolsExpanded()` are no-ops; `custom()` resolves `undefined`; `pasteToEditor()` delegates to `setEditorText()`; `getEditorText()` returns `""`; `getEditorComponent()` and `getTheme()` return `undefined`; `theme` getter returns Pi’s imported local theme object; `getAllThemes()` returns `[]`; `setTheme()` returns `{ success:false, error }`; `getToolsExpanded()` returns `false`; and `setWidget()` ignores component-factory content. `ctx.mode` is `rpc` and `ctx.hasUI` is true.

### State and data types

- `get_state`: full `model|null/omitted`, `thinkingLevel`, `isStreaming`, `isCompacting`, `steeringMode`, `followUpMode`, `sessionFile?`, `sessionId`, `sessionName?`, `autoCompactionEnabled`, `messageCount`, `pendingMessageCount`.
- Full model: `id`, `name`, `api`, `provider`, `baseUrl`, `reasoning`, `input` (`text|image`), `contextWindow`, `maxTokens`, cost (`input`, `output`, `cacheRead`, `cacheWrite`) plus provider-specific optional metadata. Treat unknown fields as forward-compatible data and never display keys/headers.
- Content blocks: text `{type,text}`, image `{type,data,mimeType}`, thinking `{type,thinking}`, tool call `{type:"toolCall",id,name,arguments}`.
- Messages: user, assistant, toolResult, bashExecution, custom, branchSummary, compactionSummary. Preserve unknown roles/blocks for diagnostics and fallback rendering.
- Assistant usage: input/output/cacheRead/cacheWrite/totalTokens and nested cost; stop reason `stop|length|toolUse|error|aborted`, optional `errorMessage`.
- Attachment documented fields: `id,type,image,fileName,mimeType,size,content,extractedText,preview`.
- Session entries: message, model_change, thinking_level_change, compaction, branch_summary, custom, custom_message, label, session_info. All have `id`, `parentId`, ISO `timestamp`; header has version (current 3), UUID, cwd, and optional parent session. Tree nodes add children and optional label/labelTimestamp. `get_entries.since` is a durable append cursor and fails when unknown; `leafId` detects active-branch movement.
- Session stats include message/tool counts, aggregate tokens, cost, and optional context usage. Context tokens/percent may be null immediately after compaction.
- Bash result includes output, `exitCode` (possibly absent on cancellation), cancelled, truncated, and optional full output path. RPC bash output enters LLM context on the next prompt and emits no BashExecutionMessage event.
- Compaction result includes summary, first kept entry id, tokens before, optional estimated tokens after, and extension-defined details.
- Slash commands include name, optional description, source (`extension|prompt|skill`), and canonical `sourceInfo` provenance. Built-in TUI commands are not invokable in RPC.

## Startup and environment inventory

The extension exposes safe settings for executable, cwd strategy, and these Pi flags rather than a free-form shell string. Runtime help is authoritative for 0.80.10:

- Selection/auth: `--provider`, `--model`, `--api-key` (prohibited in extension settings/argv; use environment/Pi auth), `--thinking`, `--models`.
- Session: `--continue`, `--resume` (TUI-only picker; do not use for RPC startup), `--session`, `--session-id`, `--fork`, `--session-dir`, `--no-session`, `--name`.
- Tools: `--tools`, `--exclude-tools`, `--no-builtin-tools`, `--no-tools`.
- Resources: repeatable `--extension`, `--skill`, `--prompt-template`, `--theme`; `--no-extensions`, `--no-skills`, `--no-prompt-templates`, `--no-themes`, `--no-context-files`.
- Prompt/display/network/trust: `--system-prompt`, repeatable `--append-system-prompt`, `--verbose`, `--approve`, `--no-approve`, `--offline`.
- Mode/control: `--mode rpc`, `--print`, `--export`, `--list-models`, help/version. Extension-registered flags may also exist but must be passed as an argv array only after explicit user configuration.

Important environment controls: `PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR`, `PI_PACKAGE_DIR`, `PI_OFFLINE`, `PI_SKIP_VERSION_CHECK`, `PI_TELEMETRY`, `PI_CACHE_RETENTION`, provider variables, proxy variables, and platform shell variables. The extension defaults Pi install telemetry off and version check off for child launches unless users explicitly opt in; this is separate from extension telemetry, which is off by default.

## Trust, packages, and resource behavior

- RPC cannot prompt for project trust. With no saved decision, global `defaultProjectTrust:"ask"` and `"never"` skip protected project settings/resources; `"always"` loads them. Per-run `--approve` or `--no-approve` overrides.
- VS Code Restricted Mode must always launch with `--no-approve`, disable mutable tools and explicit project resource flags, and make the chat read-only until trust is granted and Pi is restarted.
- Trust is not a sandbox. Context files load even when project resources are untrusted unless disabled. Extensions/packages execute arbitrary code; skills can induce arbitrary actions.
- Do not recreate package/skill/template discovery. Launch Pi in the selected workspace cwd and use `get_commands`; this preserves package extension commands such as workflow commands. Package install/update/config are separate terminal/admin workflows requiring explicit user action and trust.

## Notable limitations and failure modes

- No RPC command lists sessions, imports JSONL, navigates a tree in place, labels entries, logs in/out, reloads resources, changes active tools, reads startup diagnostics, or exports JSONL. Use VS Code file APIs/session directory scanning only for discovery, `switch_session` for opening, and extension commands from `get_commands` for package-provided operations. Never send interactive built-ins through `prompt`.
- `fork` only accepts a user entry and returns its text; `clone` duplicates current active branch. Both and new/switch may be cancelled while still returning `success:true`.
- Process loss cannot transparently resume an in-flight model/tool operation. Recovery starts a fresh process against the last confirmed session file, reconciles via `get_state`, `get_entries`, and `get_messages`, and requires explicit user retry of unconfirmed input.
- Failure classes: spawn (`ENOENT`, `EACCES`, incompatible version), early exit, signal/exit, stderr flood, malformed/oversized/invalid UTF-8 stdout record, unknown message/event, duplicate/orphan response id, response command mismatch, timeout, stdin backpressure/closure, queue race, UI timeout/late response, RPC `success:false`, provider auth/rate/5xx/overflow, compaction failure/abort, extension error, missing session/cursor, filesystem/path/remote mismatch, and webview disposal/reload.

## Documentation discrepancies and conservative decisions

These are internal inconsistencies, so implementation must not guess:

1. `rpc.md` documents 17 events, while `AgentSessionEvent` also contains `entry_appended`, `session_info_changed`, and `thinking_level_changed`, and `rpc-mode.js` forwards every session event. **Decision:** accept, validate loosely, store, and test these three as source-observed compatibility events, but do not make core UX depend on them; reconcile state after mutations.
2. `rpc.md` shows `get_commands` legacy `location`/`path`; 0.80.10 `rpc-types.d.ts` uses `sourceInfo {path,source,scope,origin,baseDir?}`. **Decision:** prefer `sourceInfo`, tolerate legacy fields, and sanitize paths.
3. `rpc.md` omits `bash.excludeFromContext`, present in `rpc-types.d.ts`. **Decision:** expose it only through an explicit “run without adding to context” command and test both values.
4. `rpc.md` broadly says dialog timeout fields are forwarded, but `editor` has no timeout in the 0.80.10 type/implementation. **Decision:** never send or locally invent editor timeout semantics.
5. Official `examples/rpc-extension-ui.ts` and pi-acp use Node `readline`, contradicting strict framing in `rpc.md`, and installed `jsonl.js` also accepts a final non-empty EOF buffer. **Decision:** preserve installed LF-only / trailing-CR / final-EOF-record semantics, but implement byte-first LF splitting and per-record `TextDecoder('utf-8', { fatal:true })` decoding so malformed UTF-8 faults deterministically; tests include U+2028/U+2029, split UTF-8, malformed UTF-8, and accepted final non-empty EOF records.
6. `rpc-client.handleLine()` ignores malformed JSON, unsafe for production. **Decision:** fail the connection, preserve redacted diagnostics, terminate/recover rather than silently desynchronize.
7. `session-format.md` uses ISO string entry timestamps, while a compaction snippet declares numeric timestamps. Installed `session-manager.d.ts` says string. **Decision:** parse string as canonical, tolerate number only in a compatibility decoder, never rewrite session files.
8. README CLI table omits runtime-help flags `--session-id`, short resource-disable aliases, and `--offline`; runtime help includes them. **Decision:** pin behavior to detected version 0.80.10 and its runtime help, with capability/version checks.
9. `json.md` has an older event union lacking `agent_settled`, extension errors, and `agent_end.willRetry`. **Decision:** RPC documentation and installed declarations take precedence for RPC.
10. The typed client’s public `ModelInfo` narrows a full model to four fields despite `rpc.md` returning full models. **Decision:** retain the full wire model and derive a safe view model.
