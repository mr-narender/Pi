# Claude Code VS Code v2.1.215 interaction pattern analysis

## Scope

This analysis is limited to public/observable surfaces of `/Users/narender/.vscode/extensions/anthropic.claude-code-2.1.215-darwin-arm64`:

- `README.md`
- `package.json`
- walkthrough markdown and public screenshots under `resources/walkthrough/`
- public resource names under `resources/`
- disposable VS Code observation with isolated `HOME`, disposable `--user-data-dir`, and public command invocation only

No bundled proprietary source was decompiled or reverse engineered.

## Evidence index

- Claude manifest/readme: `/Users/narender/.vscode/extensions/anthropic.claude-code-2.1.215-darwin-arm64/package.json`, `/Users/narender/.vscode/extensions/anthropic.claude-code-2.1.215-darwin-arm64/README.md`
- Walkthrough/public resources: `/Users/narender/.vscode/extensions/anthropic.claude-code-2.1.215-darwin-arm64/resources/walkthrough/step1.md` … `step4.md`, `click.png`, `chat.png`, `past.png`, `welcome.png`, `AcceptMode.jpg`, `PlanMode.jpg`, `HighlightText.jpg`
- Sanitized observation evidence: `docs/evidence/claude-code-vscode/observer-output.json`, `docs/evidence/claude-code-vscode/observer-summary.md`, `docs/evidence/claude-code-vscode/claude-vscode-log.txt`, `docs/evidence/claude-code-vscode/resource-observations.md`, `docs/evidence/claude-code-vscode/manifest-notes.md`
- Current Pi 0.0.3 comparison sources: `package.json`, `src/webview/provider.ts`, `src/webview/render.ts`, `src/extension.ts`, `src/ui/status/statusBar.ts`

## Evidence labels

- **VERIFIED-BY-MANIFEST:** supported by `package.json` only.
- **VERIFIED-BY-PUBLIC-DOC:** supported by README, walkthrough markdown, or public screenshots/assets.
- **OBSERVED:** supported by the disposable VS Code run or direct inspection of public screenshots.
- **INFERRED:** synthesis from verified/observed evidence; not automatically a mandatory requirement.
- **EVIDENCE-BOUNDARY:** explicitly not established by current public evidence.

## Findings by topic

### 1) Launcher: where Claude enters the workflow

- **OBSERVED:** The primary launcher is an orange Claude icon in the editor title area at the top right, not a dedicated Activity Bar-first entry. Public step 2 says “Click the orange Claude icon in the top right corner of your editor,” and `click.png` visually places it there. (`resources/walkthrough/step2.md`, `resources/walkthrough/click.png`, `docs/evidence/claude-code-vscode/resource-observations.md`)
- **VERIFIED-BY-MANIFEST:** The editor title contributes `claude-vscode.editor.openLast` when terminal mode is off. (`package.json` `contributes.menus["editor/title"]`, `docs/evidence/claude-code-vscode/manifest-notes.md`)
- **VERIFIED-BY-MANIFEST:** There are alternate open commands for new tab, primary editor, side bar, terminal, and new window. (`package.json` `contributes.commands`, `docs/evidence/claude-code-vscode/manifest-notes.md`)
- **VERIFIED-BY-MANIFEST:** Default open location is `panel`, not side bar. (`package.json` `claudeCode.preferredLocation`, `docs/evidence/claude-code-vscode/manifest-notes.md`)

### 2) Where chat opens

- **OBSERVED:** In a disposable unauthenticated run, `claude-vscode.editor.openLast` opened a `Claude Code` webview tab in a second editor group (`ViewColumn 2`). (`docs/evidence/claude-code-vscode/observer-summary.md`, `docs/evidence/claude-code-vscode/observer-output.json`)
- **OBSERVED:** `claude-vscode.primaryEditor.open` placed a `Claude Code` tab in the primary editor group (`ViewColumn 1`). (`docs/evidence/claude-code-vscode/observer-summary.md`, `docs/evidence/claude-code-vscode/observer-output.json`)
- **VERIFIED-BY-MANIFEST:** The panel webview identity is `claudeVSCodePanel` via activation event `onWebviewPanel:claudeVSCodePanel`. (`package.json` `activationEvents`, `docs/evidence/claude-code-vscode/manifest-notes.md`)
- **INFERRED:** Claude treats editor tabs as the canonical native UI surface, with side bar as an alternate host, because the default setting is `panel`, the walkthrough teaches the top-right editor launcher, and the observable open commands all target editor surfaces first. (`package.json` `claudeCode.preferredLocation`, `resources/walkthrough/step2.md`, `docs/evidence/claude-code-vscode/observer-summary.md`)

