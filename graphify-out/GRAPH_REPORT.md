# Graph Report - feat-pi-rpc-vscode  (2026-07-19)

## Corpus Check
- 90 files · ~73,235 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1194 nodes · 2674 edges · 89 communities (83 shown, 6 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 32 edges (avg confidence: 0.74)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `b3fc3386`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- JsonObject
- activate
- protocol.ts
- recentSessions.ts
- LOCAL-001 Implementation Plan
- validateCoverage.mjs
- devDependencies
- compilerOptions
- DiagnosticsLogger
- render.ts
- providers.ts
- extension.ts
- ChatPanelProvider
- Manual Acceptance and VSIX Smoke Plan
- package.json
- scripts
- tsconfig.json
- JsonlDecoder
- StatusBarController
- sessionController.ts
- RecentSessionService
- RegistryTreeProvider
- Pi 0.80.10 RPC Coverage Matrix
- Security and Privacy Plan
- keywords
- contributes
- SessionRegistry
- mock-pi-child.ts
- redactText
- LOCAL-001 Reconnaissance
- Protocol inventory summary
- properties
- files
- piRpc.telemetryEnabled
- Pi RPC VS Code Extension
- piRpc.additionalArgs
- LOCAL-002 — Make Pi RPC session navigation intuitive
- piRpc.longRunningTimeoutMs
- piRpc.maxImageBytes
- piRpc.maxImagesPerPrompt
- piRpc.maxPendingRequests
- piRpc.maxQueuedWrites
- piRpc.maxRecordBytes
- piRpc.maxRestartAttempts
- piRpc.maxToolOutputChars
- piRpc.maxTranscriptItems
- piRpc.responseTimeoutMs
- Changelog
- LOCAL-001 — Build a comprehensive Pi RPC VS Code extension
- piRpc.autoStart
- piRpc.executable
- piRpc.offline
- piRpc.restartOnCrash
- dependencies
- engines
- repository
- index.cjs
- README.md
- LOCAL-003 UX redesign — Pi RPC as a simple coding chat
- Wireframes
- Visual, spacing, type, and icon tokens
- LOCAL-003 — Simplify Pi RPC into a user-first interface
- Proposed information architecture
- Keyboard, focus, and accessibility
- Narrow, high-contrast, and reduced-motion behavior
- Usability validation plan
- Capability preservation map
- Component inventory and microcopy
- Outcome
- LOCAL-004 — Pi editor-tab migration plan
- Findings by topic
- .onMessage
- types.ts
- model.ts
- ChatTabStateCache
- PiProcessSupervisor
- rpc-coverage.test.ts
- default
- ChatUiMode
- manifest-notes.md
- observer-summary.md
- resource-observations.md
- State machines
- activationEvents

## God Nodes (most connected - your core abstractions)
1. `SessionController` - 136 edges
2. `activate()` - 95 edges
3. `ChatUiState` - 58 edges
4. `JsonObject` - 55 edges
5. `RpcClient` - 49 edges
6. `ChatTabManager` - 42 edges
7. `RpcTransport` - 28 edges
8. `ChatTabTarget` - 26 edges
9. `PendingContextItem` - 23 edges
10. `ExtensionUiRequest` - 22 edges

## Surprising Connections (you probably didn't know these)
- `SpawnedRpc` --references--> `RpcClient`  [EXTRACTED]
  test/helpers/rpc.ts → src/rpc/client.ts
- `SpawnedRpc` --references--> `RpcTransport`  [EXTRACTED]
  test/helpers/rpc.ts → src/rpc/transport.ts
- `reduceAll()` --calls--> `reduceEvent()`  [EXTRACTED]
  test/unit/rpc-coverage.test.ts → src/state/reducer.ts
- `reduceAll()` --calls--> `createInitialControllerState()`  [EXTRACTED]
  test/unit/rpc-coverage.test.ts → src/state/types.ts
- `SessionController` --references--> `PiRpcSettings`  [EXTRACTED]
  src/sessions/sessionController.ts → src/config/settings.ts

## Import Cycles
- None detected.

## Communities (89 total, 6 thin omitted)

### Community 0 - "JsonObject"
Cohesion: 0.14
Nodes (3): RpcClient, JsonObject, SessionState

### Community 1 - "activate"
Cohesion: 0.06
Nodes (8): activate(), ExtensionUiRequest, SessionController, resetControllerProjection(), ExtensionUiBroker, LOCAL_THEME, LocalExtensionUiContext, UnsupportedThemeResult

### Community 2 - "protocol.ts"
Cohesion: 0.06
Nodes (63): asOptionalString(), asRecord(), asString(), asStringArray(), COMMAND_TYPES, EVENT_TYPES, isJsonObject(), isJsonValue() (+55 more)

### Community 3 - "recentSessions.ts"
Cohesion: 0.18
Nodes (18): asObject(), buildRecentSessionRecord(), compareRecentSessionRecordTimestamps(), extractTextContent(), filterRecentSessions(), getAgentDir(), getDefaultSessionDirForWorkspace(), getMessageActivityTime() (+10 more)

### Community 4 - "LOCAL-001 Implementation Plan"
Cohesion: 0.20
Nodes (10): Definition of done, Diagnostics and observability, Halt/discrepancy policy, Lifecycle, folder, and remote behavior, LOCAL-001 Implementation Plan, Product definition, Proposed package architecture, Security and privacy implementation (+2 more)

### Community 5 - "validateCoverage.mjs"
Cohesion: 0.09
Nodes (18): collectExportedSymbols(), collectTestTitles(), coverage, createSourceFile(), errors, evidence, expectedIds, expectedRows (+10 more)

### Community 6 - "devDependencies"
Cohesion: 0.09
Nodes (23): esbuild, eslint, devDependencies, esbuild, eslint, prettier, tsx, @types/node (+15 more)

### Community 7 - "compilerOptions"
Cohesion: 0.09
Nodes (22): scripts/**/*.ts, test/**/*.ts, compilerOptions, esModuleInterop, forceConsistentCasingInFileNames, lib, module, moduleResolution (+14 more)

### Community 8 - "DiagnosticsLogger"
Cohesion: 0.15
Nodes (14): COMMAND_IDS, CONTRIBUTED_COMMANDS, ContributedCommand, createRedactedDiagnosticsExport(), redactJsonValue(), redactText(), SECRET_PATTERNS, asRecord() (+6 more)

### Community 9 - "render.ts"
Cohesion: 0.11
Nodes (35): canonicalizeSessionPath(), chipPrivacyLabel(), summarizeChip(), applyFocus(), focusElement(), getState(), handlePreviewKeydown(), persistViewState() (+27 more)

### Community 10 - "providers.ts"
Cohesion: 0.18
Nodes (3): RpcTransport, TypedEmitter, SlowWritable

### Community 11 - "extension.ts"
Cohesion: 0.20
Nodes (10): RpcClientOptions, RpcCommandType, RpcEvent, RpcResponse, createRequestId(), PendingRequest, RpcTransportEvents, RpcTransportOptions (+2 more)

### Community 12 - "ChatPanelProvider"
Cohesion: 0.05
Nodes (34): ChatEditorDocument, PersistedChatSnapshot, sanitizePendingImages(), toPersistedChatSnapshot(), ChatEditorProvider, asRecord(), ChatTabState, ChatTabStateCache (+26 more)

### Community 13 - "Manual Acceptance and VSIX Smoke Plan"
Cohesion: 0.13
Nodes (15): Accessibility and UX, Build and package gate, Extension UI walkthrough, Final acceptance record, Full command matrix walkthrough, Images, files, diffs, editor context, diagnostics, LOCAL-003 acceptance addendum, Local unsupported/degraded `ExtensionUIContext` compatibility walkthrough (+7 more)

### Community 14 - "package.json"
Cohesion: 0.17
Nodes (11): description, displayName, extensionKind, icon, license, main, name, private (+3 more)

### Community 15 - "scripts"
Cohesion: 0.14
Nodes (14): scripts, audit:prod, build, clean, format:check, lint, package:vsix, smoke:real-pi (+6 more)

### Community 16 - "tsconfig.json"
Cohesion: 0.15
Nodes (12): ./**/*.ts, ../tsconfig.json, compilerOptions, lib, noEmit, types, extends, include (+4 more)

### Community 17 - "JsonlDecoder"
Cohesion: 0.26
Nodes (3): JsonlDecoder, JsonlDecoderOptions, JsonlProtocolError

### Community 18 - "StatusBarController"
Cohesion: 0.26
Nodes (3): summarizeModel(), summarizeQueue(), StatusBarController

### Community 19 - "sessionController.ts"
Cohesion: 0.13
Nodes (8): RecentSessionService, SessionRegistry, NewChatTreeProvider, nodeToTreeItem(), RegistryTreeProvider, ResumeChatTreeProvider, SessionsTreeProvider, SidebarNode

### Community 20 - "RecentSessionService"
Cohesion: 0.21
Nodes (8): assert, run(), shutdown(), SpawnedRpc, spawnMockPi(), spawnRealPi(), execFileAsync, nextTick()

### Community 21 - "RegistryTreeProvider"
Cohesion: 0.29
Nodes (7): default, description, enum, type, piRpc.defaultViewMode, advanced, simple

### Community 22 - "Pi 0.80.10 RPC Coverage Matrix"
Cohesion: 0.20
Nodes (10): Assistant streaming delta submatrix, Commands and responses, Data-shape and state coverage, Extension UI requests, Local unsupported/degraded `ExtensionUIContext` API, Non-command response/error coverage, Pi 0.80.10 RPC Coverage Matrix, Source-observed compatibility events (+2 more)

### Community 23 - "Security and Privacy Plan"
Cohesion: 0.20
Nodes (10): Incident/failure response, Logging, diagnostics, and telemetry, Release security gate, Remote and containment guidance, Secrets and authentication, Security and Privacy Plan, Security boundary, Threats and controls (+2 more)

### Community 24 - "keywords"
Cohesion: 0.22
Nodes (9): categories, keywords, agent, assistant, Chat, Machine Learning, Other, pi (+1 more)

### Community 25 - "contributes"
Cohesion: 0.22
Nodes (9): contributes, commands, customEditors, menus, views, viewsContainers, editor/title, piRpc (+1 more)

### Community 26 - "SessionRegistry"
Cohesion: 0.17
Nodes (6): RpcCommand, assistantMessage(), createTransportHarness(), MockTransport, runValidatorWithMutation(), update()

### Community 27 - "mock-pi-child.ts"
Cohesion: 0.31
Nodes (8): commands, entries, handle(), messages, response(), rl, send(), State

### Community 28 - "redactText"
Cohesion: 0.25
Nodes (8): Accepted-send snapshot and recovery, Attachment model, Client-side composer state, Deterministic journey specs, Deterministic transport and preview, Invalidation, persistence, trust, and restart behavior, New Chat, Recovery semantics

### Community 29 - "LOCAL-001 Reconnaissance"
Cohesion: 0.29
Nodes (7): Documentation discrepancies and conservative decisions, LOCAL-001 Reconnaissance, Notable limitations and failure modes, Scope and baseline, Sources read completely, Startup and environment inventory, Trust, packages, and resource behavior

### Community 30 - "Protocol inventory summary"
Cohesion: 0.29
Nodes (7): Documented command set (32), Documented streamed events (17), Extension UI wire methods (9), Local unsupported/degraded `ExtensionUIContext` compatibility surface (19), Protocol inventory summary, State and data types, Wire and process rules

### Community 31 - "properties"
Cohesion: 0.50
Nodes (4): default, description, type, piRpc.allowApproveInTrustedWorkspace

### Community 32 - "files"
Cohesion: 0.29
Nodes (7): files, CHANGELOG.md, dist, LICENSE, media, NOTICE, README.md

### Community 33 - "piRpc.telemetryEnabled"
Cohesion: 0.50
Nodes (4): default, description, type, piRpc.telemetryEnabled

### Community 34 - "Pi RPC VS Code Extension"
Cohesion: 0.29
Nodes (6): Development, Features, Notes, Pi RPC VS Code Extension, Session workflow, Settings

### Community 35 - "piRpc.additionalArgs"
Cohesion: 0.33
Nodes (6): type, default, description, items, type, piRpc.additionalArgs

### Community 36 - "LOCAL-002 — Make Pi RPC session navigation intuitive"
Cohesion: 0.40
Nodes (4): Acceptance criteria, Closure notes, Context, LOCAL-002 — Make Pi RPC session navigation intuitive

### Community 38 - "piRpc.longRunningTimeoutMs"
Cohesion: 0.40
Nodes (5): default, description, minimum, type, piRpc.longRunningTimeoutMs

### Community 39 - "piRpc.maxImageBytes"
Cohesion: 0.40
Nodes (5): default, description, minimum, type, piRpc.maxImageBytes

### Community 40 - "piRpc.maxImagesPerPrompt"
Cohesion: 0.40
Nodes (5): default, description, minimum, type, piRpc.maxImagesPerPrompt

### Community 41 - "piRpc.maxPendingRequests"
Cohesion: 0.40
Nodes (5): default, description, minimum, type, piRpc.maxPendingRequests

### Community 42 - "piRpc.maxQueuedWrites"
Cohesion: 0.40
Nodes (5): default, description, minimum, type, piRpc.maxQueuedWrites

### Community 43 - "piRpc.maxRecordBytes"
Cohesion: 0.40
Nodes (5): default, description, minimum, type, piRpc.maxRecordBytes

### Community 44 - "piRpc.maxRestartAttempts"
Cohesion: 0.40
Nodes (5): default, description, minimum, type, piRpc.maxRestartAttempts

### Community 45 - "piRpc.maxToolOutputChars"
Cohesion: 0.40
Nodes (5): default, description, minimum, type, piRpc.maxToolOutputChars

### Community 46 - "piRpc.maxTranscriptItems"
Cohesion: 0.40
Nodes (5): default, description, minimum, type, piRpc.maxTranscriptItems

### Community 47 - "piRpc.responseTimeoutMs"
Cohesion: 0.40
Nodes (5): default, description, minimum, type, piRpc.responseTimeoutMs

### Community 48 - "Changelog"
Cohesion: 0.29
Nodes (6): 0.0.1, 0.0.2, 0.0.3, 0.0.4, 0.0.5, Changelog

### Community 49 - "LOCAL-001 — Build a comprehensive Pi RPC VS Code extension"
Cohesion: 0.50
Nodes (3): Acceptance criteria, Context, LOCAL-001 — Build a comprehensive Pi RPC VS Code extension

### Community 50 - "piRpc.autoStart"
Cohesion: 0.50
Nodes (4): default, description, type, piRpc.autoStart

### Community 51 - "piRpc.executable"
Cohesion: 0.29
Nodes (7): properties, title, configuration, default, description, type, piRpc.executable

### Community 52 - "piRpc.offline"
Cohesion: 0.50
Nodes (4): default, description, type, piRpc.offline

### Community 53 - "piRpc.restartOnCrash"
Cohesion: 0.50
Nodes (4): default, description, type, piRpc.restartOnCrash

### Community 54 - "dependencies"
Cohesion: 0.67
Nodes (3): markdown-it, dependencies, markdown-it

### Community 55 - "engines"
Cohesion: 0.67
Nodes (3): engines, node, vscode

### Community 56 - "repository"
Cohesion: 0.67
Nodes (3): repository, type, url

### Community 57 - "index.cjs"
Cohesion: 0.24
Nodes (8): vscode, getSettings(), PiRpcSettings, validateAdditionalArgs(), DiagnosticsLogger, SupervisorEvents, renderChatWebviewHtml(), IMAGE_MIME_BY_EXTENSION

### Community 63 - "LOCAL-003 UX redesign — Pi RPC as a simple coding chat"
Cohesion: 0.25
Nodes (8): Current visible element inventory — keep / move / hide / remove, Heuristic audit of current UI, Implementation notes, Inputs reviewed, Interaction and state transitions, LOCAL-003 acceptance criteria to validation map, LOCAL-003 UX redesign — Pi RPC as a simple coding chat, Migration plan from current layout

### Community 64 - "Wireframes"
Cohesion: 0.33
Nodes (6): 1) Empty state, 1b) New Chat confirmation when relevant, 2) Running state, 3) Resume state, 4) Error state, Wireframes

