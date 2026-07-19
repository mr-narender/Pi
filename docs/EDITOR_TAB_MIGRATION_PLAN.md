# LOCAL-004 — Pi editor-tab migration plan

Status: planning only
Owner: pi
Source inputs: [CLAUDE_CODE_PATTERN_ANALYSIS.md](./CLAUDE_CODE_PATTERN_ANALYSIS.md), current Pi `0.0.3` source, [RPC_COVERAGE.md](./RPC_COVERAGE.md)

## 1. Scope and non-goals

This plan converts the verified Claude interaction findings into an implementation-ready Pi architecture plan without claiming exact Claude visual parity.

Hard constraints:

- Preserve Pi RPC semantics: one Pi RPC controller/process per workspace folder, authoritative `new_session` / `switch_session` / event behavior, no invented authenticated Claude behavior.
- Preserve drafts, chips, accepted-send snapshots, extension UI dialogs, advanced commands, trust/security rules, and the full 90-row coverage matrix.
- Sidebar becomes a minimal launcher/history surface.
- The main chat surface becomes a stable center-editor tab surface.
- Multi-tab and multi-root behavior must stay isolated.
- No telemetry additions.

## 2. Verified pattern input we may transfer

From [CLAUDE_CODE_PATTERN_ANALYSIS.md](./CLAUDE_CODE_PATTERN_ANALYSIS.md), only these verified patterns are mandatory inputs:

1. editor-native launcher/open/focus behavior;
2. editor tab/panel as the default host;
3. multiple concurrent chat tabs;
4. in-surface new/resume/history affordances;
5. contextual editor affordances (`@`/selection/current file/diff actions).

Explicitly **not** copied as requirements:

- exact Claude authenticated layout, copy, loading/error states, metadata fields, or exact tab-title rules;
- exact visual styling or proprietary assets.

## 3. Current Pi baseline

Current Pi `0.0.3` is already partly editor-hosted, but structurally wrong for LOCAL-004:

- `src/webview/provider.ts` owns a single reusable `vscode.WebviewPanel` (`this.panel`).
- session identity is controller-level, not tab-level;
- `src/extension.ts` commands operate on the active workspace controller, then reveal the one shared panel;
- sidebar trees are the primary IA for new/resume/current chat;
- drafts/chips persist per workspace+session key in `ChatUiState`, which is reusable in the new architecture.

Result: Pi has one shared chat panel, not “conversation as editor object”.

## 4. VS Code host decision: use a custom readonly editor for canonical chat tabs

### 4.1 API proof

VS Code API types in `node_modules/@types/vscode/index.d.ts` confirm:

- `WebviewPanelSerializer` can revive webview panels across restart: “When the editor is shutdown, it will save off the state ... When the webview first becomes visible after the restart, this state is passed to `deserializeWebviewPanel`.”
- `window.registerWebviewPanelSerializer(viewType, serializer)` exists for panel revival.
- `CustomReadonlyEditorProvider.openCustomDocument(uri, ...)` and `resolveCustomEditor(document, webviewPanel, ...)` give URI-backed editor lifecycle.
- already-open custom documents are re-used for the same resource.
- `CustomTextEditorProvider` is for text resources and requires syncing edits with a `TextDocument`.
- editable `CustomEditorProvider` adds save/revert/backup/dirty semantics.

### 4.2 Chosen architecture

Use **`CustomReadonlyEditorProvider`** for canonical Pi chat tabs.

Why this, not plain `WebviewPanel`:

- stable per-session tab identity is URI-native instead of a manual panel registry;
- open/reveal/dedup is driven by resource identity;
- close/reopen and window restore use normal editor reopening behavior;
- default custom-editor behavior gives one editor instance per resource unless `supportsMultipleEditorsPerDocument` is explicitly enabled, which matches the planned dedup rule;
- no fake save/dirty semantics are introduced for chat sessions;
- better fit for “conversation as editor object”.

Why not `CustomTextEditorProvider`:

