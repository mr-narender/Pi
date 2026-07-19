# Manual Acceptance and VSIX Smoke Plan

## Safety prerequisites

- Use a throwaway workspace and isolated directories: `PI_CODING_AGENT_DIR=<temp>/agent`, `PI_CODING_AGENT_SESSION_DIR=<temp>/sessions`.
- Do not copy real `auth.json`, provider environment variables, SSH keys, or production repositories. Use a mock RPC executable for protocol/UI tests and a local/mock provider for inference tests.
- Start with `PI_OFFLINE=1 PI_TELEMETRY=0 PI_SKIP_VERSION_CHECK=1`; monitor network. No paid call or remote write is approved by this plan.
- Record OS, architecture, VS Code/version, local or remote host, extension version, Pi `0.80.10`, VSIX hash, workspace trust, and result/evidence for each case. Evidence must be redacted.

## Build and package gate

1. Clean checkout; install locked dependencies; run typecheck, lint, unit, fuzz/property, mocked-RPC, integration, and Extension Host suites.
2. Run the matrix validator: all `C-*`, `E-*`, `U-*`, `X-*`, and `D-*` IDs unique; all **82** concrete `piRpc.` action IDs unique; and the current inventory totals still equal **90 named rows** (34 `C`, 20 `E`, 9 `U`, 19 `X`, 8 `D`) plus **6** assistant-delta handling rows. Every documented command/event/UI method and every installed local/degraded `ExtensionUIContext` member must have an implementation and test mapping.
3. Run `vsce ls`; inspect bundled files. Confirm no auth/session files, `.env`, private keys, absolute developer paths, test secrets, unwanted source maps, temp files, or pi-acp source.
4. Run dependency/license/security review and generate a checksum/SBOM. Build VSIX using the pinned toolchain twice and compare expected reproducibility differences.

Acceptance: all gates pass and the only intended artifact is the VSIX plus reports outside the repository.

## Packaged installation smoke

Use isolated `--user-data-dir` and `--extensions-dir`.

1. Install the VSIX with `code --install-extension <vsix> --force` (or the matching remote CLI when testing remote).
2. Launch the throwaway workspace with Extension Development Host logging disabled for secrets.
3. Confirm Activity Bar container, five views, chat, output channel, commands, settings, and status items exist. No Pi process starts before explicit Start.
4. Configure mock executable; run `Pi RPC: Start`. Confirm version check, handshake, ready state, and Health report.
5. Reload window. Confirm safe reattach prompt, no duplicate process/views/listeners, and successful reconciliation.
6. Stop, uninstall, relaunch, reinstall, and relaunch. Confirm clean deactivation, no orphan child, and no secret/session content in global state.

Acceptance: packaged—not source-hosted—extension completes all steps; process ownership is clean.

## Protocol and lifecycle cases

| Case                   | Procedure                                                                                                                                                      | Acceptance                                                                                                                  |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| RPC-01 Strict framing  | Mock emits records at every byte boundary, split UTF-8, CRLF, JSON strings containing U+2028/U+2029, and one final non-empty EOF record without a trailing LF. | Exact events decode once; Unicode separators do not split records; the final non-empty EOF record is accepted exactly once. |
| RPC-02 Faults          | Emit blank/non-object/malformed/fatal-UTF-8/oversized records plus stdout/stderr floods.                                                                       | Generation faults visibly, buffers stay bounded, diagnostics redacted, recovery available; no silent skip.                  |
| RPC-03 Correlation     | Reorder responses; emit duplicate/orphan/wrong-command ids; exit mid-request.                                                                                  | Correct promises settle once; anomalies logged; all pending reject on loss.                                                 |
| RPC-04 Backpressure    | Mock slows stdin and stdout processing.                                                                                                                        | Writes wait for drain, UI stays responsive, order preserved, limits enforced.                                               |
| RPC-05 Lifecycle       | Run prompt with two turns, tools, retry, overflow compaction, follow-up, `agent_end(willRetry)`, then settled.                                                 | Busy remains until `agent_settled`; statuses and transcript are ordered.                                                    |
| RPC-06 Cancellation    | Abort active model, retry delay, compaction, and bash separately.                                                                                              | Correct abort command sent; queue/transients reconcile; no unrelated process killed.                                        |
| RPC-07 Crash/reconnect | Kill child during idle, streaming, and tool execution.                                                                                                         | Bounded backoff; confirmed session reattaches; no prompt/tool replay; user sees uncertain operation warning.                |
| RPC-08 Unknowns        | Emit unknown event, block, message role, and extra fields plus the three source-observed events.                                                               | No crash/data corruption; accessible fallback/diagnostic; state reconciliation succeeds.                                    |

## Full command matrix walkthrough

Use Matrix IDs from [RPC_COVERAGE.md](RPC_COVERAGE.md) and record each result.