### Community 65 - "Visual, spacing, type, and icon tokens"
Cohesion: 0.33
Nodes (6): Avoid, Icon set, Spacing scale, Type hierarchy, Use, Visual, spacing, type, and icon tokens

### Community 66 - "LOCAL-003 — Simplify Pi RPC into a user-first interface"
Cohesion: 0.40
Nodes (4): Acceptance criteria, Context, LOCAL-003 — Simplify Pi RPC into a user-first interface, Proof

### Community 67 - "Proposed information architecture"
Cohesion: 0.40
Nodes (5): Advanced, Advanced Mode, Chat panel, Proposed information architecture, Sidebar

### Community 68 - "Keyboard, focus, and accessibility"
Cohesion: 0.50
Nodes (4): A11y rules, Focus rules, Keyboard, focus, and accessibility, Keyboard order

### Community 69 - "Narrow, high-contrast, and reduced-motion behavior"
Cohesion: 0.50
Nodes (4): High contrast, Narrow, high-contrast, and reduced-motion behavior, Narrow widths, Reduced motion

### Community 70 - "Usability validation plan"
Cohesion: 0.50
Nodes (4): Inspection and QA checks, Participants, Tasks and measurable success, Usability validation plan

### Community 71 - "Capability preservation map"
Cohesion: 0.67
Nodes (3): Advanced drawer groups, Capability preservation map, Simple Mode promoted commands

