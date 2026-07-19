# Graph Report - feat-pi-rpc-vscode  (2026-07-19)

## Corpus Check
- 72 files · ~57,072 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 958 nodes · 2069 edges · 74 communities (71 shown, 3 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 24 edges (avg confidence: 0.75)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `4f4d54dd`
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

## God Nodes (most connected - your core abstractions)
1. `SessionController` - 107 edges
2. `activate()` - 82 edges
3. `JsonObject` - 53 edges
4. `RpcClient` - 49 edges
5. `ChatUiState` - 41 edges
6. `RpcTransport` - 28 edges
7. `ExtensionUiRequest` - 22 edges
8. `LocalExtensionUiContext` - 22 edges
9. `ChatPanelProvider` - 22 edges
10. `SessionRegistry` - 20 edges

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

## Communities (74 total, 3 thin omitted)

### Community 0 - "JsonObject"
Cohesion: 0.15
Nodes (3): RpcClient, JsonObject, SessionState

### Community 1 - "activate"
Cohesion: 0.06
Nodes (8): activate(), ExtensionUiRequest, SessionController, resetControllerProjection(), ExtensionUiBroker, LOCAL_THEME, LocalExtensionUiContext, UnsupportedThemeResult

### Community 2 - "protocol.ts"
Cohesion: 0.06
Nodes (65): JsonValue, ModelInfo, QueueState, appendBlockText(), applyAssistantDelta(), asObject(), asStringArray(), ensureContentBlock() (+57 more)

### Community 3 - "recentSessions.ts"
Cohesion: 0.06
Nodes (38): asObject(), buildRecentSessionRecord(), compareRecentSessionRecordTimestamps(), extractTextContent(), filterRecentSessions(), formatRelativeTimestamp(), getAgentDir(), getDefaultSessionDirForWorkspace() (+30 more)

### Community 4 - "LOCAL-001 Implementation Plan"
Cohesion: 0.07
Nodes (28): Accessibility, Agent/workflow, Chat, Definition of done, Diagnostics and observability, Extension UI, Extension UI mapping, Files and diffs (+20 more)

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
Cohesion: 0.09
Nodes (22): vscode, COMMAND_IDS, CONTRIBUTED_COMMANDS, ContributedCommand, getSettings(), PiRpcSettings, validateAdditionalArgs(), createRedactedDiagnosticsExport() (+14 more)

### Community 9 - "render.ts"
Cohesion: 0.12
Nodes (31): canonicalizeSessionPath(), chipPrivacyLabel(), summarizeChip(), applyFocus(), focusElement(), handlePreviewKeydown(), postMessage(), queueFocus() (+23 more)

### Community 10 - "providers.ts"
Cohesion: 0.16
Nodes (3): RpcTransport, TypedEmitter, runValidatorWithMutation()

### Community 11 - "extension.ts"
Cohesion: 0.18
Nodes (11): RpcClientOptions, RpcCommandType, RpcEvent, RpcResponse, createRequestId(), PendingRequest, RpcTransportEvents, RpcTransportOptions (+3 more)

### Community 12 - "ChatPanelProvider"
Cohesion: 0.08
Nodes (22): boundFileContent(), canonicalSessionKey(), ChatUiMode, cloneComposerState(), ComposerSessionState, fingerprint(), PendingContextItem, PendingImageItem (+14 more)

### Community 13 - "Manual Acceptance and VSIX Smoke Plan"
Cohesion: 0.13
Nodes (15): Accessibility and UX, Build and package gate, Extension UI walkthrough, Final acceptance record, Full command matrix walkthrough, Images, files, diffs, editor context, diagnostics, LOCAL-003 acceptance addendum, Local unsupported/degraded `ExtensionUIContext` compatibility walkthrough (+7 more)

### Community 14 - "package.json"
Cohesion: 0.14
Nodes (13): activationEvents, description, displayName, extensionKind, icon, license, main, name (+5 more)

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
Cohesion: 0.22
Nodes (14): asOptionalString(), asRecord(), asString(), asStringArray(), COMMAND_TYPES, EVENT_TYPES, isJsonObject(), isJsonValue() (+6 more)

### Community 20 - "RecentSessionService"
Cohesion: 0.29
Nodes (6): shutdown(), SpawnedRpc, spawnMockPi(), spawnRealPi(), execFileAsync, nextTick()

### Community 21 - "RegistryTreeProvider"
Cohesion: 0.20
Nodes (9): default, description, enum, type, piRpc.defaultViewMode, advanced, simple, actionIds (+1 more)

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
Nodes (9): contributes, commands, menus, views, viewsContainers, view/item/context, view/title, piRpc (+1 more)

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
Cohesion: 0.40
Nodes (4): 0.0.1, 0.0.2, 0.0.3, Changelog

### Community 49 - "LOCAL-001 — Build a comprehensive Pi RPC VS Code extension"
Cohesion: 0.50
Nodes (3): Acceptance criteria, Context, LOCAL-001 — Build a comprehensive Pi RPC VS Code extension

### Community 50 - "piRpc.autoStart"
Cohesion: 0.29
Nodes (7): properties, title, configuration, default, description, type, piRpc.autoStart

### Community 51 - "piRpc.executable"
Cohesion: 0.50
Nodes (4): default, description, type, piRpc.executable

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

## Knowledge Gaps
- **320 isolated node(s):** `name`, `displayName`, `description`, `version`, `publisher` (+315 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **3 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `properties` connect `piRpc.autoStart` to `piRpc.telemetryEnabled`, `piRpc.additionalArgs`, `piRpc.longRunningTimeoutMs`, `piRpc.maxImageBytes`, `piRpc.maxImagesPerPrompt`, `piRpc.maxPendingRequests`, `piRpc.maxQueuedWrites`, `piRpc.maxRecordBytes`, `piRpc.maxRestartAttempts`, `piRpc.maxToolOutputChars`, `piRpc.maxTranscriptItems`, `piRpc.responseTimeoutMs`, `piRpc.executable`, `piRpc.offline`, `RegistryTreeProvider`, `piRpc.restartOnCrash`, `properties`?**
  _High betweenness centrality (0.122) - this node is a cross-community bridge._
- **Why does `default` connect `RegistryTreeProvider` to `DiagnosticsLogger`?**
  _High betweenness centrality (0.110) - this node is a cross-community bridge._
- **Why does `piRpc.defaultViewMode` connect `RegistryTreeProvider` to `piRpc.autoStart`?**
  _High betweenness centrality (0.108) - this node is a cross-community bridge._
- **Are the 3 inferred relationships involving `activate()` (e.g. with `.health()` and `.command()`) actually correct?**
  _`activate()` has 3 INFERRED edges - model-reasoned connections that need verification._
- **What connects `name`, `displayName`, `description` to the rest of the system?**
  _320 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `JsonObject` be split into smaller, more focused modules?**
  _Cohesion score 0.146218487394958 - nodes in this community are weakly interconnected._
- **Should `activate` be split into smaller, more focused modules?**
  _Cohesion score 0.06478578892371996 - nodes in this community are weakly interconnected._