1. **Prompt/queue (C-001–C-004, C-013–C-014):** send idle text+image; while running send steer and follow-up; switch both queue modes; invoke an extension command during streaming; abort. Verify queue tree from events and settled semantics.
2. **Sessions/tree (C-005–C-007, C-023–C-030):** create with/without parent, name, fetch messages, inspect entries incrementally, tree/orphan/labels, copy last response, fork each eligible user message, clone, cancel extension-vetoed new/switch/fork/clone, and switch back. Verify replacement handshake, active leaf, and that cancelled fork/clone leave the current session/draft untouched.
3. **Models/thinking (C-008–C-012):** list/select/cycle scoped and unscoped models; test one/no-model cases, image capability, all supported thinking levels including `max`, and unavailable-auth error.
4. **Compaction/retry (C-015–C-018):** manual with custom instructions, automatic threshold and overflow, abort/failure, toggle auto compaction/retry, retry success/final failure/abort. Verify nullable context usage after compaction.
5. **Bash (C-019–C-020):** run success, nonzero, mixed output, cancellation, truncation/full output, and excluded-from-context. Verify explicit trust confirmation and that no BashExecution event is expected.
6. **Stats/export (C-021–C-022):** inspect usage/cost/context and export via Save dialog. Test empty/unwritable/outside-workspace paths and safe opening.
7. **Commands (C-031):** list extension/prompt/skill provenance; invoke each fixture through direct `prompt`. Verify built-in TUI commands are absent and an extension command works while streaming.
8. **Errors/UI response (C-032–C-034):** all response failure forms, parse response, dialog cancellation and late timeout.

Acceptance: every row’s acceptance criterion and named test behavior is observed; failures remain recoverable.

## Extension UI walkthrough

Load installed official `examples/extensions/rpc-demo.ts` through an explicit trusted CLI extension path and use the mock to cover timeout variants.

- U-001 select: dangerous bash Allow and Block, escape, timeout.
- U-002 confirm: new-session Yes/No/escape/timeout and extension cancellation.
- U-003 input: text, intentional empty text, escape, timeout.
- U-004 editor: multiline prefill, edit/Submit, Cancel; verify no invented timeout.
- U-005 notify: info/warning/error/default.
- U-006 status: two keys, update, clear, controller isolation.
- U-007 widget: above/below, update, clear, multiline, disposal, and component-factory ignore behavior.
- U-008 title: normal/long/control-character input sanitization.
- U-009 editor text: empty draft and conflicting non-empty draft replace/append/cancel.

Acceptance: dialog responses match ids and shapes exactly once; fire-and-forget methods produce no response; keyboard/screen-reader behavior works.

## Local unsupported/degraded `ExtensionUIContext` compatibility walkthrough

Use a reviewed compatibility fixture extension that calls each installed local RPC-mode member while stdout is captured for unexpected `extension_ui_request` traffic.

- X-001–X-008: verify no-op/disposer/`undefined` behaviors for terminal input, working-state APIs, header/footer, and `custom()`.
- X-009–X-013: verify `pasteToEditor()` delegates exactly once to `set_editor_text`, `getEditorText()` returns `""`, autocomplete/editor-component setters are ignored, and `getEditorComponent()` returns `undefined`.
- X-014–X-017: verify the `theme` getter stays local/read-only, `getAllThemes()` returns `[]`, `getTheme()` returns `undefined`, and `setTheme()` returns `{ success:false, error }` without switching VS Code theme state.
- X-018–X-019: verify tools-expanded getter/setter remain local compatibility no-ops.

Acceptance: all X-rows match installed Pi semantics exactly, emit no extra wire methods beyond `U-001`–`U-009`, and produce only the planned unsupported-custom-UI diagnostic.

## Trust, privacy, and webview cases

| Case                     | Procedure                                                                                                               | Acceptance                                                                                                                |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| SEC-01 Restricted Mode   | Open project containing `.pi/settings.json`, extension, skill, prompt, and package while untrusted.                     | Child uses `--no-approve`; mutable/chat actions disabled; project code not loaded; warning says trust is not sandbox.     |
| SEC-02 Trust transition  | Grant VS Code trust, then choose Pi approve/decline paths.                                                              | Old child stops; fresh generation starts with selected policy; no cross-root authorization.                               |
| SEC-03 Canary secrets    | Put unique canaries in mock env/stderr/message/image metadata. Exercise errors/health/export/webview/telemetry.         | No canary appears outside allowed in-memory protocol view; diagnostic export redacts it.                                  |
| SEC-04 XSS/CSP           | Send script tags, event handlers, SVG/data payloads, command/javascript links, hostile tool JSON/title/widget markdown. | Nothing executes; unsafe links blocked; CSP has no remote/script escape.                                                  |
| SEC-05 Path escape       | Tool args include `..`, absolute outside path, symlink escape, NUL, Windows/UNC, wrong root.                            | Outside paths require explicit confirmation or reject; no silent read/open/write.                                         |
| SEC-06 Telemetry/network | Default settings under a network monitor; toggle extension/Pi telemetry controls and offline.                           | Extension sends nothing by default; Pi startup checks disabled by default; displayed policy distinguishes provider calls. |
| SEC-07 Limits            | Oversized image/frame/output/transcript/widget/dialog queue.                                                            | Rejected/bounded with actionable error; extension host remains responsive.                                                |