### 3) History / resume location

- **OBSERVED:** History is exposed inside the Claude tab itself through a top control labeled `Past conversations`. The same public screenshot shows a top-right `+` new-conversation affordance. (`resources/walkthrough/past.png`, `docs/evidence/claude-code-vscode/resource-observations.md`)
- **VERIFIED-BY-PUBLIC-DOC:** Walkthrough copy says history is reached from a `Past Conversations` button or `/resume`, and new conversation comes from `New Chat`. (`resources/walkthrough/step4.md`)
- **VERIFIED-BY-MANIFEST:** There is also an optional sessions-list container/view gated by `claude-vscode.sessionsListEnabled`, but it is conditional rather than the default taught flow. (`package.json` `viewsContainers.activitybar`, `views.claude-sessions-sidebar`)
- **INFERRED:** Launcher and history are intentionally colocated with the active chat surface, reducing context-switching to a separate navigation tree. (`resources/walkthrough/step4.md`, `resources/walkthrough/past.png`)

### 4) New / resume interactions

- **VERIFIED-BY-MANIFEST:** `claude-vscode.newConversation` and `claude-vscode.reopenClosedSession` are first-class public commands. (`package.json` `contributes.commands`)
- **VERIFIED-BY-MANIFEST:** Optional keyboard affordances exist for new conversation (`Cmd/Ctrl+N`) and reopen closed session (`Cmd/Ctrl+Shift+T`). (`package.json` `contributes.keybindings`, `claudeCode.enableNewConversationShortcut`, `claudeCode.enableReopenClosedSessionShortcut`)
- **OBSERVED:** In the isolated unauthenticated run, `claude-vscode.newConversation` produced no observable tab-layout change. (`docs/evidence/claude-code-vscode/observer-summary.md`, `docs/evidence/claude-code-vscode/claude-vscode-log.txt`)
- **OBSERVED:** In the same run, `claude-vscode.reopenClosedSession` produced no observable tab-layout change. (`docs/evidence/claude-code-vscode/observer-summary.md`)
- **INFERRED:** Because auth was absent, mandatory redesign requirements should not depend on the exact unauthenticated new/resume screen behavior beyond the command and entry-point existence. (`docs/evidence/claude-code-vscode/claude-vscode-log.txt`)

### 5) Editor tab identity and lifecycle

- **OBSERVED:** Repeated `claude-vscode.editor.openLast` calls created multiple concurrent `Claude Code` tabs instead of reusing the first visible tab. (`docs/evidence/claude-code-vscode/observer-summary.md`, `docs/evidence/claude-code-vscode/observer-output.json`)
- **OBSERVED:** `claude-vscode.editor.open` added yet another `Claude Code` tab in the same secondary group. (`docs/evidence/claude-code-vscode/observer-summary.md`)
- **OBSERVED:** Closing the primary-group Claude tab did not close the secondary-group Claude tabs; tabs are independent editor instances. (`docs/evidence/claude-code-vscode/observer-summary.md`)
- **OBSERVED:** Public screenshot `past.png` shows one generic tab label (`Claude`) and one session-titled/truncated tab (`Accessibility au...`), implying tab identity can become session-specific after conversation state exists. (`resources/walkthrough/past.png`, `docs/evidence/claude-code-vscode/resource-observations.md`)
- **VERIFIED-BY-MANIFEST:** Reopen-closed-session capability is surfaced as its own public command and optional shortcut. (`package.json` `claude-vscode.reopenClosedSession`, `claudeCode.enableReopenClosedSessionShortcut`)
- **INFERRED:** Claude’s mental model is “conversation as editor tab,” not “single shared chat utility panel.” (`docs/evidence/claude-code-vscode/observer-summary.md`, `resources/walkthrough/past.png`)

### 6) Side-panel role

