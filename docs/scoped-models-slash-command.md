# `/scoped-models`

The canonical plural command takes no arguments. Both composers open a native multi-select picker, then an explicit **Apply to this session only** / **Apply and save GLOBAL enabledModels** decision. Escape at either stage changes nothing. Only accepted command text clears; attachment chips remain. Moving focus does not retarget the originating chat; replaced sessions cancel pending selections.

Retained models keep their prior order and scoped thinking levels; new selections append in canonical identity order. All or none means the native unrestricted `[]` scope. Setting a scope does not select a current model, change its thinking level, or submit a prompt. Scoped thinking is applied/clamped by native model cycling later.

Global save replaces `enabledModels` with canonical refs (and retained thinking suffixes). The confirmation displays saved/unavailable patterns and any project override; replacement of unavailable patterns is explicit, not silent. Empty global `[]` is saved and means unrestricted startup. Project settings are never written. The SDK's SettingsManager locked merge preserves unrelated settings and symlink targets; save waits for `flush()` and checks `drainErrors()`. **Native storage is not crash-atomic.** Read/parse/permission/write errors report failure and prevent the staged session change.

## Backend

This is a GUI SDK-host extension, **not a stock Pi RPC command**. SDK 0.99.1 or 0.99.2 package identity/version/API shape and an explicit capability handshake are required. Shared and isolated dedicated sessions reuse `host/pi-multi-host.mjs`, the existing supervisor, transport and typed command dispatcher. Unknown custom wrappers/binaries and other versions retain ordinary stock RPC, with an unsupported-scope diagnostic. No unrelated PATH SDK replaces an explicitly chosen external executable.

The small audited startup adapter uses public `parseArgs`, native settings/trust/resource/session services, public builtin factories and the 0.99.1 native builtin llama entry. It carries launcher argv/environment, offline/recovery/resource exclusions, session files/in-memory sessions, model/thinking/tool options, system prompts and no-approve. Interactive/admin/resume/fork/session-id startup modes unsupported by the adapter are rejected and fall back to stock, never silently ignored. Unresolved project trust stays denied; no trust-persistence UI is added. Runtime sharing is partitioned by environment/cwd/argv/agent directory/offline. Offline disables create-time catalog networking, **not prompt/auth networking or an OS sandbox**.

Selectors use `getAvailableSnapshot`, copy scope arrays both directions and return whitelisted model/ref DTOs. Catalog, scope and fresh disk pattern provenance enter a stable revision; stale acceptance/save rejects before mutation. Native pattern resolution uses the audited version-gated pure resolver, not a new glob parser. No stream/completion/auth operation is requested by selectors.

Automated evidence: `scoped-command`, `scoped-backend`, `scoped-command-routes`, and `scoped-sdk-host` tests. Owned Node26-permission fixtures use dummy providers, deny non-owned egress, reject all provider calls in scope tests, and never inherit user credentials. Live VS Code use remains untested. The original scope-only acceptance above does not establish acceptance of later commands.

## Current-engine compatibility reassessment (0.99.2)

The selected installed JavaScript package is explicitly supported alongside 0.99.1;
no newer version range is admitted. Host capabilities report the actual package
version, and launcher/client/changelog checks retain selected-root provenance.
The old RPC fingerprint baseline is **not** changed or treated as API authority.

Actual native inventory: 24 `dist/core/slash-commands.js` entries plus the three
hidden interactive handlers (`debug`, `arminsayshi`, `dementedelves`) match all 27
existing reservations. `llama` and `mcp` are resource-added commands, not additional
entries in that core inventory.

| Scope                              | Contract / disposition                                                                                                                                                                                                    |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Existing 12                        | model, scoped-models, thinking, settings, copy, name, session, hotkeys, changelog, export, compact, debug; native shared/dedicated smokes and GUI regression suites retained.                                             |
| Public native APIs reused          | ModelRuntime catalog, AgentSession model/thinking/scope setters, SettingsManager setters/flush/drainErrors, SessionManager identity/tree, native HTML/JSONL export and compact callbacks. No SDK engine reimplementation. |
| Exact-version private adapters     | Startup orchestration; pure model resolver, dynamic thinking maps, builtin llama entry, RPC framing/output/theme helpers. Public-method stability does not make these private contracts version-independent.              |
| Other 15, read-only preflight only | tree, import, share, bug, fork, clone, trust, login, logout, new, resume, reload, quit, arminsayshi, dementedelves remain reserved here; no new implementation or external effects in this scope.                         |

0.99.2 release changes include MCP exposure/authentication, default-tool reload and
provider/model lookup fixes; they are not evidence that unchanged generic commands
need rewritten getters. Existing fixtures keep their private WeakMap identity,
fixed assets, strict environment, Node filesystem permissions and owned loopback
network denial. Selected SDK file/root identity is rechecked before fixture spawns.

Compatibility smokes are not full historical settings acceptance: held default
flush races, exhaustive real-controller failure/cancel/stale/no-ACK coverage,
queue delivery and active retry/compaction effects retain their recorded gaps.
Native persistence remains non-crash-atomic and failed writes may leave changed
active state. No local install, version bump, live provider or paid test is implied.
`LOCAL-pi-gui-core-command-migration` remains OPEN pending remaining implementation,
independent verification, review and user-authorized local installation.