### Community 72 - "Component inventory and microcopy"
Cohesion: 0.67
Nodes (3): Advanced drawer sections, Attach menu items, Component inventory and microcopy

### Community 73 - "Outcome"
Cohesion: 0.67
Nodes (3): Default Simple Mode, Design rules, Outcome

### Community 74 - "LOCAL-004 — Pi editor-tab migration plan"
Cohesion: 0.04
Nodes (49): 10. Command and capability mapping, 11. Implementation phases, 12.1 Migration, 12.2 Rollback, 12. Migration and rollback strategy, 13.1 Automated, 13.2 Manual comparison scenarios, 13. Objective acceptance tests (+41 more)

### Community 75 - "Findings by topic"
Cohesion: 0.06
Nodes (29): 10) Advanced disclosure, 11) Contextual editor actions, 12) Status and notifications, 13) Keyboard behavior, 1) Launcher: where Claude enters the workflow, 2) Where chat opens, 3) History / resume location, 4) New / resume interactions (+21 more)

### Community 76 - ".onMessage"
Cohesion: 0.06
Nodes (31): makeId(), relativeWorkspacePath(), boundDiagnosticsContent(), boundFileContent(), buildSendPreview(), canonicalContextLine(), ChatUiMode, cloneComposerState() (+23 more)