- **VERIFIED-BY-MANIFEST:** Claude contributes a side bar/secondary side bar webview host plus an optional sessions-list container. (`package.json` `viewsContainers`, `views`)
- **OBSERVED:** `claude-vscode.sidebar.open` caused no observable editor-tab change in the isolated unauthenticated run. (`docs/evidence/claude-code-vscode/observer-summary.md`)
- **INFERRED:** The side panel is an alternate docking location, not the primary IA skeleton; the default taught entry remains editor-top-right into panel/tab. (`package.json` `claudeCode.preferredLocation`, `resources/walkthrough/step2.md`)

### 7) Primary and secondary controls

- **OBSERVED:** Public composer/footer screenshots show a compact mode chip (`Accept edits` or `Plan mode`), a current-file chip, and a send arrow. (`resources/AcceptMode.jpg`, `resources/PlanMode.jpg`, `docs/evidence/claude-code-vscode/resource-observations.md`)
- **OBSERVED:** Public history screenshot shows `Past conversations` as a top control and a top-right `+` new-conversation control. (`resources/walkthrough/past.png`)
- **VERIFIED-BY-MANIFEST:** Contextual editor actions exist for accepting/rejecting proposed diffs. (`package.json` `claude-vscode.acceptProposedDiff`, `claude-vscode.rejectProposedDiff`, `menus["editor/title"]`)
- **VERIFIED-BY-MANIFEST:** Inline context insertion is intentionally prominent enough to have a public command and shortcut (`claude-vscode.insertAtMention`, `Alt+K`). (`package.json` `commands`, `keybindings`)
- **INFERRED:** Claude keeps always-visible controls compact and task-proximate, moving secondary behaviors into commands/settings rather than a persistent management dashboard. (`resources/AcceptMode.jpg`, `resources/PlanMode.jpg`, `package.json` settings/commands)

### 8) Session metadata

- **VERIFIED-BY-PUBLIC-DOC:** Public walkthrough states conversations are saved automatically. (`resources/walkthrough/step4.md`)
- **OBSERVED:** Session/state metadata is at least surfaced as tab naming/history labeling: generic brand tab before/without state, session-title tab when history exists in screenshot. (`resources/walkthrough/past.png`, `docs/evidence/claude-code-vscode/resource-observations.md`)
- **INFERRED:** Exact authenticated metadata fields beyond title/history entry are unknown from public unauthenticated observation and should not be assumed. (`docs/evidence/claude-code-vscode/claude-vscode-log.txt`)

### 9) Focus, empty, loading, and error states

- **VERIFIED-BY-MANIFEST:** Claude has explicit public focus and blur commands, both bound to `Cmd/Ctrl+Escape` with context-sensitive `when` clauses. (`package.json` `claude-vscode.focus`, `claude-vscode.blur`, `contributes.keybindings`)
- **OBSERVED:** Public empty-state visuals show a minimal pane with large `Claude Code` branding and a bottom composer rather than a dense setup dashboard. (`resources/HighlightText.jpg`, `resources/walkthrough/chat.png`)
- **OBSERVED:** In the isolated run, commands opened Claude tabs even though the Claude log reported `No authentication found`; actual unauthenticated screen copy/layout was not captured. (`docs/evidence/claude-code-vscode/observer-summary.md`, `docs/evidence/claude-code-vscode/claude-vscode-log.txt`)
- **EVIDENCE-BOUNDARY:** The disposable run confirms Claude tabs can open without authentication, but it does not establish the exact unauthenticated/error surface or whether Claude ever redirects users elsewhere. (`docs/evidence/claude-code-vscode/observer-summary.md`, `docs/evidence/claude-code-vscode/claude-vscode-log.txt`)
- **INFERRED:** Public resource names `claude-logo-pending.svg` and `claude-logo-done.svg` suggest branded pending/done state indicators, but this was not directly observed in UI and is not a redesign requirement. (`resources/claude-logo-pending.svg`, `resources/claude-logo-done.svg`)

### 10) Advanced disclosure

- **VERIFIED-BY-MANIFEST:** Secondary behavior is mostly disclosed through settings: terminal fallback, Ctrl/Cmd+Enter send mode, preferred location, optional new/reopen shortcuts, onboarding hide. (`package.json` configuration properties)
- **OBSERVED:** Public UI screenshots show compact mode chips and compact top controls in the examples we can inspect. (`resources/AcceptMode.jpg`, `resources/PlanMode.jpg`, `resources/walkthrough/past.png`)
- **EVIDENCE-BOUNDARY:** Current public evidence does not establish that richer advanced/diagnostic UI is absent elsewhere, so no mandatory Claude-derived rule against denser advanced surfaces is claimed here.