- Pi chat is not a text-document editor;
- transcript/composer/chips are not meant to become user-saved `TextDocument` content;
- it would create misleading undo/save expectations.

Why not editable `CustomEditorProvider`:

- chat sessions should not become dirty documents with save/revert prompts.

### 4.3 Fallback rule

If a later spike proves custom-editor URI ergonomics unacceptable, fallback is:

- `WebviewPanel` + `WebviewPanelSerializer`,
- with an explicit manual session-tab registry.

This is a fallback only; the primary plan remains `CustomReadonlyEditorProvider`.

## 5. Target architecture

### 5.1 High-level model

```text
Sidebar = launcher/history only
Editor tab = actual chat/session surface
Controller = one live Pi process per workspace folder
Tab document = one canonical session identity (or one workspace draft slot)
```

Per workspace folder:

- one `SessionController` remains the authoritative Pi RPC owner;
- many editor tabs may exist for that folder;
- only one session can be live-attached to the controller at a time;
- background tabs show cached state;
- focusing/revealing a tab for another session switches the controller to that tab's session, then reconciles.

This preserves Pi semantics while delivering multi-tab UX.

### 5.2 New module boundaries

Planned new modules:

- `src/editorTabs/uri.ts` — canonical URI construction/parsing
- `src/editorTabs/document.ts` — chat document identity model
- `src/editorTabs/provider.ts` — `CustomReadonlyEditorProvider`
- `src/editorTabs/tabManager.ts` — open/reveal/replace/close bookkeeping
- `src/editorTabs/sessionCache.ts` — cached per-tab snapshot/view state
- `src/editorTabs/commands.ts` — tab-aware command helpers

Planned reused modules:

- `src/webview/render.ts`
- `src/webview/model.ts`
- `src/webview/messages.ts`
- `src/webview/composer.ts`
- `src/webview/composerState.ts`
- `src/ui/extensionUiBroker.ts`
- `src/sessions/recentSessionService.ts`
- `src/sessions/sessionRegistry.ts`
- `src/sessions/sessionController.ts`

Planned legacy module retained during rollout:

- `src/webview/provider.ts` as rollback path until final cutover.

## 6. Data model

### 6.1 Canonical tab identity

`ChatTabTarget`

- `workspaceFolderUri: string`
- `kind: 'workspaceDraft' | 'sessionFile' | 'sessionId'`
- `sessionFile?: string`
- `sessionId?: string`

Identity precedence:

1. `sessionFile`
2. `sessionId`
3. workspace draft slot

This matches existing `canonicalSessionKey(...)` behavior in `src/webview/composer.ts` and keeps draft/chip persistence compatible.

### 6.2 URI scheme

Recommended scheme: `pi-chat:`

Canonical forms:

- draft tab: `pi-chat:/<workspaceKey>/draft.chat`
- session file tab: `pi-chat:/<workspaceKey>/session-file/<encoded>.chat`
- session id tab: `pi-chat:/<workspaceKey>/session-id/<encoded>.chat`

Rules:

- `workspaceKey` is a deterministic encoded form of `workspaceFolder.uri.toString()`;
- session values are encoded, not raw labels;
- URI identity is stable; titles are separate.

### 6.3 Per-tab cached state

`ChatTabState`

- `target: ChatTabTarget`
- `resource: vscode.Uri`
- `lastKnownTitle: string`
- `lastKnownDescription?: string`
- `lastSnapshot?: WebviewSnapshot`
- `lastViewedAt: number`
- `isLiveBound: boolean`
- `pendingRevealFocus: 'composer' | 'transcript' | 'none'`
- `viewStateVersion: number`

### 6.4 Per-workspace live binding

`WorkspaceLiveChatBinding`

- `workspaceFolderUri: string`
- `activeResource?: string`
- `activeSessionFile?: string`
- `activeSessionId?: string`
- `draftResource: string`

This is the bridge between one controller and many tabs.

### 6.5 Persisted local-only state

Persist locally only:

- tab resource URIs / last-open ordering
- draft/chip state through existing `ChatUiState`
- last cached safe snapshot metadata
- focus target
- recent live binding info

Do **not** persist:

- prompt payloads beyond existing accepted-send rules
- base64 image bytes across restart
- hidden transcript secrets outside existing bounded snapshot rules
- telemetry

## 7. Tab rules

### 7.1 Title rules

Tab title priority:

1. explicit Pi title from `setTitle`
2. `sessionName`
3. basename of `sessionFile`
4. `workspaceFolderName + ' Chat'`
5. `New Chat`

Notes:

- title is display only;
- URI never changes because of rename;
- no claim of Claude title parity.

### 7.2 Dedup rules

- Same canonical resource URI => reveal existing tab, do not open another.
- Different canonical session URIs => separate tabs.
- One draft tab per workspace folder.
- `newSession` from an existing session opens/reveals the workspace draft/new tab first, then promotes it to the new canonical session URI on success.
- `switchSession`/history selection reveals an existing tab if already open; otherwise opens it.

### 7.3 Draft-to-session promotion

When `new_session`, `fork`, `clone`, or first authoritative session identity appears:

1. compute new canonical URI;
2. migrate draft/chip/view state from draft resource to canonical resource;
3. if canonical tab already exists, merge safe transient state and reveal canonical tab;
4. close the draft editor resource.

### 7.4 Close / reopen behavior

- Closing a tab closes only the editor UI, not the Pi process.
- Closed session tabs remain resumable via sidebar history, native Reopen Closed Editor, or current-session reveal commands.
- Reopening a closed tab restores cached snapshot + persisted draft/chips, then rebinds live on reveal.
- Closing the last Pi tab for a workspace does not discard session state.

### 7.5 Window reload / revival behavior

Primary path:

- open custom-editor chat resources are reopened by VS Code using the same resource URIs;
- provider rebuilds HTML and rehydrates from local state;
- when revealed, the tab requests reconcile/live binding.

Safety rule:

- reload must not auto-resend prompts;
- reload must not restore base64 images;
- if Pi is not running, revived tabs show reconnect/start affordance instead of silently starting unless the existing Pi startup policy explicitly allows it.

## 8. Session lifecycle with one controller per workspace

This is the key Pi-specific rule.

### 8.1 Live vs cached tabs

For a given workspace folder:

- exactly one tab is the live-attached session at a time;
- non-visible same-workspace tabs are cached snapshots;
- focusing another same-workspace session tab triggers `switch_session` if needed;
- once switched, that tab becomes live and prior same-workspace tabs become cached.

### 8.2 Session-changing operations

| Operation                       | Tab behavior                                                                       |
| ------------------------------- | ---------------------------------------------------------------------------------- |
| `New Chat`                      | open/reveal draft tab, run `new_session`, promote tab to new canonical session     |
| `Resume Chat`                   | open/reveal target session tab; on reveal, `switch_session` if not already current |
| `Fork`                          | open new branch tab from current session, promote to new canonical branch session  |
| `Clone`                         | open new duplicate tab, promote to cloned session                                  |
| Rename                          | same URI, update title only                                                        |
| Export / stats / tree / entries | stay attached to owning tab's session                                              |

### 8.3 Multi-root isolation

- Each workspace folder keeps its own controller, draft slot, recent history state, statuses, widgets, and active tab binding.
- Focusing a tab from folder A must never mutate folder B.
- Sidebar workspace picking still applies where commands are invoked without an owning tab.

## 9. Sidebar and editor surface changes

### 9.1 Sidebar target IA

Keep the Activity Bar container, but reduce it to launcher/history:

- `New Chat`
- `Resume Chat`
- `Current Chat`

Target behavior:

- `New Chat`: primary action only, plus lightweight draft warning/current workspace info.
- `Resume Chat`: search, refresh, recent items; selecting an item opens/reveals its editor tab.
- `Current Chat`: current workspace/session/model/status summary and `Open Current Chat`.

No transcript, tools, queue, or dense diagnostics live primarily in the sidebar.