### Community 77 - "types.ts"
Cohesion: 0.25
Nodes (11): formatRelativeTimestamp(), RecentSessionRecord, RecentSessionsState, ControllerState, createNewChatSidebarModel(), createResumeChatSidebarModel(), createSessionsSidebarModel(), sessionDisplayName() (+3 more)

### Community 78 - "model.ts"
Cohesion: 0.14
Nodes (13): Bash (>20 lines output), BLOCKED commands — do NOT attempt these, context-mode — MANDATORY routing rules, ctx commands, curl / wget — BLOCKED, Grep (large results), Inline HTTP — BLOCKED, Output constraints (+5 more)

### Community 81 - "rpc-coverage.test.ts"
Cohesion: 0.25
Nodes (8): Implementation phases and gates, P0 — Scaffold and contracts, P1 — Transport and supervisor, P2 — Complete protocol client and reducer, P3 — Native surfaces, P4 — Secure chat webview, P5 — Real Pi integration, P6 — Packaging and release

### Community 82 - "default"
Cohesion: 0.29
Nodes (6): default, description, type, piRpc.editorTabs.enabled, actionIds, coverage

### Community 83 - "ChatUiMode"
Cohesion: 0.40
Nodes (5): Accessibility, Chat, Extension UI mapping, Files and diffs, VS Code surface design