### 11) Contextual editor actions

- **VERIFIED-BY-PUBLIC-DOC:** README and walkthrough state Claude uses current file and current text selection as context. (`README.md`, `resources/walkthrough/step3.md`)
- **VERIFIED-BY-MANIFEST:** The extension exposes `@` mention insertion and proposed-diff accept/reject actions in editor title. (`package.json` commands/keybindings/menus)
- **OBSERVED:** Public screenshot `HighlightText.jpg` visually demonstrates selected code on the left editor and a question in Claude on the right. (`resources/HighlightText.jpg`)

### 12) Status and notifications

- **OBSERVED:** Public `welcome.png` shows inline permission review with numbered choices and a comment field inside the Claude surface. (`resources/walkthrough/welcome.png`, `docs/evidence/claude-code-vscode/resource-observations.md`)
- **VERIFIED-BY-MANIFEST:** Public commands include `showLogs`, `update extension`, and `install plugin`. (`package.json` `claude-vscode.showLogs`, `claude-vscode.update`, `claude-vscode.installPlugin`)
- **EVIDENCE-BOUNDARY:** The manifest shows no public status-bar contribution, but that does not prove status is primarily in-surface or make status-bar removal a Claude-derived Pi requirement. (`package.json`, `resources/walkthrough/welcome.png`)

### 13) Keyboard behavior

- **VERIFIED-BY-MANIFEST:** `Cmd/Ctrl+Escape` opens/focuses or blurs Claude depending on context. (`package.json` keybindings)
- **VERIFIED-BY-MANIFEST:** `Cmd/Ctrl+Shift+Escape` opens Claude in a new tab. (`package.json` keybindings)
- **VERIFIED-BY-MANIFEST:** `Alt+K` inserts an `@` mention in editor context. (`package.json` keybindings)
- **VERIFIED-BY-MANIFEST:** Optional `Cmd/Ctrl+N` and `Cmd/Ctrl+Shift+T` align with native new-tab/reopen patterns, but only when Claude-specific contexts/settings are true. (`package.json` keybindings/settings)
- **VERIFIED-BY-MANIFEST:** Send behavior can switch to `Ctrl/Cmd+Enter` via setting. (`package.json` `claudeCode.useCtrlEnterToSend`)

## Transferability summary: verified patterns vs unknowns/non-requirements

| Bucket                        | Claim                                                                                                                            | Evidence basis                                                                                                                                     | Use in Pi redesign                                                                   |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Transferable verified pattern | Editor-title launcher plus keyboard open/focus behavior.                                                                         | `resources/walkthrough/step2.md`, `resources/walkthrough/click.png`, Claude `package.json`, `docs/evidence/claude-code-vscode/observer-summary.md` | Legitimately transferable requirement.                                               |
| Transferable verified pattern | Default editor-tab/panel host, with side bar as an alternate host.                                                               | Claude `package.json`, `docs/evidence/claude-code-vscode/observer-summary.md`                                                                      | Legitimately transferable requirement.                                               |
| Transferable verified pattern | Multiple concurrent Claude tabs.                                                                                                 | `docs/evidence/claude-code-vscode/observer-summary.md`, `docs/evidence/claude-code-vscode/observer-output.json`                                    | Legitimately transferable requirement.                                               |
| Transferable verified pattern | In-surface history and new-conversation entry points.                                                                            | `resources/walkthrough/step4.md`, `resources/walkthrough/past.png`                                                                                 | Legitimately transferable requirement.                                               |
| Transferable verified pattern | Current file/selection context, `@` mention affordance, and diff accept/reject affordances.                                      | `README.md`, `resources/walkthrough/step3.md`, Claude `package.json`                                                                               | Legitimately transferable requirement.                                               |
| Manifest-limited fact         | `newConversation` and `reopenClosedSession` command/shortcut availability is public, but authenticated screen/effect is unknown. | Claude `package.json`, `docs/evidence/claude-code-vscode/observer-summary.md`                                                                      | Treat only as command discoverability evidence, not verified authenticated behavior. |
| Unknown/non-requirement       | Exact authenticated new/resume/home/error/loading behavior.                                                                      | No authenticated capture.                                                                                                                          | Do not make mandatory.                                                               |
| Unknown/non-requirement       | Exact session metadata/tab-title rules.                                                                                          | Only limited screenshot hints.                                                                                                                     | Do not make mandatory.                                                               |
| Unknown/non-requirement       | Exact sessions-sidebar composition.                                                                                              | Manifest confirms optional sessions container/view; live composition unobserved.                                                                   | Do not make mandatory.                                                               |
| Unknown/non-requirement       | Removal/deprioritization of Pi status bar chrome.                                                                                | Manifest only shows no Claude status-bar contribution; status dominance is unverified.                                                             | If Pi changes this, justify from Pi usability/user feedback, not Claude parity.      |
| Unknown/non-requirement       | Prohibition of dense advanced controls.                                                                                          | Public examples are compact, but richer advanced UI elsewhere is not ruled out.                                                                    | If Pi changes this, justify from Pi usability/user feedback, not Claude parity.      |