## Images, files, diffs, editor context, diagnostics

1. Attach valid PNG/JPEG/GIF/WebP by picker/paste; invalid MIME, corrupt base64, huge dimensions/bytes, too many images, and text-only model.
2. Add active editor selection, file reference, and VS Code diagnostic to composer; inspect preview before send.
3. Exercise read/write/edit plus multi-edit, parallel tools, create/delete, failed edit, external modification race, unified patch/details diff, and snapshot fallback.
4. Open/reveal each safe file; navigate next/previous diff; attempt outside-workspace and remote paths.
5. Open Health and redacted diagnostic export during idle/run/retry/compaction/fault.
6. Select/open a verified worktree path in a new window; cancel once. Confirm the extension performs no git mutation.

Acceptance: images are validated and never logged; editor context is explicit; diffs are readonly/accurately labeled; path/remote policy holds; diagnostics are useful and redacted.

## Sessions, packages, and workflow compatibility

1. Install a reviewed test Pi package into the isolated agent directory containing one extension command, skill, prompt, status/widget UI, and custom tool. Start in trusted workspace.
2. Confirm `get_commands` provenance and direct invocation of extension, prompt, and skill commands. Confirm custom tool events and UI methods render.
3. Disable resources/project trust and restart; verify discovery changes only after restart.
4. For `pi-agent-workflow`, set `AGENT_REGISTRY_ROOT` to a reviewed checkout that contains remote-tracking branch `origin/feat/pi-agent-workflow` (current local acceptance source: `/Users/narender/dev/agent-registry`). Record `git -C "$AGENT_REGISTRY_ROOT" rev-parse origin/feat/pi-agent-workflow` in the evidence.
5. Extract a deterministic temporary compatibility fixture, without referencing the checkout path from product code or checked-in settings:
   ```bash
   WORKFLOW_FIXTURE_ROOT="$(mktemp -d)"
   git -C "$AGENT_REGISTRY_ROOT" archive --format=tar --prefix=pi-agent-workflow/ \
     origin/feat/pi-agent-workflow:pi-agent-workflow | tar -xf - -C "$WORKFLOW_FIXTURE_ROOT"
   ```
6. Use only the extracted temp package for compatibility evidence: `pi -e "$WORKFLOW_FIXTURE_ROOT/pi-agent-workflow"` for run-only checks, or `pi install "$WORKFLOW_FIXTURE_ROOT/pi-agent-workflow"` inside the isolated agent directory when install/update behavior must be exercised.
7. Repeat compatibility testing using the package’s actual commands, workflow state, status/widget output, and direct `get_commands` discovery. Do not substitute ACP or depend on npm publication.
8. If `origin/feat/pi-agent-workflow` is absent in the target environment, stop here and record final package-compat acceptance as blocked on that missing source branch.

Acceptance: package functionality uses Pi discovery/direct RPC and extension commands are not filtered or reimplemented. `pi-agent-workflow` evidence comes from the archived branch fixture when available; otherwise the release record keeps it as an explicit blocked acceptance item.

## Multi-root and remote/platform matrix

- Multi-root with two folders: independent children/sessions/queues/statuses/trust; folder picker and close-one-folder cleanup.
- Desktop macOS, Linux, and Windows: executable with spaces, missing/permission denied, Windows `pi.cmd`, bash path error, graceful/forced termination.
- At least Remote SSH or Dev Container, plus WSL on Windows where available: Pi executes on remote host, remote credentials/session/path used, no local path confusion.
- Virtual/non-file workspace: explicit unsupported message, no spawn.

Acceptance: no cross-controller state or path leakage; host labeling and process placement are correct.

## Accessibility and UX

Complete the whole send/steer/abort/model/session/dialog/diff workflow keyboard-only. Test NVDA or VoiceOver, 200% zoom, high-contrast themes, reduced motion, long localized strings, empty/loading/error states, and focus restoration after every XUI method. Verify throttled `aria-live` summaries and non-color statuses.

Acceptance: no keyboard trap, visible focus, meaningful names/roles/statuses/alt text, no token-stream screen-reader spam, and native theme compatibility.

## Final acceptance record

Release only when:

- Every protocol matrix row and security/manual case is Pass or has an approved, documented platform exception.
- `git status --short` before implementation release contains only intentional source/docs/test/package changes; no credentials, sessions, temp artifacts, or VSIX unless repository policy explicitly tracks the artifact.
- Packaged VSIX checksum, contents review, install smoke, remote smoke, telemetry opt-out, accessibility review, and process cleanup evidence are attached to the release record.
- No unapproved network request, paid model request, package install, remote write, or credential exposure occurred.