### 9.2 In-editor target IA

Editor tab surface owns:

- transcript
- composer
- chips/attachments
- send/stop
- model selector
- in-surface `New` and `History`
- tools/diffs/context
- widgets/status summary
- advanced controls/drawer

### 9.3 Editor title / keybindings

Add transferable launcher behavior:

- editor/title command to open/reveal current Pi chat tab;
- editor/title command to open a new Pi chat tab;
- contextual focus/blur keybinding plan;
- keep keybindings setting-gated if needed to avoid conflicts.

## 10. Command and capability mapping

No existing `piRpc.` command ID is removed for this migration. Surface changes only.

| Coverage / capability                                                                 | Current main surface                 | Target main surface                                                      |
| ------------------------------------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------ |
| `C-001`–`C-004` prompt/steer/follow-up/abort                                          | shared panel + commands              | active editor tab composer/footer + commands                             |
| `C-005`, `C-023`–`C-030` session lifecycle/history/tree/name/export                   | sidebar + quick picks + shared panel | sidebar launcher/history + in-editor `New`/`History`/advanced + commands |
| `C-006`–`C-007`, `E-001`–`E-020`, `D-001`–`D-008` transcript/state/events/data shapes | shared panel                         | owning editor tab snapshot/cache/live bind                               |
| `C-008`–`C-014` model/thinking/queue modes                                            | commands + advanced panel            | editor header model button + advanced drawer + commands                  |
| `C-015`–`C-022` compaction/retry/bash/stats/export                                    | advanced panel + commands            | advanced drawer + commands                                               |
| `C-031`–`C-034` Pi commands / diagnostics / response failures                         | advanced panel + commands            | advanced drawer + commands                                               |
| `U-001`–`U-005` dialogs/notify                                                        | native VS Code dialogs               | unchanged native dialogs, routed from owning tab/controller              |
| `U-006` keyed status                                                                  | status bar                           | unchanged status bar, plus owning-tab summary if already rendered        |
| `U-007` widget                                                                        | chat webview                         | owning editor tab                                                        |
| `U-008` title                                                                         | shared panel title                   | owning editor tab title                                                  |
| `U-009` set editor text                                                               | shared panel composer                | owning editor tab composer                                               |
| `X-001`–`X-019` local compatibility behaviors                                         | commands + local broker              | unchanged semantics; surfaced from owning tab where relevant             |
| draft/chip persistence, stale refs, accepted-send recovery                            | shared panel state                   | unchanged logic, keyed by canonical tab/session identity                 |
| trust/security                                                                        | shared panel + commands              | unchanged rules across sidebar/editor-tab surfaces                       |

Acceptance rule: [RPC_COVERAGE.md](./RPC_COVERAGE.md) remains 90 named rows with unchanged row ids and contributed command ids.

## 11. Implementation phases

Each phase is independently testable and reversible.

### Phase 0 — Contracts and spike proof

Deliverables:

- architecture spike doc inside code comments/tests proving custom readonly editor open/reopen path;
- final URI scheme contract;
- feature flag plan: `piRpc.editorTabs.enabled` default `false` during rollout.

Red tests first:

- `editorTabs.api.customReadonlyDecision`
- `editorTabs.uri.parseRoundTrip`
- `editorTabs.coverage.rowsUnchanged`

Implementation boundary:

- no user-visible surface changes yet;
- no command routing changes yet.

Rollback:

- none needed; docs/tests only.

### Phase 1 — Editor resource and provider scaffold

Deliverables:

- `CustomReadonlyEditorProvider`
- custom-editor manifest contribution
- tab URI parser/builder
- minimal editor tab that renders existing chat HTML from mock snapshot

Red tests first:

- `editorTabs.manifest.customEditorContribution`
- `editorTabs.provider.opensResource`
- `editorTabs.provider.reusesSameResource`
- `editorTabs.provider.windowReloadReopensResource`

Implementation boundary:

- keep legacy `ChatPanelProvider` default path;
- new provider hidden behind flag/internal open command.