## Transferable redesign requirements supported by current evidence

1. Pi should expose an editor-title launcher plus keyboard open/focus behavior.
2. Pi should support chat as an editor-tab/panel surface by default, with side bar as an alternate host.
3. Pi should support multiple concurrent chat/session tabs instead of a single shared chat panel instance.
4. Pi should surface history and new-conversation entry points inside the chat surface.
5. Pi should provide contextual editor affordances for current file/selection context, `@` mention insertion, and diff accept/reject actions.

## Pi-specific design recommendations from current usability feedback (not Claude-derived requirements)

- Pi may still benefit from stronger progressive disclosure if current users find the default chat surface too operationally dense.
- Pi may still benefit from reevaluating how much persistent status chrome is shown by default if current users experience it as noisy or redundant.
- These are Pi product decisions to justify with Pi research/usability evidence, not mandatory Claude pattern matches.

## Known unknowns / excluded assumptions

- Exact authenticated home/chat screen copy, loading indicators, error copy, and session-detail fields remain unknown and must **not** be treated as mandatory redesign requirements. (`docs/evidence/claude-code-vscode/claude-vscode-log.txt`)
- The exact side-bar visual composition when `claude-vscode.sessionsListEnabled` is true was not observed live; only the manifest confirms its existence. (`package.json`)
- `claude-vscode.newConversation`, `claude-vscode.reopenClosedSession`, `showLogs`, and `openWalkthrough` produced no observable editor-tab change in the isolated unauthenticated run; authenticated behavior may differ. (`docs/evidence/claude-code-vscode/observer-summary.md`)
- Public screenshots provide examples of empty/default presentation and tab naming, but they do not establish mandatory authenticated home/error/loading or exact session-metadata rules. (`resources/walkthrough/chat.png`, `resources/walkthrough/past.png`)

## Pi 0.0.3 mismatch table

Rows marked as informational or Pi-specific recommendations are intentionally **not** scored as learned mandatory Claude requirements.