### Community 87 - "State machines"
Cohesion: 0.40
Nodes (5): Agent/workflow, Extension UI, Process/connection, Request lifecycle, State machines

### Community 88 - "activationEvents"
Cohesion: 0.67
Nodes (3): activationEvents, onCustomEditor:piRpc.chatEditor, onStartupFinished

## Knowledge Gaps
- **405 isolated node(s):** `name`, `displayName`, `description`, `version`, `publisher` (+400 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **6 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `properties` connect `piRpc.executable` to `piRpc.telemetryEnabled`, `piRpc.additionalArgs`, `piRpc.longRunningTimeoutMs`, `piRpc.maxImageBytes`, `piRpc.maxImagesPerPrompt`, `piRpc.maxPendingRequests`, `piRpc.maxQueuedWrites`, `piRpc.maxRecordBytes`, `piRpc.maxRestartAttempts`, `piRpc.maxToolOutputChars`, `piRpc.maxTranscriptItems`, `piRpc.responseTimeoutMs`, `default`, `piRpc.autoStart`, `piRpc.offline`, `RegistryTreeProvider`, `piRpc.restartOnCrash`, `properties`?**
  _High betweenness centrality (0.120) - this node is a cross-community bridge._
- **Why does `default` connect `default` to `DiagnosticsLogger`, `ChatPanelProvider`?**
  _High betweenness centrality (0.111) - this node is a cross-community bridge._
- **Why does `piRpc.editorTabs.enabled` connect `default` to `piRpc.executable`?**
  _High betweenness centrality (0.110) - this node is a cross-community bridge._
- **Are the 4 inferred relationships involving `activate()` (e.g. with `.health()` and `.resource()`) actually correct?**
  _`activate()` has 4 INFERRED edges - model-reasoned connections that need verification._
- **What connects `name`, `displayName`, `description` to the rest of the system?**
  _405 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `JsonObject` be split into smaller, more focused modules?**
  _Cohesion score 0.14126984126984127 - nodes in this community are weakly interconnected._
- **Should `activate` be split into smaller, more focused modules?**
  _Cohesion score 0.06016929764355983 - nodes in this community are weakly interconnected._