Rollback:

- turn flag off.

### Phase 2 — Tab manager and command targeting

Deliverables:

- `ChatTabManager` for open/reveal/replace/close
- tab-aware command target resolution
- `piRpcInternal.openChat` retargeted to current editor tab path when flag is on

Red tests first:

- `editorTabs.open.revealExistingSession`
- `editorTabs.open.oneDraftPerWorkspace`
- `editorTabs.open.multiRootIsolation`
- `editorTabs.command.prefersOwningTabContext`

Implementation boundary:

- sidebar still unchanged visually;
- transcript may still mirror current shared-panel logic.

Rollback:

- disable flag and restore `ChatPanelProvider` command path.

### Phase 3 — Session lifecycle on top of tabs

Deliverables:

- draft-to-session promotion
- focus-on-tab => live `switch_session` binding
- new/resume/fork/clone open proper tabs instead of mutating one shared panel
- per-tab cached snapshot store

Red tests first:

- `editorTabs.newSession.opensNewCanonicalTab`
- `editorTabs.resumeHistory.revealsOrOpens`
- `editorTabs.focus.switchesOwningControllerSession`
- `editorTabs.forkAndClone.createIndependentTabs`
- `editorTabs.close.reopenRestoresDraftNoImages`

Implementation boundary:

- session-changing commands fully tab-aware;
- legacy panel still available behind flag-off rollback.

Rollback:

- disable flag.

### Phase 4 — Move primary UX into editor tab

Deliverables:

- in-tab `New` and `History`
- in-tab transcript/composer/tools/diffs/context as canonical surface
- sidebar reduced to launcher/history only
- editor/title launcher contributions and keybindings

Red tests first:

- `editorTabs.render.headerHasNewHistoryModelMore`
- `editorTabs.sidebar.resumeOpensEditorTab`
- `editorTabs.editorTitle.openCurrent`
- `editorTabs.accessibility.focusRestorationAcrossTabOps`
- `editorTabs.diffAndWidget.surfaceInsideEditor`

Implementation boundary:

- users can complete all primary chat flows without relying on the legacy panel.

Rollback:

- flag off returns to old panel/sidebar behavior.

### Phase 5 — Revival, trust, extension UI, and parity hardening

Deliverables:

- reload/revive flow
- native reopen-closed behavior validation
- extension UI request routing to owning tab
- trust/restricted-mode banners in revived/cached tabs
- performance tuning for many tabs

Red tests first:

- `editorTabs.revive.restoresOpenEditors`
- `editorTabs.revive.noPromptReplay`
- `editorTabs.extensionUi.routesToOwningTab`
- `editorTabs.trust.reviveInRestrictedMode`
- `editorTabs.performance.backgroundTabsUseCachedSnapshots`

Implementation boundary:

- feature flag can flip to default-on after parity passes.

Rollback:

- keep legacy provider until this phase is green on packaged VSIX.

### Phase 6 — Cutover and legacy removal

Deliverables:

- flag default-on, then remove legacy shared-panel code after soak period
- packaged VSIX validation
- docs/manual acceptance updates

Red tests first:

- `editorTabs.cutover.noLegacyOpenPath`
- `editorTabs.vsix.installsAndRestoresTabs`
- `editorTabs.coverage.90RowsStillPass`

Implementation boundary:

- final removal only after independent review.

Rollback:

- last safe release keeps legacy path; do not remove legacy code until packaged rollback is proven.

## 12. Migration and rollback strategy

### 12.1 Migration

1. add custom editor in parallel;
2. keep legacy panel as default;
3. move commands to a tab-aware abstraction;
4. move sidebar actions to open/reveal tabs;
5. flip default only after parity + revive + VSIX tests;
6. remove legacy panel last.

### 12.2 Rollback

Rollback switch during implementation:

- `piRpc.editorTabs.enabled = false`
- `piRpcInternal.openChat` and related entry points route back to `ChatPanelProvider`
- sidebar remains functional in both modes