| Area                                   | Claude Code v2.1.215 pattern                                                                                                                                                                                                                      | Pi 0.0.3 current                                                                                                                                                                                                                                       | Mismatch                                                                                      |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| Primary launcher                       | **OBSERVED/VERIFIED:** top-right editor title launcher plus `Cmd/Ctrl+Escape`. (`resources/walkthrough/step2.md`, Claude `package.json`)                                                                                                          | Pi exposes an Activity Bar container `piRpc` with `New Chat`, `Resume Chat`, `Current Chat`; no contributed `editor/title` launcher or keybindings. (`package.json`)                                                                                   | High                                                                                          |
| Default host surface                   | **VERIFIED/OBSERVED:** default location is `panel`; opens as editor webview tab. (Claude `package.json`, observer evidence)                                                                                                                       | Pi chat is a single `Current Chat` webview panel created with `createWebviewPanel(..., 'Current Chat', ViewColumn.Beside)` and revealed/reused if already open. (`src/webview/provider.ts`)                                                            | High                                                                                          |
| Multiple concurrent sessions in editor | **OBSERVED:** repeated open commands create multiple `Claude Code` tabs across groups. (`docs/evidence/claude-code-vscode/observer-summary.md`)                                                                                                   | Pi stores one `this.panel` and reuses it; no multi-tab session model. (`src/webview/provider.ts`)                                                                                                                                                      | High                                                                                          |
| History placement                      | **OBSERVED/VERIFIED:** `Past Conversations` lives in the Claude surface; `/resume` is in-surface workflow. (`step4.md`, `past.png`)                                                                                                               | Pi history/resume lives in separate sidebar tree view and Quick Pick flow (`Resume Chat`, `pickRecentSession`). (`package.json`, `src/extension.ts`)                                                                                                   | High                                                                                          |
| New chat placement                     | **OBSERVED/VERIFIED:** `New Chat`/`+` is in the Claude surface. (`step4.md`, `past.png`)                                                                                                                                                          | Pi exposes `New Chat` in sidebar view title, empty state, and header buttons inside `Current Chat`. (`package.json`, `src/webview/render.ts`)                                                                                                          | Medium: Pi has the action, but placement is split across surfaces                             |
| Side bar role                          | **VERIFIED/INFERRED:** alternate host / optional sessions list, not the primary taught entry. (Claude `package.json`, walkthrough)                                                                                                                | Pi side bar is the primary IA skeleton and entry point. (`package.json`)                                                                                                                                                                               | High                                                                                          |
| Empty/default state                    | **VERIFIED-BY-PUBLIC-DOC/OBSERVED:** public screenshots show one minimal branded pane + composer example. (`HighlightText.jpg`, `chat.png`)                                                                                                       | Pi empty state is a card with `New Chat`, `Resume Chat`, `Help`; default header is `Current Chat`. (`src/webview/render.ts`)                                                                                                                           | Informational only: exact authenticated home/error/loading behavior is unknown                |
| Advanced disclosure                    | **VERIFIED/OBSERVED:** some secondary behaviors are settings-backed and public examples are compact. (`package.json`, Claude screenshots)                                                                                                         | Pi default surface includes `More`; advanced mode reveals a large multi-section `Advanced` panel with Session, Branches, Queue & steering, Model & thinking, Commands & tools, Stats & export, Diagnostics, Developer tools. (`src/webview/render.ts`) | Do not score as a Claude-derived mismatch; simplify only if Pi usability evidence supports it |
| Status chrome                          | **VERIFIED-BY-MANIFEST/OBSERVED:** manifest exposes no Claude status-bar contribution; `welcome.png` verifies one inline approval example only. (`package.json`, `welcome.png`)                                                                   | Pi creates persistent status bar items for connection, model, queue, usage, and keyed statuses. (`src/ui/status/statusBar.ts`)                                                                                                                         | Do not score as a Claude-derived mismatch; reduce only if Pi usability evidence supports it   |
| Contextual editor affordances          | **VERIFIED/OBSERVED:** current file + selection context, `@` mention shortcut, editor-title diff accept/reject. (`README.md`, `step3.md`, Claude `package.json`)                                                                                  | Pi supports attachments from active file/selection inside chat, but no contributed mention shortcut and no editor-title diff accept/reject commands. (`src/webview/render.ts`, `package.json`)                                                         | High                                                                                          |
| Keyboard model                         | **VERIFIED:** open/focus/blur/new/reopen/send shortcuts exist and are context-aware. (Claude `package.json`)                                                                                                                                      | Pi contributes no `keybindings` section. (`package.json`)                                                                                                                                                                                              | High                                                                                          |
| Resume after close                     | **VERIFIED-BY-MANIFEST:** explicit `reopenClosedSession` command/shortcut is contributed; successful reopen behavior was not observed in the unauthenticated run. (Claude `package.json`, `docs/evidence/claude-code-vscode/observer-summary.md`) | Pi has session switching/resume, but no close/reopen chat-tab lifecycle because chat is a single reusable panel. (`src/extension.ts`, `src/webview/provider.ts`)                                                                                       | Medium: command discoverability gap only; authenticated lifecycle behavior remains unknown    |
| Terminal fallback                      | **VERIFIED:** terminal mode is a settings-backed fallback, not the default. (`README.md`, Claude `package.json`)                                                                                                                                  | Pi does not expose an equivalent “same product, alternate terminal host” mode in manifest. (`package.json`)                                                                                                                                            | Low                                                                                           |

## UX synthesis

Claude’s public pattern is editor-native, multi-tab, compact, and history-in-context. Pi 0.0.3 is sidebar-first, single-panel, status-heavy, and operationally dense. The biggest structural mismatch is not copy or styling; it is the interaction model: **Claude treats each conversation as an editor object, while Pi still treats chat as a managed utility panel attached to a navigation sidebar.**
