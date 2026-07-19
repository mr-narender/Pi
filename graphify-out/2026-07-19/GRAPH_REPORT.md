# Graph Report - feat-pi-rpc-vscode  (2026-07-19)

## Corpus Check
- 66 files · ~44,255 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 813 nodes · 1624 edges · 63 communities (59 shown, 4 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 21 edges (avg confidence: 0.76)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `d18dc0f2`
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

## God Nodes (most connected - your core abstractions)
1. `activate()` - 78 edges
2. `SessionController` - 76 edges
3. `JsonObject` - 53 edges
4. `RpcClient` - 49 edges
5. `RpcTransport` - 28 edges
6. `ExtensionUiRequest` - 22 edges
7. `LocalExtensionUiContext` - 22 edges
8. `SessionRegistry` - 19 edges
9. `ChatPanelProvider` - 16 edges
10. `DiagnosticsLogger` - 15 edges

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

## Communities (63 total, 4 thin omitted)

### Community 0 - "JsonObject"
Cohesion: 0.05
Nodes (25): RpcClient, RpcClientOptions, JsonObject, RpcCommand, RpcCommandType, RpcEvent, RpcResponse, SessionState (+17 more)

### Community 1 - "activate"
Cohesion: 0.07
Nodes (8): activate(), ExtensionUiRequest, SessionController, resetControllerProjection(), ExtensionUiBroker, LOCAL_THEME, LocalExtensionUiContext, UnsupportedThemeResult

### Community 2 - "protocol.ts"
Cohesion: 0.05
Nodes (67): asOptionalString(), asRecord(), asString(), asStringArray(), COMMAND_TYPES, EVENT_TYPES, isJsonObject(), isJsonValue() (+59 more)

### Community 3 - "recentSessions.ts"
Cohesion: 0.10
Nodes (30): asObject(), buildRecentSessionRecord(), compareRecentSessionRecordTimestamps(), extractTextContent(), formatRelativeTimestamp(), getAgentDir(), getDefaultSessionDirForWorkspace(), getMessageActivityTime() (+22 more)

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
Cohesion: 0.16
Nodes (3): DiagnosticsLogger, PiProcessSupervisor, TypedEmitter

### Community 9 - "render.ts"
Cohesion: 0.20
Nodes (17): bindForm(), bindForms(), postMessage(), render(), root, vscode, connectionSummary(), escapeHtml() (+9 more)

### Community 10 - "providers.ts"
Cohesion: 0.15
Nodes (8): BasicItem, DiagnosticsTreeProvider, entryLabel(), HelpTreeProvider, nodeToTreeItem(), OutlineTreeProvider, createHelpSidebarModel(), SidebarNode

### Community 11 - "extension.ts"
Cohesion: 0.17
Nodes (10): COMMAND_IDS, CONTRIBUTED_COMMANDS, ContributedCommand, asRecord(), asString(), recentRequests(), ensureTrustedForMutation(), ensureWorkspaceAvailable() (+2 more)

### Community 13 - "Manual Acceptance and VSIX Smoke Plan"
Cohesion: 0.14
Nodes (14): Accessibility and UX, Build and package gate, Extension UI walkthrough, Final acceptance record, Full command matrix walkthrough, Images, files, diffs, editor context, diagnostics, Local unsupported/degraded `ExtensionUIContext` compatibility walkthrough, Manual Acceptance and VSIX Smoke Plan (+6 more)

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
Cohesion: 0.27
Nodes (3): summarizeModel(), summarizeQueue(), StatusBarController

### Community 19 - "sessionController.ts"
Cohesion: 0.41
Nodes (5): vscode, getSettings(), PiRpcSettings, validateAdditionalArgs(), SupervisorEvents

### Community 20 - "RecentSessionService"
Cohesion: 0.24
Nodes (3): filterRecentSessions(), RecentSessionService, SessionsTreeProvider

### Community 21 - "RegistryTreeProvider"
Cohesion: 0.20
Nodes (3): QueueTreeProvider, RegistryTreeProvider, WorkflowTreeProvider

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
Cohesion: 0.36
Nodes (5): createRedactedDiagnosticsExport(), redactJsonValue(), redactText(), SECRET_PATTERNS, compatibilityEvents()

### Community 29 - "LOCAL-001 Reconnaissance"
Cohesion: 0.29
Nodes (7): Documentation discrepancies and conservative decisions, LOCAL-001 Reconnaissance, Notable limitations and failure modes, Scope and baseline, Sources read completely, Startup and environment inventory, Trust, packages, and resource behavior

### Community 30 - "Protocol inventory summary"
Cohesion: 0.29
Nodes (7): Documented command set (32), Documented streamed events (17), Extension UI wire methods (9), Local unsupported/degraded `ExtensionUIContext` compatibility surface (19), Protocol inventory summary, State and data types, Wire and process rules

### Community 31 - "properties"
Cohesion: 0.29
Nodes (7): properties, title, configuration, default, description, type, piRpc.allowApproveInTrustedWorkspace

### Community 32 - "files"
Cohesion: 0.29
Nodes (7): files, CHANGELOG.md, dist, LICENSE, media, NOTICE, README.md

### Community 33 - "piRpc.telemetryEnabled"
Cohesion: 0.29
Nodes (6): default, description, type, piRpc.telemetryEnabled, actionIds, coverage

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
Cohesion: 0.50
Nodes (3): 0.0.1, 0.0.2, Changelog

### Community 49 - "LOCAL-001 — Build a comprehensive Pi RPC VS Code extension"
Cohesion: 0.50
Nodes (3): Acceptance criteria, Context, LOCAL-001 — Build a comprehensive Pi RPC VS Code extension

### Community 50 - "piRpc.autoStart"
Cohesion: 0.50
Nodes (4): default, description, type, piRpc.autoStart

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

## Knowledge Gaps
- **269 isolated node(s):** `name`, `displayName`, `description`, `version`, `publisher` (+264 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **4 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `properties` connect `properties` to `piRpc.telemetryEnabled`, `piRpc.additionalArgs`, `piRpc.longRunningTimeoutMs`, `piRpc.maxImageBytes`, `piRpc.maxImagesPerPrompt`, `piRpc.maxPendingRequests`, `piRpc.maxQueuedWrites`, `piRpc.maxRecordBytes`, `piRpc.maxRestartAttempts`, `piRpc.maxToolOutputChars`, `piRpc.maxTranscriptItems`, `piRpc.responseTimeoutMs`, `piRpc.autoStart`, `piRpc.executable`, `piRpc.offline`, `piRpc.restartOnCrash`?**
  _High betweenness centrality (0.142) - this node is a cross-community bridge._
- **Why does `default` connect `piRpc.telemetryEnabled` to `extension.ts`?**
  _High betweenness centrality (0.121) - this node is a cross-community bridge._
- **Why does `piRpc.telemetryEnabled` connect `piRpc.telemetryEnabled` to `properties`?**
  _High betweenness centrality (0.118) - this node is a cross-community bridge._
- **Are the 3 inferred relationships involving `activate()` (e.g. with `.health()` and `.command()`) actually correct?**
  _`activate()` has 3 INFERRED edges - model-reasoned connections that need verification._
- **What connects `name`, `displayName`, `description` to the rest of the system?**
  _269 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `JsonObject` be split into smaller, more focused modules?**
  _Cohesion score 0.05054945054945055 - nodes in this community are weakly interconnected._
- **Should `activate` be split into smaller, more focused modules?**
  _Cohesion score 0.06827309236947791 - nodes in this community are weakly interconnected._