Rollback release rule:

- do not delete `ChatPanelProvider` until one packaged release has shipped with editor tabs as default and reopen/revive/manual tests pass.

## 13. Objective acceptance tests

Final acceptance must include these objective checks.

### 13.1 Automated

1. **Manifest**
   - custom editor contribution exists;
   - editor/title launcher exists;
   - legacy command ids remain contributed;
   - RPC coverage row totals remain unchanged.
2. **URI identity**
   - same session => same URI => reveal existing tab;
   - different sessions => different URIs => separate tabs;
   - same session names in different roots stay isolated.
3. **Session lifecycle**
   - `newSession`, `switchSession`, `forkSession`, `cloneSession` open/reveal correct tabs;
   - focusing a cached same-root tab triggers exactly one `switch_session` when needed;
   - rename updates title without changing URI.
4. **Close/reopen/revive**
   - closing a tab does not stop Pi;
   - reopening restores cached snapshot and draft/chips;
   - reload restores open editor tabs;
   - base64 images do not survive restart;
   - no prompt auto-replay occurs.
5. **Extension UI / trust**
   - all `U-*` and `X-*` rows still pass from an owning tab context;
   - restricted mode blocks mutable actions in both fresh and revived tabs.
6. **Accessibility**
   - keyboard-only new/resume/send/close/reopen flows pass;
   - focus restoration works after history open, new chat, preview modal, and native dialogs.
7. **Performance**
   - opening many recent-session tabs does not multiply live controller listeners uncontrollably;
   - hidden tabs repaint from cache on reveal;
   - transcript bounds stay enforced.

### 13.2 Manual comparison scenarios

1. **Launcher parity scenario**
   - from a normal code editor, use editor-title Pi launcher to open/reveal chat.
2. **New chat scenario**
   - from an existing session tab, click `New`; verify old session remains its own tab and new session gets a new tab.
3. **History scenario**
   - open `History` in-tab or choose a recent item in the sidebar; verify it reveals existing tab or opens a new one.
4. **Multi-tab same workspace scenario**
   - keep two same-root sessions open; switch focus between them; verify Pi session binding follows focus and drafts stay with the correct tab.
5. **Multi-root scenario**
   - keep chats open for two workspace folders; verify no cross-root state leakage.
6. **Reload scenario**
   - reload window with multiple Pi tabs open; verify tabs return, drafts/chips return, images require reselection, and no send is replayed.
7. **Extension UI scenario**
   - run rpc-demo style flows; verify dialogs, widgets, title changes, and draft injection affect the owning tab.
8. **Trust/security scenario**
   - reopen a tab in restricted mode; verify mutable actions remain blocked and messaging is explicit.
9. **Advanced capability scenario**
   - verify every advanced command remains reachable from the tab surface or unchanged command ids.

## 14. Explicit implementation boundaries

Must change:

- tab identity and open/reveal lifecycle
- command targeting
- sidebar role
- editor-title launcher
- revive/reopen behavior

Must not change semantically:

- Pi RPC wire shapes
- accepted-send snapshot behavior
- draft/chip invalidation rules
- extension UI method semantics
- trust/security gates
- 90-row coverage inventory
- telemetry policy

## 15. Packaging and release gates

Before cutover:

- package VSIX with custom-editor contributions;
- run install/reload/reopen smoke in isolated profile;
- verify no additional files, secrets, or telemetry paths are introduced;
- verify remote/multi-root behavior still matches current extension kind/workspace-hosted execution.

## 16. Decision summary

Recommended end state:

- **Primary host:** `CustomReadonlyEditorProvider`-backed center editor tabs
- **Sidebar:** minimal launcher/history only
- **Session identity:** canonical URI per workspace draft or Pi session
- **Lifecycle:** one live controller per workspace, many cached/rebindable tabs
- **Rollback:** retain legacy shared panel until packaged parity is proven

This delivers the transferable Claude pattern while staying faithful to Pi RPC semantics and current coverage/security contracts.
