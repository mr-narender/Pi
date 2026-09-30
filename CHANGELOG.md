# Changelog

## 0.2.9 — local test build (PR #2)

- **Agentic now has Chat's anchored “…” dropdown.** The Chat / Configure /
  System headings and all eight actions render in the sidebar webview instead
  of opening a separate QuickPick. Commands are allowlisted in the webview and
  again by the extension host; list refreshes preserve menu state and focus.

## 0.2.8 — local test build (PR #2)

- **Agentic sidebar "…" menu got its labeled sections back.** Chat /
  Configure / System headers were lost when the menu moved from the
  in-webview dropdown to a native submenu (native menus render group ids as
  bare separator lines — labels can't display). The "…" button now opens a
  QuickPick with the same items under visible Chat / Configure / System
  headers.

## 0.2.7 — local test build (PR #2)

- **Hover icons centered.** The code-card copy button still carried its old
  text-label padding (`2px 8px`), skewing the icon; it's now a fixed 22px
  square with the icon dead-center. The message-hover pencil/copy pill is
  inset 4px from the bubble corner and its icons are hard-centered
  (block-level SVG, zero padding/line-height).

## 0.2.6 — local test build (PR #2)

- **Image chips: the thumbnail IS the chip.** Capsule removed when a preview
  exists — just the 48px thumbnail with the remove × overlaid on its corner.
- **Code blocks auto-format for readability.** Fenced code in the chat is
  formatted through your installed VS Code formatters (any language with a
  formatter registered — TypeScript, Python, Go, …). Display-only and
  best-effort: the stored conversation never changes; no formatter or a slow
  one (>0.8s) just leaves the block as-is. Toggle: `piRpc.formatCodeBlocks`.
- **Copy is an icon now.** The code-card COPY text label became a copy icon
  with a ✓ confirmation state.

## 0.2.5 — local test build (PR #2)

- **Image chips are now just the thumbnail, enlarged (48px).** No filename
  text in the chip — the name stays on hover and for screen readers; click
  still expands the full preview.
- **Glassy code cards inside message bubbles.** The code block surface is
  translucent (bubble tint shows through) instead of an opaque gray slab;
  the COPY bar is a hairline, not a band.

## 0.2.4 — local test build (PR #2)

- **Image chip thumbnails actually reach the webview.** Root cause of "no
  thumbnail preview": both fallback snapshot builders stripped
  `previewDataUrl` before posting to the webview (tests fed the renderer
  directly, hiding it). Snapshot mapping is now a shared tested helper —
  fresh pastes keep their thumbnail even in cached/draft tabs, and only
  images whose bytes are truly gone demand reselect.
- **Code blocks: per-line gray boxes removed.** The bare `code` element inside
  fenced blocks inherited VS Code's default webview background, painting a box
  per wrapped line inside the code card. Now transparent — the card is the
  only surface.
- **Follow pane: workspace containment.** Only files inside the chat's
  workspace root auto-open; /tmp scratch files and other out-of-tree edits
  narrate in the status bar instead of popping editors.

## 0.2.3 — local test build (PR #2)

- **Image paste fallback:** images arriving only via `clipboard.files` (empty
  `items` — how Electron/VS Code can deliver them) now attach as chips too.
- **Paste breadcrumbs:** every paste logs what the clipboard delivered to the
  Pi output channel (`[webview:paste]`) — one line pinpoints any future
  clipboard-flavor issue.

- **Pasted text stays text.** Text pastes of any size go straight into the
  input box — the "Pasted text" chip capture is gone (images and file URIs
  still attach as chips). Chips persisted by older versions still restore,
  render, and send.
- **Submit clears the whole composer atomically.** Draft, context chips, and
  image chips are captured into the outgoing message and cleared in one step
  (`beginSend`) — nothing sent can linger into the next message. Cancelling
  session creation restores exactly what was cleared.
- **Follow-agent can no longer freeze the window on open/resume.** History
  detection is structural (message high-water mark + busy-only + burst
  absorption) instead of a 1.5s wall-clock grace window — a slow-hydrating
  large session can never be mistaken for live activity and storm editor
  opens. Snapshot scans are incremental (O(delta) per tick) and the live-caret
  reverse scan is bounded.
- **Follow opens only files the agent actually edits.** Reads/searches narrate
  in the status bar without opening tabs.
- **`piRpc.followMaxTabs` (default 10).** The follow pane keeps a bounded list
  of tabs it opened; the oldest is closed past the cap. Tabs you opened,
  pinned, edited, or are viewing are never touched.

## 0.2.1 — Alpha 3 hotfix

- **Pasted images now show a visible thumbnail in the composer.** The preview
  existed but was hidden until you expanded the chip — reported from live
  testing ("I don't see pasted image preview in the input box"). The chip row
  itself now carries a mini thumbnail; click still expands the full preview.

## 0.2.0 — Alpha 3 (UI quality-of-life, tested end-to-end)

Five stages, each landed behind the full gate (typecheck + lint + 412 unit +
integration + extension-host suite) with zero regressions against the 381-test
baseline. UI-only by principle: the extension renders what pi already knows —
nothing agentic was bolted on.

- **Golden-snapshot net for the chat list.** Every chat-list row state (active,
  favorite, draft, hostile-input escaping, loading/error/empty, full shell) is
  now pinned as golden HTML — the 0.1.0 name-squeeze class of regression fails
  the gate instead of shipping.
- **Chat list: search, keyboard, live times.** A search box filters your FULL
  history (not just the visible 20) plus open chats; rows are keyboard-first
  (↑↓/Home/End/Enter, focus rings, real listbox semantics); “5m ago” now
  refreshes by itself — timestamps are painted client-side and repaint every
  minute.
- **Paste previews in the composer.** Pasting big text becomes a
  “Pasted text · N lines” chip with click-to-expand preview instead of
  flooding the input (small pastes stay ordinary text); pasting file URIs
  attaches them like drag-drop; pasted images keep their thumbnails.
- **Clickable file:line mentions.** Backticked paths and bare `path.ts:123`
  mentions in any assistant message open the file at that line — same wiring
  as the tool-card “Open file” buttons.
- **Context gauge + session-size warnings.** The status chip's context %
  turns amber at 70% and red at 85% (“context N% full” on hover); chat-list
  rows warn (⚠ 113 MB) when a session file crosses 50 MB — oversized sessions
  are visible weeks before they refuse to resume.
- **Auto-compaction defaults to 75%.** `piRpc.autoCompact.percent` (still
  configurable, `piRpc.autoCompact.mode` to disable) now defaults to 75 —
  matching pi's own compaction reserve so compaction always has room to run.
- **Test infrastructure:** the extension-host suite now launches its fixture
  workspace with trust pre-granted (`--disable-workspace-trust`), so
  trust-gated paths are exercised for real.

## 0.1.1 — Alpha 2 (chat list polish)

- **Names get the full row width again.** 0.1.0's hover action strip reserved
  its width permanently, squeezing every chat name into a sliver. The strip is
  now an overlay pill that floats over the right end of the row only while
  hovering — at rest the name uses the entire row.
- **Hover shows the full name.** Hovering a row's text shows the complete,
  untruncated name in a tooltip above the name — long names are readable
  without widening the sidebar.
- **Favorites keep a visible marker.** Since the star button now only appears
  on hover, a starred chat shows a small inline gold star next to its name at
  rest (it steps aside while hovering, when the toggle star is visible).

## 0.1.0 — Alpha release (Agentic Mode chat list)

Alpha release of the rebuilt sidebar for multi-machine testing. Install via
“Install Pre-Release Version” on the Marketplace extension page. What this
alpha brings, by phase:

- **Phase 1 — One consolidated chat list.** A single webview list replaces the
  old stacked tree views: your open chats and your history in one place, backed
  by the real open-tabs data source (no more near-duplicate “Open”/“Recent”
  rows), deduped by session file, with New Chat and the toolbar menus intact.
- **Phase 2 — Newest-first everywhere.** Open chats sit as one block on top,
  ordered by last activity (newest first); history below follows the same
  order. Brand-new sessions float straight to the top.
- **Phase 3 — Real names instead of “Session 36”.** Rows now show your first
  prompt as the chat's name whenever the stored name is just the
  auto-generated “Session N”. A chat you renamed yourself keeps its custom
  name. Display-only — stored session names are untouched.
- **Phase 4 — Hover actions: favorite / rename / delete.** Hovering a row
  reveals the three action icons (no right-click menu). Favorites persist
  across restarts and machines' windows, float to the top of their block with
  a filled star, and can never age out of the visible list. Rename and delete
  behave exactly as before — delete still hides the row instantly.
- **Also in this alpha** (from the 0.0.30x line): working hover tooltips
  everywhere in the list (custom tooltip, since the native one never showed
  inside the webview), no reload-flash when clicking chats, and instant
  optimistic delete.

## 0.0.309

- **Chat list: open chats now sort newest-first too.** Open tabs stay as one block above history, but within the block they're ordered by session last-modified time (descending), same as the history below — so the whole list reads newest-first, with your open chats on top. Brand-new sessions (no timestamp yet) sort to the very top. Titles, icons, dedup, and the 20-item history cap are unchanged.

## 0.0.308

- **Fixed: hover tooltips genuinely didn't show at all.** Confirmed by hovering a real button in the real, running extension and waiting — no tooltip ever appeared, despite the `title` attribute being present and correct. VS Code's webview sandboxing makes the native browser tooltip unreliable; other VS Code extensions have hit this exact thing and solved it the same way. Built a small custom tooltip (matches VS Code's own hover-widget theme colors) delegated at the document level, so it covers every button with a `title` — present and future — without needing per-element wiring.

## 0.0.307

- **Flipped the permission toggle's orange glow to mean Auto Mode, not Ask Before Edits.** It was backwards — the accent color lit up for the more cautious/restricted state, when an accent normally reads as "active/live". Orange now means π is editing freely; the plain (unlit) icon means it's pausing for your OK.

## 0.0.306

- **Fixed the actual reason 0.0.304's approval-gate fix couldn't reach an already-set-up workspace, and a real bug in its own right**: `syncApprovalGate` only ever WROTE the gate file when the setting was enabled — there was no corresponding delete when disabling it. Turning `piRpc.requireApprovalForEdits` off left the old file sitting in `.pi/extensions` untouched, no longer registered in `.pi/settings.json` but still a real file Pi could still load — silently contradicting the setting saying it was off, and contradicting the template's own header comment ("safe to delete: disabling the setting removes it"), which was only ever half true. This is also why the `agent_end` fix in 0.0.304 couldn't reach a workspace whose VS Code-level setting already reads `false`: sync runs every activation regardless, but only ever touches the file on the `enabled` branch. Fixed by actually deleting the gate file when disabling. Net effect for anyone in this exact situation (gate file present, setting already off): the stale gate will correctly disappear on the next reload, matching what the setting already says — re-enable `piRpc.requireApprovalForEdits` to get the fixed version back.

## 0.0.305

- **Fixed a race condition introduced by 0.0.304's own fix**: caught it live before shipping, not by the user. `act()` fire-and-forgets its call to open a followed file, and the (deliberately long, ~2 minute) retry-for-approval window means several can genuinely be in flight at once. Each one deciding fresh where to open, independently, meant two concurrent calls could both see "no follow-files group exists yet" and each split their own — multiple separate groups instead of one shared pane, the same file sometimes scattered across them. Fixed by caching the decided group once created and sharing the in-flight creation itself, so every concurrent caller converges on the exact same group.

## 0.0.304

- **Fixed: "Allow rest of turn" kept re-prompting anyway.** Checked the Pi SDK's own type definitions rather than guessing: `turn_end`'s doc comment is explicit — "a turn is one assistant response + any tool calls/results", not the whole multi-step task. A model that writes a file then edits it almost always does that as two separate assistant messages (tool call, wait for the result, decide the next step) — two separate turns. Resetting the "allow" flag on `turn_end` meant it only ever covered a single message's tool calls, re-prompting on the very next one even though nothing new needed approving. Reset on `agent_end` instead (the whole run finishing) — matches what "rest of turn" actually means to a person asking for a multi-step change. Takes effect automatically on the next reload — the gate file is unconditionally resynced from this template on every activation when the setting is on, no manual step needed.
- **Explained (not a bug): why followed files opened below the chat instead of beside it.** Traced directly to your own `workbench.editor.openSideBySideDirection: "down"` setting — `vscode.ViewColumn.Beside` (what the previous fix used) respects that setting, and it's a real, valid, deliberate preference for everyday file splitting, confirmed by the comment already next to it in your settings. Changed follow specifically to force a group to the right (`workbench.action.newGroupRight`) regardless of that setting — the four-region layout this feature implements is explicitly horizontal (chat and followed files side by side), which is a property of this specific feature, not something that should ride on a general editor-splitting preference.

## 0.0.303

- **Fixed a second, separate cause of the same "file-following not working" report**: found while live-testing 0.0.302's fix. `readWithRetry` (waits for a fresh write to actually land on disk before opening it) only retried for ~3 seconds total, assuming writes land near-instantly — true without `piRpc.requireApprovalForEdits`, but that setting gates the real write behind a human clicking Allow first, which can easily take longer than 3 seconds. The pane gave up before the approved write ever landed — indistinguishable from "not working" (the status bar still updated; the pane itself just quit too early). Extended to ~2 minutes of gradually-backing-off retries — costs nothing in the fast, ungated case (the very first attempt still succeeds immediately), gives a real approval delay room to actually complete.

## 0.0.302

- **Fixed: agent file-following wasn't opening files at all.** Root cause found in `showInSidePane`'s own comment: it skipped opening the followed file entirely whenever a π chat tab owned the active editor group, reasoning "with the sidebar chat the center is always free" — true when chat lived in the sidebar webview, but `editorTabsEnabled()` has been the default for a while (chat itself is an editor tab). In the common single-group layout, the chat tab *is* the active tab in the only group whenever you're looking at it — so that guard fired every single time, and follow silently never opened anything. Not a timing issue, not a setting — it was refusing to run at all. Fixed by redirecting instead of skipping: reuse an existing non-chat editor group if one's already open, otherwise open a new one beside the chat. That new group then naturally becomes the reused target for every subsequent followed file (its own active tab is a real file, not a chat), so this doesn't re-split on every edit — one dedicated group, populated once, reused after.

## 0.0.301

- **Fixed: deleting a chat took a while to actually disappear from the list.** Root cause: `piRpcInternal.deleteSession` deletes the file immediately, but the row only actually vanishes once a full sessions-directory rescan completes and reports the shorter list — and that rescan is deliberately never awaited (blocking the UI on a full directory scan would be worse), so the stale row visibly lingered until it finished in the background. Fixed by hiding it optimistically the instant delete is clicked — we already know it's gone — with a self-healing mechanism: confirmed gone by the real rescan → stop tracking it; still showing after 5 seconds → un-hide it rather than have it vanish from view forever with no explanation if the delete actually failed.
- **Added: rename a chat from the list** — right-click → Rename…, reusing the existing rename command (same prompt, same behavior as before this list existed). Only shown for chats that have an actual session file — a brand-new, never-saved draft has nothing to write a name into yet.

## 0.0.300

- **Fixed: the list's "which chat is open/active" display went stale after switching focus between already-open tabs.** Root cause, found by reproducing live rather than guessing: VS Code only calls `resolveCustomEditor` once per tab's entire lifetime — switching focus between two tabs that are BOTH already open never re-runs it, so the one place that normally notifies the list of a change (`this.hosts.set/delete`, on open/close) never fires for a focus-only change. The list's active checkmark was frozen at whatever was true the last time a tab was actually opened or closed, not whatever's actually focused now — reported as "multiple sessions opened, but no chat seems to be opened" (the chat *was* open, the list just never learned focus had moved to it). Fixed at the actual point that DOES fire on every focus change (`onDidChangeViewState`/`onDidChangeVisibility`, already wired for other reasons) by notifying the same listeners tab open/close already does.
- Verified live against a real running VS Code window (not just the test suite): opened a fresh chat, opened a second existing one, confirmed the active checkmark correctly followed which tab was actually focused — including the concrete case that was broken before this fix.

## 0.0.299

- **Fixed: deleting a chat with no session file yet silently did nothing at all.** A brand-new chat that's open but hasn't been saved to a `.jsonl` file yet has no `sessionPath` — the delete action required one and had no fallback, so clicking Delete on a chat like that produced literally no message, no error, nothing. Now falls back to closing the tab directly (there's nothing on disk to remove for a chat that was never saved) via a new `ChatTabManager.closeResource()`. Verified against the real built bundle for all three delete paths (context menu, hover icon, both with and without a session file) — a lesson from the last release: hand-copied reproductions in a test script don't catch what the real bundle does.
- Caught and fixed a real build break while making that fix: `chatList.ts` (the browser-side list bundle) needed to import a real function from the file shared with the extension host for the first time, which — unlike importing only types, which TypeScript erases before esbuild ever sees them — forced esbuild to bundle that file's own `node:fs`/`node:readline` dependency into a browser-target build, and it failed outright. Split the shared logic into a new `chatListShared.ts` with zero node dependencies; the extension-host-only parts (needing session-file scanning) stay in `chatListData.ts`. Caught by `npm run test:extension`, which builds for real — `npm run gate` (typecheck/lint/unit/integration) never runs the actual bundler, so it can't catch this class of break on its own.

## 0.0.298

- **Fixed: the delete icon was structurally invisible, not just easy to miss.** Real cause, found by testing the actual built bundle (not a hand-reproduced copy in a test script, which is what let this slip through earlier): a global `button { padding: 6px 12px }` reset in `chat.css` applied to the 26×26px delete button too, since nothing there ever overrode it. That squeezed its inner content area down to exactly 2×14px — the icon wasn't hidden, it was being rendered at 2 pixels wide. Every other icon-only button (`⋯`, "New Chat") already explicitly overrides padding; this one never did. Traced with Chrome DevTools Protocol directly against the real `dist/chat.css` (bypasses a `file://` CORS restriction that blocks normal `document.styleSheets` inspection) rather than guessing from computed values alone.
- **Moved the Chat/Configure/System menu to the native toolbar, next to the mode-flip button** — a real `view/title` submenu now, not built inside the webview. Reuses the exact same 8 commands (so nothing about what's reachable changes), grouped the same way (Chat / Configure / System), only visible in Agentic mode (Chat mode's webview keeps its own in-content `⋯`, avoiding a redundant second one). One honest platform difference worth knowing: native menus don't support text group headers, only visual dividers between groups — VS Code has no API for a labeled section inside a submenu.

## 0.0.297

- **Fixed: the chat list showed a chat as "open" (checkmark, highlighted row) even with zero editor tabs actually open.** Root cause: switching the sidebar from Chat mode to Agentic mode reuses the SAME WebviewView VS Code already resolved — it doesn't tear it down and hand back a fresh one, and VS Code never fires a view's dispose event just because its content was reassigned to something else. The old Chat-mode host (bound to whatever chat was last shown there) stayed registered as "open" forever after that, with no tab or view anywhere actually representing it — because nothing ever explicitly told it to let go. Fixed by having each mode-switch direction explicitly release whichever host owned the view before switching to the other. Also closes a related gap in the same spot: `webview.onDidReceiveMessage` supports multiple independent subscribers rather than replacing a previous one, so without this fix a second, unrelated mode-switch could have left two message listeners answering the same webview at once.

## 0.0.296

- **"Different model…" now shows the current model name**, matching the composer's own status chip (which shows `model.id` directly) instead of a generic action label — click behavior unchanged, still opens the picker.
- **Investigated "changing the model doesn't apply, it still uses the old model" with a real Pi CLI, not just code reading.** Wrote a test that spawns the actual `pi` binary, calls `setModel()` to a different provider, confirms `getState()` reflects it, then sends a real `prompt()` and inspects the resulting message events — the API call was genuinely attributed to the newly-selected model, not the old one. The mechanism works correctly. Also traced "Region is missing" to its source: it's an AWS SDK error (confirmed in `@aws-sdk/nested-clients`), specific to Amazon Bedrock's region configuration — not model-specific. If the repeated retries were all Bedrock models (amazon-bedrock sorts early, alphabetically, in the picker), the same error would recur regardless of which specific Bedrock model was picked, because the problem is the provider's region config, not which model. Added defensive checks regardless: `pickChatModel` now catches a `selectModel()` failure and shows it directly instead of leaving the caller to guess why nothing changed, and both this and the fork-and-resend path now compare the resulting model against what was picked and warn if they don't match — turning a theoretical silent mismatch into a visible one if it ever happens.
- **Fixed: the chat list's delete action was too easy to miss** — it existed (hover-reveal trash icon, shipped in 0.0.294) but hover-only discovery in a sidebar list is easy to never find. Added a right-click context menu per row (Open / Delete) — also replaces the browser's default cut/copy/paste menu, which never made sense on a list of buttons. Caught a real bug before shipping: the reused `.menu-panel` class defaults to `display: none`, only shown inside an *open* `<details>` element — the standalone context menu (not inside one) would have rendered completely invisible without an explicit override. Verified rendering correctly, including the delete item's hover state, with a real screenshot.

## 0.0.295

- **Fixed: opening a chat still visibly reloaded the list.** Real cause, confirmed by reading `RecentSessionService.refresh()` itself: it fires its change event TWICE per call — once with `loading: true`, once with the actual result — and opening a Recent chat calls `refresh()` explicitly. The list was blanking to "Loading chats…" on that intermediate tick even with real rows already on screen, then repainting — which is exactly what read as "the list reloaded". Now only the true first-ever load (before anything has rendered) shows a loading state; every later refresh keeps the current rows on screen until the fresh ones are ready. The decision logic is a pure, directly unit-tested function (`decideSnapshotPush`), with a test that reproduces the exact bug sequence (real data shown → a loading tick arrives → must not push).
- **Fixed: the Chat/Configure/System menu was missing entirely.** Real cause: it was attached to the tree view's `view/title` menu, which got removed along with the tree view itself in 0.0.294 — an unintentional side effect, not a deliberate cut. Restored inside the list webview itself instead (same `⋯` button pattern, same 8 items, same 3 groups, same wording as the full chat view's own menu) rather than as a native toolbar menu, since the list is now a webview too. Reuses the exact same command allowlist the full chat webview already enforces (`WEBVIEW_COMMAND_ALLOWLIST`, exported and shared, not duplicated) and the same `.menu-panel`/`.menu-group` styling — verified rendering all 8 items correctly with a real headless-browser screenshot before shipping.

## 0.0.294

- **Replaced the native tree view with a real webview for the Agentic Mode chat list — the previous architecture couldn't deliver what was actually being asked for.** Researched this properly rather than asserting it: `vscode.TreeItem.iconPath` does accept custom SVG icons (that part of the earlier claim was wrong), but row spacing and font size come from VS Code's internal list renderer and are never exposed to extensions (verified against VS Code's own `listView.ts`) — and the VS Code team itself has an open issue questioning whether list/tree widgets are the right fit for chat UI at all (`microsoft/vscode#268858`). A webview has none of those ceilings. One small, dedicated bundle (`chatList.ts`, ~3.5KB, separate from the ~2000-line chat runtime) renders the list now; `chat.css`'s existing ember/glass tokens are reused directly, not reinvented.
- **"New Chat" is a big orange button again**, same ember gradient + glow as the send button, not a toolbar icon.
- **Icons are consistent now**: exactly two states — a check mark for the active chat, one chat-bubble icon for every other row. The earlier three-icon mix (check / comment-discussion / history) is gone.
- **Added the missing delete/trash icon** — hover-reveal per row, reuses the existing no-confirmation delete command (unchanged prior decision).
- **Fixed: switching modes could leave the same chat open in two places at once.** Switching to Chat mode now closes the editor tab for whatever chat was active and shows that same chat in the sidebar (not whatever the sidebar last happened to have); switching to Agentic mode opens the sidebar's current chat as an editor tab instead of leaving it stranded. Scoped to real, saved chats — a brand-new empty draft has nothing worth migrating.
- List spacing, font size, and row backgrounds are now plain CSS — no more platform ceiling to report.

## 0.0.293

- **Fixed: clicking a chat still visibly reloaded the list (for real this time).** The 0.0.292 diff-guard compared the fully-rendered list, which includes "5m ago"-style relative-time text — that text can legitimately drift between two calls purely from wall-clock time passing, even when nothing about the actual data changed, which could defeat the comparison. Switched to comparing stable identity (which chats are open, which is active, which session ids are listed) instead of rendered text.
- **Restored the Configure/Chat/System menu in Agentic Mode, this time without renaming anything.** Real cause of the disappearance: VS Code's native menus display a command's Command-Palette title, not custom text — so reusing the same commands showed different labels ("Manage Extensions" vs. the webview's "Extensions…") in two places, which was an unintended rename, not a deliberate one. Fixed by aligning the command titles themselves to the webview's exact existing wording, so every surface — Command Palette, the tree view's menu, and the webview's own menu — now shows identical text everywhere. The webview's menu itself was never touched.
- **Removed the "Open" section label too** (Recent was already removed) — flat list now, icons (check / comment-discussion / history) carry the distinction instead of text headers.
- **Fixed the status bar showing raw, unrendered ANSI color codes** (e.g. `[38;5;109m`) — these come from other installed Pi extensions/skills that format status text for terminal rendering, which VS Code's status bar doesn't interpret. Not this extension's own text, but this extension is what renders it, so now strips ANSI codes defensively regardless of source.
- **Added `piRpc.statusBarExtras` setting** — an explicit opt-in allowlist for which extra status keys show in the status bar. Empty by default: any installed Pi extension can set a status key, and showing all of them unconditionally is how the status bar became noisy in the first place.
- Honest limitation, not fixed because it structurally can't be: list density and the glass visual theme are webview-only capabilities — a native VS Code tree view (used here for correct keyboard nav, sorting, and platform-standard behavior) has no extension-facing API for custom row spacing or background styling. Flagging this plainly rather than attempting something that isn't achievable within the current architecture.

## 0.0.292

- **Reverted the tree view's overflow menu added in 0.0.291.** Real problem found: it used the same command IDs as the webview's `⋯` menu, but VS Code's native menus display each command's Command-Palette title ("Manage Extensions", "Restart"), not the webview's actual short labels ("Extensions…", "Restart π") — so the same action showed different text in two places. That's an unintended rename, not a deliberate one. The webview's own menu is untouched and unchanged; those options remain reachable there and via Command Palette, exactly as before. Only "New Chat" stays as a toolbar icon (no naming conflict — its title already reads "New Chat" everywhere).
- **Removed the "Recent" section label** — reported as unwanted twice; the entries themselves stay, distinguished by icon (history vs. chat-bubble) instead of a text header.
- **Fixed: clicking any chat (not just New Chat) still visibly reloaded the list.** Real cause: revealing an already-open or already-known chat still fires the same change events as a genuinely new one, even though nothing about the list's content actually changed. Added a content diff before redrawing — computed the model, compared it to what's already shown, and only fire the tree-refresh event when it's actually different. Proved with a real harness: 3 no-op events (revealing a known chat) now cause zero redraws; a genuine new chat still causes exactly one.

## 0.0.291

- **Fixed: the Chat List view had no toolbar at all** — New Chat, Review last turn, Chat versions, Export chat, Extensions/Skills/Prompts/Agent Instructions, and Restart π all lived in the webview's own header, which Agentic Mode correctly hides — but nothing replaced them on the tree view side, so switching to Agentic Mode silently lost access to all of it. Added a `+` New Chat icon plus the same Chat/Configure/System grouped overflow menu the webview has, now on the tree view's title bar too.
- **Fixed: clicking New Chat visibly reloaded the whole list 2-3 times.** Real cause: opening a chat fires both the new `onDidChangeOpenChats` event and `recentSessions.refresh()` (which itself fires twice — loading, then settled) — three real events for one click. Debounced the tree's own refresh (120ms) so rapid-fire events collapse into one settled update, the same coalescing pattern already used for the webview's own rendering.
- **Reduced list density** — Recent capped at 12 instead of 30; a real user's actual session history (old Claude imports, past experiments) made the list feel overwhelming rather than scannable. Full history remains one click away via the existing search-everything Quick Switch command.

## 0.0.290

- **Fixed: "Loading chats" spinning forever, never settling** (reported immediately after 0.0.289). Real root cause: `getChildren()` called `recentSessions.refresh(folder)` explicitly on every invocation, while also listening for `onDidChange` and re-triggering `getChildren()` on it — `refresh()` fires `onDidChange` synchronously the moment it starts (`loading: true`), which re-triggered `getChildren()`, which called `refresh()` again, forever. `RecentSessionService.getState()` already has its own correct "refresh once if nothing cached yet" behavior built in — the predecessor code never called `refresh()` explicitly, only this rewrite added it. Removed the redundant call. Proved this with a real harness using the actual `RecentSessionService` class (not a mock): the buggy pattern produced a genuine stack-overflowing synchronous recursion (500,000+ calls before crashing), the fixed pattern settles at exactly 3 calls and stops.

## 0.0.289

- **Rebuilt Agentic Mode Phase 1 properly, per the original approved design** — the previous version (0.0.288) shipped two separate, near-duplicate tree sections stacked above the full chat, which was genuinely confusing and never should have shipped without a real look at it first.
  - **Found the actual root cause of the duplication**: both old tree providers drew from the exact same `recentSessions` array (just different slice limits) — there was never a real distinct "currently open" data source behind the "Open Chats" section. Fixed by wiring in the real one (`ChatTabManager.listOpenChats()`, with a new `onDidChangeOpenChats` event) and deduping "Recent" against it by session file path, so nothing shows twice.
  - **One consolidated list**, not two stacked views — "Open" and "Recent" are sections within a single `piRpc.openChatList` tree, matching the originally-approved mockup.
  - **Mutually exclusive with the full chat, not stacked with it** — new `piRpc.sidebarMode` setting (`agentic`/`chat`, default `agentic`) drives `when` clauses so exactly one of "chat list" or "full chat" is ever visible, switchable via a toolbar button on either view. This was the real fix for "chat squeezed to a sliver" — the list was never supposed to coexist with the full chat panel, only Phase 1 shipped without that boundary.
  - Caught a real regression while rewriting the model (dropped `workspaceLabel` from the Recent rows' description) via a pre-existing integration test — fixed before it shipped.
  - Honest limitation: this is a native VS Code tree view, not webview HTML — I can't headless-screenshot it the way CSS/menu changes get verified in this project. Verified via 6 targeted unit tests (including one specifically proving no duplication) plus real E2E activation, but an actual look from you is still the real verification here.

## 0.0.288

- **Agentic Mode Phase 1: Open Chat List.** Two new native sidebar views — "Open Chats" and "Recent Chats" — above the existing chat panel. This revives code that was already fully built (`SessionsTreeProvider`/`ResumeChatTreeProvider` + their data model) but never wired to an actual view. Clicking a session opens it as a real editor tab, alongside your files — reusing `piRpc.switchSession`, which already does exactly that by default, so no new open-a-chat behavior was needed, only the view registration. Added alongside the existing chat panel, not replacing it yet — the mode switch (showing only one or the other) is a later phase. Verified every command these views reference is actually registered before wiring anything up (learned that lesson from the "Prompts… does nothing" bug), plus real VS Code E2E activation, which caught and required fixing two other hardcoded manifest-shape assertions (a unit test and the E2E suite itself) that still expected the old single-view sidebar.

## 0.0.287

- Split the sidebar `⋯` menu's flat 8-item list into three labeled sections — **Chat** (Review last turn / Chat versions / Export chat), **Configure** (Extensions / Skills / Prompts / Agent instructions), **System** (Restart π). Reused the existing `.menu-group` header style already used elsewhere in the app instead of inventing a new one.

## 0.0.286

- **New: Agent Instructions manager** — a 4th sidebar-menu entry, alongside Extensions/Skills/Prompts, for the files that shape how π behaves: `APPEND_SYSTEM.md` (adds to the default system prompt) and the `AGENTS.md`/`AGENTS.override.md`/`CLAUDE.md` family ("context files" π reads for project/personal conventions). Deliberately does NOT offer `SYSTEM.md` (full replace of the default system prompt) — explicit call: too easy to cause real damage by accident, only the additive/context-file forms are offered. Click an existing file to open it, click a missing one to create it with a short starter explaining what goes there. Correctly distinguishes that `AGENTS.md` lives at the project root while `APPEND_SYSTEM.md` lives under `.pi/` — a real, easy-to-get-wrong distinction confirmed from Pi's own docs, not assumed. Verified against this machine's actual real files, including correctly finding the very `AGENTS.md` governing this session. 8 new unit tests.

## 0.0.285

- **Found the actual root cause of the menu bleed-through** — it was never an opacity problem, despite two rounds (0.0.283, 0.0.284) chasing it as one. `#messages .message-card` has `animation: pi-rise-in` (touches transform + opacity), which creates its own CSS stacking context per spec — regardless of whether it's still actively animating. The sidebar header (`.sb-deck`) never established its own stacking context (`position: static` has none), so the menu's z-index was being evaluated with no reliable priority over individual message/diff cards, no matter how opaque its background was. Fixed by giving `.sb-deck` `position: relative; z-index: 60`, well above every message card. Reproduced the exact bug and the fix side by side with a real animated message card + diff content before shipping — not just theorized about stacking contexts.

## 0.0.284

- Menus (⋯, attach, model/status popovers) are now fully solid — no transparency at all. 92%, then 98% opaque both still let content behind them show through enough to hurt readability in practice, worse than the synthetic dark-theme-only render this was originally verified against. A menu is functional UI everyone needs to read quickly, not a decorative surface, so it no longer gets the glass treatment. Re-verified this time against three different theme palettes (dark, light, and a saturated green-tinted one deliberately close to what likely caused the reported tint) — all solid and clean now, not just the one theme checked before.

## 0.0.283

- Fixed menu transparency being too high to read comfortably over busy transcript content — 92%→98% opaque, confirmed with a real render against realistic colored chat bubbles/code (not a flat background) before and after, not just a guessed number.
- Fixed clicking "Prompts…" (or Extensions/Skills, if none are set up) looking like nothing happened — it was working, just showing an easy-to-miss background toast for zero results. Now a modal dialog that plainly explains what that resource kind IS (most people clicking "Prompts…" don't already know what a prompt template is) and offers "Add a custom one…" as a direct next step.

## 0.0.282

- Fixed the sidebar `⋯` menu's "Extensions, skills & prompts…" item wrapping to two lines and visually overlapping with the transcript behind it. Split into three direct, short items — Extensions… / Skills… / Prompts… — jumping straight to that kind's toggle list; the menu itself is now the kind-picker instead of a redundant middle step. Verified with a real headless-Chrome render at the sidebar's actual width before shipping, not just shortened text and hoped.

## 0.0.281

- **New: Extensions, Skills & Prompts manager** (Track B) — GUI over Pi's own native resource system, not a parallel one. Discovers what's really on disk (Pi's canonical `<agent-dir>/{extensions,skills,prompts}` + project `.pi/{extensions,skills,prompts}`, plus the Agent Skills spec locations `~/.agents/skills` and `.agents/skills` walked up to the repo root) and shows name + real description (parsed from each skill/prompt's own frontmatter — nothing invented). Toggle on/off with checkboxes; the underlying mechanism is Pi's own documented `-path` exclusion / plain-path inclusion syntax in settings.json (the exact pattern already proven by the approval-gate feature, generalized to all three resource kinds and both scopes) — so what you toggle here is exactly what Pi itself understands, everywhere Pi runs for the project, not just in VS Code. Add a custom extension/skill/prompt from any location via a file/folder picker. Export/import the whole configuration as JSON for backup or reuse across machines. Reachable via Command Palette (`Pi: Manage Extensions, Skills & Prompts`) or the sidebar `⋯` menu.
  - Deliberately native VS Code QuickPick, not a new webview panel — avoids reintroducing the theme-consistency bug class fixed twice already this session, and matches proportionate effort for an occasional configuration action rather than moment-to-moment chat UI.
  - Deliberately NOT in scope: package-installed resources (`packages: [...]` in settings.json can bring their own skills/extensions from `<agent-dir>/git/…`, `<agent-dir>/npm/…`) — found via real-data testing against this machine's own actual Pi installation, not assumed. Those are already controlled by removing the package declaration; duplicating that here would mean tracking install-location-dependent paths that can shift across package updates.
  - 38 new unit tests across 4 new pure modules (frontmatter parsing, path resolution, discovery, settings merge) plus a harness run against this machine's real `.agents/skills` (25 real skills) and the real project `.pi/extensions/pi-approval-gate.ts` installed earlier this session — not just synthetic fixtures.

## 0.0.280

- Internal only, no user-facing change: broke up the 460-line `onMessage` webview-dispatch function (A4 of the de-bloat plan, the biggest single item) into a `switch` that stays for TypeScript's discriminated-union type-narrowing, with each of the 41 cases shrunk to one line delegating to a small, individually-named handler method. `onMessage` itself: 460→102 lines. Purely mechanical extraction (cut case body → new method → one-line delegate), done in 6 checkpointed batches with a typecheck after every batch — caught and fixed 2 real type mismatches this way (`title`/`workspaceFolderUri` are optional, not required, in the actual message types) before they could ship. Full gate + real VS Code E2E green, exact match against baseline (301 unit, 24 integration) — zero regressions. This closes the tabManager.ts de-bloat plan (A1 attachment-capture, A2 remote-sharing service, A4 message-dispatch restructure — A3 was evaluated and correctly skipped, see 0.0.279).

## 0.0.279

- Internal only, no user-facing change: extracted remote chat-sharing (pairing panel / phone mirror — start/stop/rename a share, list and switch remote-eligible chats, push snapshots) out of `tabManager.ts` into its own `remote/sharingService.ts` (A2 of the de-bloat plan; `tabManager.ts` 2677→2593 lines). Unlike A1's pure functions, this is a cohesive feature responsibility that needed injected read access to the chat registry, not full ownership transfer — all 9 public methods were called exclusively from `extension.ts` (15 call sites, all updated), confirming this was a genuine separable service, not just relocated code. Every method logically verified against the original before wiring in. Full gate + real VS Code E2E green, exact match against baseline (301 unit, 24 integration) — zero regressions.

## 0.0.278

- Fixed: files outside the workspace (or in a different folder, in a multi-root workspace) can now be attached — file picker, active file, selection, and diagnostics all use the same shared path check. Traced the full downstream flow before changing it: files inside the chat's own folder still get a clean relative path (unchanged); anything else now gets its absolute path instead of being blocked, using the exact same isAbsolute-path pattern `tabManager.ts` already uses for the `@path`-mention attach flow — which, as a side effect, this fix also unblocks (it was resolving absolute paths but then hitting this same restriction internally). Also fixed the "stale" background re-check (composerState.ts) to resolve absolute paths the same way, so external attachments don't wrongly expire. Verified with a real harness (4 scenarios: same-folder, outside-workspace, different-open-folder in multi-root, unsaved-document-still-blocked) before shipping, not just type-checked.

## 0.0.277

- Internal only, no user-facing change: extracted the file/image/selection/diagnostics attachment-capture logic out of the `tabManager.ts` god-file (2937→2679 lines) into a new standalone, pure `editorTabs/attachmentCapture.ts` (258 lines, zero dependency on chat-manager instance state). First step of a planned multi-phase de-bloat. Every extracted function's body was verified byte-identical to the original via automated diff before wiring in (not just re-read by eye) — two real transcription mistakes were caught and fixed this way before they ever ran. Full gate + real VS Code E2E activation test green, exact match against the pre-change baseline (301 unit tests, 24 integration tests) — zero regressions.

## 0.0.276

- Removed the duplicate follow (⌖) and approval-mode (🛡) toggles from the top sidebar deck. They were rendered in two places — top deck AND composer — for no reason; both are one click away at the input already. Top deck is back to session-level actions only (☰ · title · ✚ · ⋯).

## 0.0.275

- Approval-gate toggle no longer shows a notification at all. The icon flipping IS the confirmation — a popup restating what you just saw happen, with a decision button on top, was double confirmation for one click. Any "chats still on the old setting" detail now lives passively in the icon's tooltip, corrected to say what's actually true (closing/restarting is the reliable way to apply it — a worker holds a chat open until it's closed, not just between turns, so "picks it up when idle" wasn't a claim the mechanism actually backs).
- Fixed the "⋯" more-actions menu (Review last turn / Chat versions / Export chat / Restart π) rendering as plain white with solid blue selection bars — completely inconsistent with the rest of the UI. Root cause: VS Code's native blue button styling was bleeding through because the menu items never explicitly cleared `background`/`border` in their resting state, only on hover. Now matches the glass panel styling used everywhere else. Verified with a real headless-Chrome render in both light and dark theme variables, not just by reading the CSS.

## 0.0.274

- Fixed the approval-gate toggle looking "stuck on": the setting was always flipping correctly, but the 0.0.273 refactor dropped the call that refreshes the chat webview, so the icon never visually updated. Every click now re-renders instantly.
- Fixed notification stacking on rapid toggling: the worker-recycle + notification reaction is now debounced (600ms) so repeated clicks settle to exactly ONE notification reflecting the final state, instead of one per click. (VS Code has no API to dismiss an already-shown toast, so debouncing before showing is what actually achieves "only the latest.")

## 0.0.273

- Approval-gate toggle no longer demands a manual "restart the runtime" click. Researched why a restart was needed at all: confirmed in Pi's own source that a project extension is only loaded once, at process boot — starting a new chat session never re-reads it, only a fresh process does. Instead of a full pool restart (which killed even mid-conversation chats), toggling now automatically recycles ONLY idle workers (nothing was running on them — zero disruption) and re-warms the pool, so new chats get the new setting immediately. Anything already running keeps going untouched and picks it up next time it goes idle; a "Restart π Now" button is offered only when chats are actually still busy, for instant effect if you want it right away.

## 0.0.272

- Reload restores your last chat: the sidebar (the primary surface) was hardcoded to bind to a brand-new blank draft on every single activation — confirmed with certainty in the code, no ambiguity — so every reload silently dropped you onto an empty chat regardless of what you were viewing. It now persists the current chat to workspace storage on every switch/new-chat and restores it on the next reload, falling back to a fresh draft only if the saved workspace folder is no longer open. (Editor-tab chats and any files the follow-agent had open are governed by VS Code's own native tab-restore, which should already bring those back on "Reload Window" if your VS Code hot-exit/restore settings are on — that part isn't something this extension controls.)
- Composer chip: usage now shows ONLY the overall-consumed percentage — token count and dollar cost were crowding the chip and truncating the model name. The chip's max width also grew (260px → 420px) so a full model id has real room. Detailed cost still lives in Usage & cost (π menu) and the model-picker capability line.

## 0.0.271

- Replaced the padlock with a shield-check icon for the approval-mode toggle — a lock reads as "restricted," which is backwards (π can still edit, it just pauses for your OK). Researched this: Claude Code's own VS Code extension hit the exact same "these two states look the same" bug and fixed it with distinct icons and clear labels; adopted their now-familiar naming too — "Auto Mode" / "Ask Before Edits" — so it reads the same way to anyone who's used Claude Code. Verified visually via a real rendered screenshot before shipping, not just hand-traced coordinates.

## 0.0.270

- Fixed "picked a new model but it still errors": forking a session to resend an edited message replays history up to the branch point, which can put the live connection back on whatever model was active at that point — silently discarding a just-picked model. The model is now re-asserted immediately AFTER the fork, right before the resend, guaranteeing the resend actually uses what you picked.
- Fixed a second, real display gap: the structured error card only covered a fully-settled failed turn. Pi's own auto-retry banner (the "retrying..." strip you see during a rate limit before it either succeeds or gives up) had its own separate raw-text path I hadn't touched — it now shows the same status badge and clean message.
- Model picker now shows EVERY model across every provider in ONE list (grouped by provider headers, not a forced "pick provider first" step that was hiding models behind an extra click), sorted highest-version-first within each provider for easier scanning, and fully searchable end to end (separator-agnostic — harness-proven with providers, sorting, search, and clearing all verified against real QuickPick wiring).

## 0.0.269

- MODEL SEARCH IS SEPARATOR-AGNOSTIC: "claude 4.8" now matches an id like "claude-4-8" (or "claude.4.8", "claude*4_8") — previously VS Code's native fuzzy filter did literal character matching, so a space in your query had nothing to match against a hyphen in the id and silently found nothing. Both model pickers (the composer chip and "Retry with a different model") now share one fuzzy matcher that treats -, *, ., and whitespace as interchangeable. Harness-proven end-to-end (real QuickPick wiring, not just the matcher function).
- Consolidated the two separate model-picker implementations into one shared picker — same guided provider→model→thinking flow everywhere now.
- Strengthened diagnostics on edit-and-resend: every step of the pencil-edit flow (button click, model-button click, submit) now posts a debugLog entry visible in Output → Pi. Traced the whole pipeline again end to end — found no code defect (the new code is confirmed present in the shipped bundle, event binding is null-safe) — the most likely explanation for a still-broken report is an already-open chat tab running a pre-0.0.268 cached script. If it still fails after a full reload, the new logs will show exactly which step didn't fire.

## 0.0.268

- API ERRORS SHOWN PROPERLY: a rate-limit/auth/server-error response no longer dumps raw JSON at you. Parsed into a structured card — status badge (Rate Limited / Overloaded / Auth Error / …), the clean human message, model, and a copyable Request ID — with Retry, Retry with a different model, and Logs actions. Falls back to the plain message untouched for anything that doesn't match the parseable shape — never hides information.
- EDIT + RESEND WITH A DIFFERENT MODEL: the pencil-edit-a-message flow now has a "🔀 Different model…" option next to Enter/Esc — opens the same guided provider→model→thinking picker, then resends your EDITED text with whatever you picked. Cancelling the picker aborts the resend cleanly (transcript repaints untouched).

## 0.0.267

- CLAUDE-STYLE MODE SWITCH: a lock icon in the composer deck flips Auto <-> Approve-Every-Edit with ONE CLICK — no settings.json, no manual file editing, no menu. Glows when approval mode is on. “Pi: Toggle Approval Mode” in the palette does the same. Under the hood it's the exact same project-file sync from 0.0.265, now reachable in one click from where you're already working.
- PREDICTIVE PRE-FETCH (③, zero-dependency): a small import scanner we wrote ourselves (regex-based, JS/TS/Python, no external tools) silently warms VS Code's document cache for files locally imported by whatever π is reading or editing — no visible tabs, just a head start for when π touches them next. `piRpc.predictivePreload` (default on).

## 0.0.266

- SESSION REPLAY: the ⧉ Review overlay can now REWIND. ▶ on any turn walks its changed files in order, revealing each one with a violet glow (distinct from live ember) and a cancellable progress notification. ▶ Session in the header replays the WHOLE session, oldest turn first — watch how it evolved, after the fact. Built entirely on the turn history persisted in 0.0.264 and the hunk-diff engine from line-by-line review — nearly free, as planned.
- Fixed a real latent bug found while wiring this: the ≣ line-by-line review action was declared in the message TYPE but missing from the runtime VALIDATION guard — every ≣ click since 0.0.261 was silently dropped before reaching the handler.

## 0.0.265

- TRUE PRE-APPLY APPROVAL (the crucial one, done right this time): `piRpc.requireApprovalForEdits` installs a PROJECT-scoped Pi extension (`.pi/extensions/pi-approval-gate.ts`, registered in `.pi/settings.json`) that intercepts every file-mutating tool call BEFORE it runs — Allow / Allow rest of turn / Deny. The change never touches disk unless approved. Rides Pi's own documented `tool_call` hook and the same extension-UI subprotocol our approval cards already render, so it works instantly in both chat surfaces with zero new UI code. Applies everywhere π runs for this project (VS Code, terminal, CI) — a real policy, not a VS-Code-only overlay. Toggling prompts to restart the π runtime.

## 0.0.264

- ⧉ Review history now survives reload/restart: turns persist to workspace storage (last 10, same as before) and restore on activation. Durability fix underneath: each turn’s git-stash snapshot — previously a DANGLING commit `git gc` could prune — is now rooted under its own ref (`refs/pi-review/...`), deleted automatically when it ages out of the 10-turn window. Nothing unbounded, nothing lost.

## 0.0.263

- Followed files stay open: each file π reads or edits opens as its own persistent tab (no more single cycling preview slot), so you can flip back through everything touched this session. Focus never leaves your cursor.

## 0.0.262

- REALTIME AGENT CARET: while a turn runs, a live “⟵ π” marker travels through the file to the exact line the agent is reading or editing RIGHT NOW — updated every snapshot (throttled), anchored on text that exists before the write even lands, auto-scrolling to stay in view. You literally watch π’s position move line by line, across files, in realtime. Clears when the turn ends.

## 0.0.261

- LINE-BY-LINE REVIEW (Zed’s single-file review, in VS Code): from the ⧉ Review overlay, hit ≣ on any file — the REAL file opens with per-hunk CodeLens controls: “π −n +m · ✓ Keep · ↩ Revert” above every changed region (green tint + before-text on hover), plus Keep all / Revert all / Done at the top. Revert applies a surgical edit restoring just that hunk from the turn snapshot; hunks recompute live as you or π keep editing.
- Cmd/Ctrl+Enter when sending = follow THAT turn even with the crosshair off (Zed parity).
- macOS: system stays awake while any turn runs (caffeinate; piRpc.preventSleepWhileBusy).
- Optional completion sound for background chats (piRpc.soundOnComplete, default off).

## 0.0.260

- 🗑 deletes immediately — no confirmation modal. Row vanishes, runtime stops, file removed, one click.

## 0.0.259

- Tracking heartbeat: while any chat runs, the status bar shows “👁 π watching files…” — so an idle net is visibly ALIVE, not silently ambiguous. Activity replaces it with the file being touched, then it returns to watching until all chats go idle.

## 0.0.258

- Deleting chats is instant: the row disappears optimistically and the sessions-dir rescan runs in the background (it was awaited — the slowness). Active sessions delete cleanly too: their runtime is aborted+stopped fire-and-forget, tabs close, and the sidebar rebinds to a fresh draft when you delete the chat you’re on.

## 0.0.257

- FS-TRUTH TRACKING: follow no longer depends on parsing tool args. While any chat is BUSY, a workspace file watcher arms itself — ANY file created/changed (bash heredocs, sed -i, subagents, MCP tools, scripts) is tracked and followed, attributed to the busy chat. The tool layer stays as the precision pass (reads, offsets, glow needles); the watcher is the net that can't be fooled. Junk excluded (node_modules/.git/dist/logs/dotfiles), your own active-editor saves ignored, per-file debounce, auto-disarms 5s after all chats go idle.

## 0.0.256

- THE BIG ONE (found via choke-point tracers in the user’s logs): Pi v0.87 streams hundreds of state events per second and every event ran a FULL snapshot render — the extension host saturated (9+ renders per millisecond), async timers drifted ~12s, so follow “worked” but opened files long after turns ended (invisible). Renders are now coalesced per chat: instant leading edge + one trailing render per 50ms window. Everything downstream (live tracking, glow, digests) lands on time; tracer noise removed.

## 0.0.255

- Live tracking follows EVERYTHING now (harness-proven): the previous fix guessed history-vs-live by call COUNT, which swallowed real scaffolding work (fast agents emit 3–5 calls per streamed snapshot — only sparse reads survived, hence “only package.json”). New rule: a 1.5s grace window after a chat binds absorbs the switch/reload backfill; after that, every call follows — bursts included.

## 0.0.254

- Deck ✚ now dismisses the switcher/review overlay before opening the new chat (the fresh chat was appearing hidden behind the list).

## 0.0.253

- Follow is live-only now, harness-proven: switching chats or reloading delivered the transcript as a burst that REPLAYED every historical edit/read as “live” (phantom file-opens; only long-dead files → nothing visible; this was also the old tab-pileup source). Bursts >2 unseen calls are absorbed silently; genuine activity (1–2 calls per update) follows instantly.
- Pi’s ~-prefixed tool paths expand to the real home dir (they used to become <workspace>/~/… and always failed).
- Sidebar attach/switch now log to the Pi channel for future diagnosis.

## 0.0.252

- Chat delete is back: ☰ switcher rows show 🗑 on hover — native confirm modal, session file removed, list refreshes; deleting the chat you are viewing hands the sidebar a fresh draft automatically.

## 0.0.251

- Transcript scrollbar no longer kisses the composer: the reserved band grew (dock height + 48) and the scroller ends with real margin above the dock.

## 0.0.250

- Pressing Enter on an empty composer is a silent no-op (it showed “Attachments need attention. Enter a message or attach something to send.” — an attachment warning for… not typing). Real preflight problems (attachments too large, expired images) now use the honest title “Can’t send yet.”

## 0.0.249

- Review earns its place: the always-there collapsible tree is GONE. A ⧉ badge appears in the deck ONLY when π actually changed files; clicking it opens Review as a full surface over the chat (same pattern as ☰) — turns → files with +/− counts, click = diff, ↩ per file or whole turn (modal-confirmed), Esc back to chat. Empty state costs zero pixels.

## 0.0.248

- Quiet by default: notifications only when you are NOT watching. “Watching” now includes the sidebar chat (it never counted before, so completions toasted in your face). Turn-complete + files-changed notices are suppressed while the chat is visible and the window focused; removed redundant info toasts (follow on/off, thinking level set, change undone, reverted N files) — state is visible in the UI itself. Warnings/errors still always surface.
- Switcher overlay anchors below the command deck instead of overlapping its lower half (fixed 37px assumption vs real layout padding).

## 0.0.247

- Switching chats from the sidebar WORKS: the sidebar controller key now follows the bound session (a constant key pinned the first controller forever, so picking a chat silently did nothing). Each picked session gets its own controller, tab-style.
- Header per spec: ☰ is the only switcher trigger; the title is a passive label shown only when a named chat is active (fresh drafts show nothing).

## 0.0.246

- ONE-SURFACE SIDEBAR: the stacked Chat + Chats squeeze is gone — the chat IS the π sidebar. New command deck header: ☰ / title ▾ open the chat SWITCHER as an overlay sliding over the conversation (search · ✚ New Chat · this workspace · Other projects; Esc closes, pick rebinds in place); ✚ new chat; ⌖ follow crosshair; ⋯ menu (Review last turn · Chat versions · Export · Restart). The separate Chats view is removed — its data powers the overlay.
- Activation E2E green.

## 0.0.245

- Sidebar chat connects: its controller now actually STARTS on attach (it only rendered before — stuck at “Connecting to π” forever).

## 0.0.244

- THE ZED LAYOUT: π Chat now lives in the SIDEBAR (π activity bar → Chat) — full chat experience docked left (own persistent session, survives reloads), leaving the CENTER for real editors. “Pi: Open Chat in Sidebar” focuses it.
- Follow, done the Zed way: with the center free, π opens the REAL file it is reading/editing in one preview slot (no tab pileup), reveals the exact region and glows it ember with chat attribution. Auto-skips when a π chat tab owns the active group. Crosshair still rules; every decision logged.
- Per-change approval on edit cards: ✓ Keep · ↩ Undo (surgically reverts that change) · ✎ Edit (opens the file at the change) — in both the sidebar chat and chat tabs.
- Activation verified by the VS Code E2E (exit 0).

## 0.0.243

- Removed the in-chat split pane (superseded by the upcoming sidebar-chat layout). Follow currently narrates via the status bar + Pi output log; per-change Keep/Undo/Edit plumbing stays for the tool-card integration.

## 0.0.242

- Fixed the empty split pane overlaying the chat: the pane’s display:flex was defeating the hidden attribute, so an inert glass sheet covered the transcript whenever follow was off — hidden now always wins, the pane DOM isn’t even created until there’s something to show, and the chat reclaims full width the moment the pane hides.

## 0.0.241

- SPLIT VIEW INSIDE THE CHAT TAB (the architecture you asked for): one π tab, internally split — conversation left, π’s live file mirror right (syntax-highlighted, ember glow on the region being written, reads jump to their offset). Draggable divider (width remembered), filename click opens the real file, ✕ = crosshair off. No VS Code tab/group APIs — tab pileups and placement bugs are structurally impossible.
- PER-CHANGE APPROVAL: every edit π makes this turn appears as a card under the mirror — compact −/+ diff with Keep ✓ / Undo ↩ (reverts exactly that change in the file) / Edit ✎ (opens the real file at the change). VS Code-style change review, per edit.
- editReplacements now understands all of Pi’s edit dialects (oldString/newString, edits[], appendContent, symbol+content) — fused tool-card diffs get richer too.

## 0.0.240

- CRITICAL FIX: activation was hard-failing since 0.0.234 (“Missing command handlers: piRpc.reviewOpenDiff/RevertFile/RevertTurn”) — the Review panel registered its commands outside the central registrations map, tripping the startup self-check on the next window reload (no commands, no chats). Handlers now flow through the map; a new static gate test enforces manifest⇄handler parity forever; the VS Code E2E suite runs green again (test-electron updated for the Code binary rename) and proves activation.

## 0.0.239

- π Screen placement is deterministic and focus-independent: an existing π Screen tab is the source of truth (drag it anywhere ONCE — remembered forever); otherwise it opens in the numeric column right of the chat. ViewColumn.Beside is never used (it honored openSideBySideDirection=down and split UNDER the chat). If layout quirks park it next to the chat, one honest toast explains the one-time drag. Cold tab shows a “waiting for agent activity” placeholder.
- Note: tabs restored on reload from pre-238 versions are old real-file tabs (close them once) — π Screen never creates real-file tabs, so the pileup cannot recur.

## 0.0.238

- π SCREEN (clean architecture, no more tab pileups — ever): the follow pane is now ONE virtual document (pi-screen://) in the right split. It MIRRORS whatever file π reads or edits, swapping content in place — real syntax highlighting per file, ember glow on edited regions, reads jump to their offset, huge files auto-window. The header line names the file and chat and is a LINK to the real file for hand-editing. Two tabs total: your chat, π’s screen. Harness-proven single-tab invariant.

## 0.0.237

- Follow pane is one live slot (Chrome split-view style): the right split reuses a single preview tab as π moves file-to-file — chat left, current file right, never a tab pileup. Edit a followed file yourself and it pins; π keeps cycling beside it. Turn history lives in the Review panel.

## 0.0.236

- Follow pane is now geometrically RIGHT of the chat, always: π creates its own right split (newGroupRight) and hands focus straight back — no more bottom-split placement when workbench.editor.openSideBySideDirection is “down”; the group is remembered and recreated if closed.

## 0.0.235

- Plan strip: when π writes a task list, it pins above the chat as live progress — ember bar, n/total, expandable checklist (collapses out of the way; open state survives re-renders).
- Turn navigator: j / k (or Alt+↓ / Alt+↑) jump between your prompts with a flash — skipped while typing.
- Swarm v2: a live progress notification counts workers as they finish (“2/4 — auth finished”), cancellable, with the completion digest at the end.

## 0.0.234

- π REVIEW PANEL (flagship): a persistent Review tree in the π sidebar — the last 10 agent turns, each expandable into every file it touched with +/− line counts; click a file for the before↔after diff, inline ↩ reverts a file or a whole turn. The trust loop for agentic edits.
- Hygiene: context-pressure stats RPC only for visible chats; swarm watches get a 30-min failsafe; scripts/check-host-drift.mjs guards the host fork against Pi upgrades (baselined); gate:full = gate + VS Code E2E + drift check.

## 0.0.233

- Follow-agent verified end-to-end with a harness (opens right-of-chat, separate tab, focus preserved) — the reported “nothing opens” traced to piRpc.followAgent persisted as off plus a bash-only test (pwd touches no file, by design).
- The crosshair always answers now: toggling ON confirms with a toast (and opens the current file if π is on one); toggling OFF says so; every follow decision (act/skip/open/give-up + reason) is logged to the Pi output channel.

## 0.0.232

- No more gray slabs: thinking/tool/result cards, work phases and code blocks are now truly translucent (foreground whisper over the ambient glass, hairline borders) and card text is back to full contrast — labels at 85%, thinking prose at 82%, bodies at 100%.

## 0.0.231

- Input overlap fixed: the transcript-clearance observer re-attaches after every render (morphdom could swap the dock node — e.g. when the Working banner mounts — freezing the spacing), plus a larger breathing buffer.
- Follow pane, single-container feel: π’s files now open in the split DIRECTLY RIGHT of the chat (chat column + 1) as real separate tabs (no preview reuse), and clicking the crosshair ON immediately opens the file π is currently working on.

## 0.0.230

- Zed’s crosshair, for real: a follow toggle lives in the composer (crosshair icon, ember when active, aria-pressed). While on, the side editor tracks EVERY move — files π opens/reads/edits, the offset it reads from, and the LINE it is writing while edit args stream in (throttled live reveal, Zed-cursor style). Click to stop/start; state syncs with piRpc.followAgent.

## 0.0.229

- Follow pane actually opens now: it keys off the chat panel’s real visibility (live updates carried active:false, so it never fired), and brand-new files retry opening until the write lands on disk (0.8s/2.2s backoff).

## 0.0.228

- π’s live screen (Zed-style follow, done right): a SIDE editor group now follows the agent — every file π reads or edits appears there live in one reused preview tab (chat on one side, the agent’s working file on the other). Reads jump to the offset being read; edits glow ember with hover attribution (“edited by π — <chat>”); focus never leaves your cursor; background chats narrate in the status bar only.

## 0.0.227

- FOLLOW THE AGENT (Zed-style live file activity): as π works, the status bar shows “π · editing foo.ts” / “reading bar.ts” (click to open); the file being EDITED opens in a preview tab without stealing focus, and the edited region glows ember with an overview-ruler mark. Background chats stay in the status bar only — no tab thrash. piRpc.followAgent: open (default) · status · off; “Pi: Toggle Follow Agent” cycles modes.

## 0.0.226

- Chat settings is a guided flow now: 1/3 pick the provider → 2/3 pick that provider’s model (thinking capability, context and image support shown per model) → 3/3 pick the thinking level for that model (skipped automatically for models that can’t reason).

## 0.0.225

- ONE settings box: clicking the composer chip opens a single centered picker with models (grouped by provider) and thinking sizes (off→max) under them — choose either from the same window. Palette: “Pi: Chat Settings (Model & Thinking)”.

## 0.0.224

- Transcript now ends ABOVE the composer — messages never slide underneath the input; the scroll floor tracks the dock’s live height (auto-grow included).

## 0.0.223

- Thinking level is one click too: a dedicated pill next to the model chip opens the centered picker (off/minimal/low/medium/high/xhigh/max, current level checked) — same pattern as model selection.

## 0.0.222

- One-click model switching: the composer chip now opens the centered model picker directly (no intermediate popover). Thinking level stays in the π menu; usage stays in the palette/sidebar.

## 0.0.221

- Nested-frame audit, all fixed: composer textarea border (the real double frame), find-bar inner input, assistant bubbles (now open canvas — no more frame around tool cards), cards inside work phases (hairline list), code blocks inside tool cards, attachment tray.
- Model/status chip moved to the left cluster before + and / — the send corner breathes; its popover opens upward-left.

## 0.0.220

- Composer is ONE clean frame: removed the inner card border + opaque background that drew a second box around the input (and blocked the glass).

## 0.0.219

- Model/status popover now opens UPWARD above the composer (it fell off-screen below the fixed dock) with ember hover rails instead of the solid blue bar — matching the + and / menus.
- Light-theme glass actually shows: stronger ambient warmth, clearer dock translucency, readable near-opaque menus; the composer input is transparent so the frosted dock reads through; ember focus ring replaces the blue outline.
- Live turns stay calm: finished phases fold WHILE the agent still works — only the active phase stays expanded (errors always stay open).
- Approvals answer to the keyboard: Y = Allow, N = Deny (ignored while typing).
- Fixed a broken high-contrast selector from the previous pass.

## 0.0.218

- Glass you can SEE: ambient depth gradients behind the chat, and the composer now floats OVER the transcript — messages scroll behind real frosted glass (blur+saturate), with the transcript auto-clearing the dock's live height.
- Consistent tab widths: π chat tabs pad/ellipsize to one width so the tab strip stops looking ragged (piRpc.tabTitleMode: consistent|full, default consistent; piRpc.tabTitleWidth, default 20).

## 0.0.217

- Refined Glass pass 2 — FULL coverage: approval cards (glass + ember Allow), recovery/restricted banners, composer status chip, attachment tray, code blocks with glass headers and ember copy hover, floating message actions, boot ambiance, thin modern scrollbars, and the entire sidebar (search, rows, active ember edge, dividers, buttons). High-contrast resets included.

## 0.0.216

- REFINED GLASS: new visual language — layered translucent surfaces (theme-adaptive via color-mix), real glass (blur + elevation) on the composer, menus, find bar and retry banner, ember-gradient send button with glow, messages rise in, and the streaming answer breathes with a soft ember pulse. High-contrast themes keep honest borders; reduced-motion respected.

## 0.0.215

- Find in chat: typing now jumps straight to the first occurrence; each Enter advances to the next (Shift+Enter back), wrapping into older history.

## 0.0.214

- Collapsed work phases now say WHAT happened — "Worked: bash ×3, edit ×2 · 2 files changed" (thinking-only turns read "Thought it through") — with a subtle SHOW WORK affordance instead of a meaningless step count.

## 0.0.213

- CALM TIMELINE: settled turns collapse their thinking/tool runs into one "N steps · M files" chip (live turn stays expanded; failed phases stay open with an error tint; open state survives re-renders).
- Find in chat (Cmd/Ctrl+F, π menu, or "Pi: Find in Chat"): jump-to-reference search with highlighted matches, Enter/Shift+Enter stepping, auto-opens collapsed phases containing hits, and continues INTO older history when matches run out in the loaded window.
- One composer status chip (model · cost · thinking) with a detail popover — replaces the chip strip.
- Notification digest: parallel-chat toasts (finished / needs approval / context) coalesce into one message.
- Retry banner moved next to the composer (it rendered off-screen at the transcript top).
- Sidebar: "Other projects" is collapsed by default (state remembered) and rows show recency only.
- Hygiene: controller-keyed maps are WeakMaps (closed chats no longer pin memory); allowlist⇄renderer sync test; 6 golden-HTML contract tests.

## 0.0.212

- Hardening release (architecture review items, in order):
  1. SECURITY: the chat webview can now only invoke a fixed allowlist of commands — an HTML-escaping bug can no longer escalate to arbitrary VS Code command execution.
  2. Tab/session identity unified into one SessionIndex module (bindings, owners, keys) — deletes the drift-bug class behind this week's draft/live-update issues.
  3. Chat-operations commands extracted from the extension entrypoint (2,611 → 2,321 lines) into src/commands/chatOps.ts.
  4. The full test gate (typecheck + lint + 259 unit + 23 integration) is now one npm script and ran green; an environment-coupled legacy test self-skips instead of failing.
  5. PATH-pi compatibility gate: a different-MAJOR pi is never fed to the shared-runtime host fork (falls back safely); newer minors warn once.
  6. Versioned persistence store (piRpc.storeVersion) — one namespaced accessor with a migration hook.
  7. Golden-HTML contract tests pin the full renderer output for canonical turns (fused tool card, error turn with retry banner).

## 0.0.211

- Tool call + result fusion now works for the REAL streaming shape: results that arrive as separate messages are folded into the assistant turn that made the call (matched by toolCallId, else the nearest owning turn) and rendered inside the SAME card as the call. Results with no owning call remain standalone.

## 0.0.210

- Tool calls and their results are now ONE fused card: the result nests inside its call (collapsed with a line count when long, open when short or failed, with a red failed flag). No more guessing which result belongs to which call; JSON results keep the structured table view.
- Honest error UX: a live retry banner shows Pi's ACTUAL retry reason and attempt number (from the auto-retry events); the empty-response fallback no longer speculates about rate limits; failed turns already show the provider's verbatim error.
- The answer card is labeled "π Response" (a lone π read oddly).
- Housekeeping: morphdom is now a declared dependency (was a stray transitive install that got pruned).

## 0.0.209

- The Pi output channel now strips terminal escape sequences (ANSI colors, OSC ]777 notifications, carriage returns) that Pi and its extensions emit — logs are clean, readable text.

## 0.0.208

- FIX: after 0.0.207's in-place draft binding, bound chats stopped updating live (responses only appeared after reopening the tab). The webview host registry was keyed by session key, which the binding changes for the same URI — hosts are now keyed by the stable resource URI, so live repaints always find their tab.

## 0.0.207

- FIX: sending the first message in a New Chat no longer flickers (a session tab visibly opened while the draft tab closed). The draft tab now keeps its URI forever and is BOUND to its session in place — bindings persist across reloads. Bonus: every New Chat click now opens its own fresh draft (drafts have unique identities).

## 0.0.206

- Code blocks in responses now offer Copy only — Insert/New-file buttons were noise; file changes go through the agent's edit-tool cards (Open file / Open changes).

## 0.0.205

- Failed turns now show the PROVIDER'S real error in the chat (same text as the TUI) with a Retry button — no more generic "empty response" guessing.
- macOS privacy fix: turn review skips repositories rooted at your home directory (git walking ~/Library//Documents triggered "access data from other apps" prompts).
- Context meter: sidebar shows a chat's context fill from 60% (orange at 85%+) and a warning fires before auto-compaction can surprise you.
- π Swarm: "Pi: Fan Out to Parallel Chats…" runs one prompt template across up to 6 parallel chats with a consolidated completion notification.
- Attach Git Diff / Staged Diff / Terminal Selection to the chat from the π title-bar menu.
- Connection health now shows the runtime pool (workers + session counts).

## 0.0.204

- Runtime workers moved out of the extension host into separate OS processes on your system Node. Worker threads inside the extension host crawled during window startup (the process is saturated by extensions activating — 13-16s boots regardless of caches) and Electron's Node silently lacks the compile-cache API. Separate processes schedule independently and system Node >=22 enables the V8 bytecode cache for real: measured cold boot 1.5s, cached boots 0.7s, New Chat adoption 1ms. Falls back to Electron-as-Node when no system Node exists.

## 0.0.203

- Runtime boots are now momentary after the first one: workers enable a V8 compile cache (globalStorage/v8-cache), so Pi's ~13k-module import loads from bytecode on every later boot (measured 3.0s → 1.0s per worker; the very first boot after an install/update still compiles once).
- Warmup order: the New-Chat draft parks as soon as worker #1 is warm (was: after the whole pool).
- The "warming up" hint in the loader only fades in when a boot exceeds 4s — quick boots show just the spinner.

## 0.0.202

- The runtime pool now warms at VS Code startup: all workers boot serially in the background (ping-verified), then a draft session is parked — measured 3 workers ready in ~2s, New Chat adoption ~0ms. Nothing waits for your first click anymore. Trade-off: idle workers hold memory (~150MB each); tune with piRpc.runtimeWorkers.

## 0.0.201

- FIX: 0.0.200's pool could make startup SLOWER — at activation two workers cold-booted simultaneously, contended on CPU, blew the 20s open timeout, and chats fell back to per-chat processes with a ~10s version probe (~45s total). Now: never boot a second worker while one is cold (queued opens ride the booting worker), cold boots get 60s headroom, abandoned opens are closed (no orphan sessions), the version probe is skipped for our own bundled/managed installs, and the prewarm waits out the activation storm. Measured: two cold opens now ready in ~5s on one worker; the pool grows only once warm.

## 0.0.200

- CPU-aware runtime pool: parallel chats now run across a pool of runtime workers sized to your CPU ('auto' = cores/4 capped at 4; piRpc.runtimeWorkers pins 1-8). Sessions stick to their worker; a worker crash faults only its own sessions and the pool self-replaces. On a 14-core machine, 3 chats generate truly in parallel instead of sharing one thread.
- Off-main-thread indexing & search: the all-projects sidebar scan and full-text chat search now run in a dedicated worker with an mtime-validated cache — zero extension-host jank, instant repeat searches, automatic inline fallback if the worker is unavailable.
- Idle session reaper (piRpc.idleSessionMinutes, default 15): hidden idle chats release their runtime session after N minutes; the tab and transcript stay put and the session restarts instantly on focus. Busy chats, approval-waiting chats, and drafts are never touched.

## 0.0.199

- Chat typography matched to the Claude Code look: prose now uses the native UI sans (SF Pro / Segoe UI) instead of the editor font, with antialiased smoothing and a 1.55 line rhythm. Code spans/blocks keep the editor monospace. piRpc.chatFontFamily still overrides.

## 0.0.198

- Pasted images now send immediately with the message — the confirmation preview popup is gone. That popup path also bypassed the composer clear guards, which is why image sends left your text in the input; the input now clears instantly on submit, images included.

## 0.0.197

- The agent is now consistently the π symbol across the chat: message author label, timeline answers, status (π is replying), loader phases, composer placeholder, queue tray, and approval prompts.

## 0.0.196

- Tables: roomier header band (taller, no wrapping) and more air above/below the table so it separates cleanly from surrounding text.
- Branding: the activity bar and chat editor now use the π symbol instead of the word Pi.

## 0.0.195

- Markdown tables redesigned (orange accent): no outer frame or cell grid inside the message card (the box-in-box is gone) — hairline row separators, brand-orange header text + underline, soft orange row hover.

## 0.0.194

- Pi on your PATH is now detected and used AS-IS (its npm package root powers the shared runtime) — no duplicate copy, no self-updates of it.
- New setting piRpc.autoInstall (default FALSE): the extension never downloads Pi from npm without consent. With no PATH pi, no managed copy, and the flag off, chats stay offline and the Pi logs + an actionable notification explain exactly what to do (install manually or enable the flag). Flip it on and the extension installs/updates the latest Pi automatically as before.

## 0.0.193

- FIX (final): sent text reappearing in the input. On top of the persist-layer gates (0.0.183/0.0.192), the webview now sanitizes at its single render entry point: any snapshot whose draft equals the just-submitted text renders as empty AND triggers a corrective scrub of the persisted draft — covering unfocused renders and fresh webviews (draft-tab promotion) that earlier guards missed.

## 0.0.192

- FIX: very long messages reappeared in the input after Enter. With a large draft, the (slow) async draft-persist could be overtaken by the send's clear — the stale write then restored the sent text and rolled back the reset sequence. Draft writes now re-check the LIVE reset sequence in the same microtask as the write, so a send can never be undone by an in-flight draft update.

## 0.0.191

- Loader: the squiggly ring is now a complete circle (no spinner gap); its rotation carries the wave around the glowing Pi.

## 0.0.190

- Boot loader refined: a squiggly (wavy) spinner ring rotates around the glowing, swaying Pi mark — replacing the outward ripples.

## 0.0.189

- The Pi chat-actions button is now the FIRST icon in the editor title bar.
- New boot loader: the orange Pi mark sways and glows at the center while sonar waves ripple outward (respects reduced-motion).

## 0.0.188

- The chat-actions button in the editor title bar now uses the orange Pi icon instead of a kebab menu (which duplicated VS Code's own overflow dots).

## 0.0.187

- Chat actions (rename, retry, retry-with-model, chat versions, copy as Markdown, export HTML, thinking level, compact, review last turn, restart, health, logs, help) moved from the in-chat ⋯ menu to a native ⋮ submenu in the editor title bar, next to other extensions' icons. The in-webview header strip is gone entirely — the transcript starts at the top of the tab. The multi-root workspace picker moved into the composer toolbar.

## 0.0.186

- Chat tab icon is now the brand orange Pi mark (the previous currentColor SVG rendered black and was invisible on dark themes).

## 0.0.185

- Removed the duplicate chat title inside the webview — the editor tab (now with the Pi icon) already shows it; the header keeps only the actions.
- README/marketplace description refreshed to match the current architecture: managed auto-install (no manual Pi setup), shared runtime with parallel per-tab sessions, Mission Control, turn review, chat versions, all-projects sidebar + full-text search, quick switcher.

## 0.0.184

- Chat tabs now show the Pi icon (custom editor tabs previously had no icon).

## 0.0.183

- FIX: sent text no longer reappears in the composer. Two causes: (1) a trailing debounced draft-update (typed just before Enter) arrived after the send cleared the draft and re-persisted the sent text — draft updates now carry the composer reset sequence they were typed under and stale ones are dropped; (2) draft capture/restore used the controller's current-session identity, which drifts from the tab after forks/prewarm-adoption and could resurrect stale text — both now use the owning tab's identity.

## 0.0.182

- FIX (the real one): New Chat stuck on "Connecting to Pi…". Logs showed the draft's Pi was READY in ~120ms — but the tab kept rendering a placeholder: the prewarm-adopted session already has a sessionFile, so the draft tab's identity no longer "matched" its controller and the renderer fell back to a cached/connecting view. A tab now always renders its OWN controller's live state.
- FIX: sending the first message in a New Chat reuses the adopted fresh session instead of creating a second one.
- FIX: MCP tools failed to initialize ("stale ctx") in every chat after the first in a project — reverted the per-project services cache introduced in 0.0.180; each session builds its own extension runtime again (the prewarmed draft still makes New Chat instant; ModelRuntime stays shared).
- FIX: the workspace dropdown that appeared in the chat header (single-folder windows) — it listed one entry per open chat instead of real workspace folders. It now only shows for true multi-root windows.

## 0.0.181

- FIX: "New Chat" stuck on "Connecting to Pi…" when other chats were open. The New Chat command still used the pre-parallel flow: it called newSession() on the ACTIVE chat's controller (yanking that chat onto a fresh session) and left the new draft tab's own controller orphaned. New Chat now simply opens a draft tab — the draft owns its controller (adopting the prewarmed session) and is promoted on your first message.

## 0.0.180

- PERF: chats in the same project now share loaded services (extensions/skills/settings scan) inside the shared runtime — opening a 2nd+ chat went from ~2s to ~20ms. MCP servers remain per-chat (isolation preserved).
- PERF: a draft session is prewarmed at idle, so New Chat opens instantly.
- Mission Control: status bar shows open/running/waiting chat counts (click to jump to any chat); sidebar rows get live pulsing badges (generating / waiting); a background chat blocked on an approval now raises a notification with "Open Chat".
- FIX: permission dialogs now work in every parallel chat (controllers created after activation were never wired to the dialog broker).
- Turn review: when a turn changes files, review a consolidated list — open before↔after diffs, revert one file or all (git snapshot per turn; setting piRpc.turnReview).
- Chat versions: "Pi: Show Chat Versions" lists the fork lineage of the current chat (every edit forks a version) and opens any earlier version.
- Full-text search: the sidebar search now also matches chat CONTENT across all projects (results under "Message matches").
- Quick switcher: "Pi: Switch Chat…" (Cmd/Ctrl+Alt+P) fuzzy-jumps to any chat in any project.
- "Pi: Show Usage for All Open Chats" — aggregate tokens/cost across parallel chats.
- "Pi: Restart Shared Runtime" — one-click host self-heal.
- FIX: turn-completion notifications now track each parallel chat separately (was folder-keyed).

## 0.0.179

- Sidebar now shows ALL your chats: the current workspace's chats first, then an "Other projects" group listing every chat from every other project folder (Pi stores sessions per cwd — previously only the current workspace's were visible). Clicking one opens it running against its own project directory. Worktree checkouts get readable badges (agent-registry/main), temp-dir sessions are hidden, and the list cap was raised to 300+200.

## 0.0.178

- Sidebar: renamed chats no longer appear to "spread" their name — every message edit forks a new session file that copies the parent's history (including its name), and the stale parent file kept showing as a separate chat. The sidebar now collapses those stale fork ancestors (a session is hidden when a newer session forked from it and it has no activity since); deliberately cloned chats stay visible.
- Opening a chat no longer freezes the UI: the tab paints instantly with a loading state and Pi starts in the background (previously the click awaited managed-update checks, worker boot, and per-session extension/MCP load — up to ~10s).
- The managed Pi update check no longer blocks anything: updates download in the background to a staging area and apply atomically on the next reload.
- New larger, animated chat loader with phase text (Starting Pi / Loading chat / Connecting to Pi).

## 0.0.177

- TINY VSIX + LATEST-PI BOOTSTRAP: Pi is no longer vendored inside the VSIX (was 24 MB / 13,042 files; now ~1 MB). piSource now defaults to 'managed': on first run the extension bootstraps the LATEST Pi from npm into its own storage (needs npm + network once), and on later activations it silently self-updates to the latest Pi before the first session starts. The shared-runtime host loads Pi from that managed install (vendor/ remains a dev-only convenience). Existing chats/sessions are untouched; set piRpc.piSource='external' to keep using your own pi.

## 0.0.176

- SHARED RUNTIME (Option D): all chats now run on ONE shared Pi ModelRuntime via a single host worker (host/pi-multi-host.mjs) that hosts many AgentSessions at once — true parallel chats WITHOUT one OS process per chat. Massive memory win vs per-tab processes. New setting piRpc.sharedRuntime (default on); supervisors fall back to a per-chat process if the host can't open.

## 0.0.175

- PARALLEL CHATS (Bug 2): each chat tab now owns its OWN Pi process/controller (keyed by session, not folder), so multiple chats run independently at the same time. Closing a tab tears down its Pi.
- Edit stays in the same chat (Bug 1): a tab repaints from the controller that OWNS it, so an edit/fork keeps the same tab (no new chat). Removed session-switching on the shared controller.
- Message edit/copy icons moved to the top-right of each message (hover-revealed).

## 0.0.174

- Approach 2 (inprocess): run the bundled Pi IN-PROCESS on a worker thread (no subprocess) via piRpc.piSource=inprocess. Reuses the same RPC transport; a worker-local process.cwd override gives Pi the workspace dir without touching the host.
- Approach 3 (managed): piRpc.piSource=managed auto-installs Pi into the extension globalStorage on first use (keeps the VSIX small; needs npm+network once).
- Refactored process launching behind a PiProcessHandle (subprocess | worker) selected by piSource (bundled default | inprocess | managed | external), each with automatic external fallback.

## 0.0.173

- Approach 1: the Pi agent is now BUNDLED with the extension (vendor/pi) and runs on VS Code own Node 24 runtime (ELECTRON_RUN_AS_NODE) — no external install required. New setting piRpc.piSource (bundled default | external); falls back to external automatically if the bundle is missing.

## 0.0.172

- JSON in Pi answers is now rendered as an easy-to-read structured table (same renderer as tool output), with a Raw toggle to view/copy the original JSON. Only applies to json fences / unlabeled fences that actually parse as JSON; other languages stay as code blocks. Deeply nested JSON now pretty-prints instead of dumping one-line raw.

## 0.0.171

- Scroll-to-latest button is now a perfect circle (fixed min/max dimensions + aspect-ratio so surrounding layout / global button padding can no longer make it oval).

## 0.0.170

- Modernized the scroll-to-latest button: cleaner chevron icon, bottom-center placement (in the reading flow, above the composer) with a subtle shadow and hover lift.

## 0.0.169

- Removed content-visibility virtualization that made scrolling noisy (messages re-measuring as they scrolled into view) and made scroll-to-bottom run downhill. With morphdom + windowing the transcript renders with stable real heights, so scrolling and scroll-to-bottom are smooth/instant.

## 0.0.168

- Eliminated transcript flicker while the agent works: the chat now patches the DOM with morphdom instead of rebuilding it every update, so unchanged messages stay put and the scroll position is preserved (no more jumping to the top). Removed content-visibility (its estimated heights caused the scroll jank).
- Moved the scroll-to-bottom button into the messages area (sticky), out of the composer/input.
- Reduced notification spam: Pi info/warning notifications now show transiently in the status bar instead of stacking as toasts; only errors get a toast.

## 0.0.167

- Major chat-switch performance fix for large sessions: the transcript now reads only the tail of the session file (~19ms) instead of the whole file (~200ms for 40MB), windows the message list, and no longer re-fetches the full 11MB+ active branch over RPC on every switch. Switching is now dominated only by Pi loading the session.

## 0.0.166

- Fixed frozen UI + timeout noise when several chats are open: the loading state now uses a dedicated switchingSession flag instead of connectionState, so concurrent session switches (one Pi per folder) no longer deadlock the readiness wait. Readiness timeouts during switching are logged, not shown as an error toast.
- Removed the extension-version activation toast and the webview build badge (noise).

## 0.0.165

- Fixed "Timed out waiting for Pi to be ready" when selecting a chat: the loading state was set before the readiness wait, deadlocking it. Now readiness is confirmed first, then the loader shows. Restored warm-start so Pi is live for instant switching.

## 0.0.164

- Chat selection is now instant: clicking a session in the sidebar highlights it immediately, opens the tab right away, and shows a "Loading chat…" loader while the session reconciles in the background (the recent-list refresh and reconcile no longer block the tab from appearing, and the previous chat is no longer shown until the new one loads).

## 0.0.163

- Fixed the sent text reappearing in the composer after pressing Enter: a re-render (including an authoritative composer reset or one while the composer is unfocused) can no longer repopulate the just-submitted text. Typing clears the guard so re-typing the same text still works.

## 0.0.162

- Fixed stuck "Working…" animation after the agent responds (and the follow-on regressions: follow-ups queuing, input not clearing). The UI now returns to ready on agent_end instead of waiting for agent_settled, which post-turn work (memory_search/qmd, summarization) can delay or drop. Stays busy only while compacting.

## 0.0.161

- Inline edit now uses a lean IN-PLACE fork (RPC fork + transcript refresh, no full reconcile), so editing branches within the SAME session/tab instead of spawning a new tab and a new sidebar session entry.

## 0.0.160

- Stop the extension creating orphan chat sessions on every activation: warm-start now only resumes an existing session instead of spawning Pi with no session (which created a throwaway session file, then the tab restarted Pi with the real one). This is the churn behind the climbing session count / new sessions.

## 0.0.159

- FIX (root cause): inline edit did nothing in editor tabs because the forkAndSend handler existed only on the sidebar panel, not the ChatTabManager the tabs actually use. Editor tabs now handle forkAndSend on their own controller, so editing a message forks + resubmits and the truncation sticks.

## 0.0.158

- Fixed inline edit doing nothing: transcript re-renders are now suspended while a message is being edited in place, so background snapshot churn (reconcile handshakes/streaming) can no longer destroy the editor before Enter is pressed.

## 0.0.157

- Center the message action icons under the message. Added webview-side debug logging ([webview] pencil clicked / enter: posting forkAndSend) to diagnose the inline edit flow.

## 0.0.156

- Added a build badge (bottom-left of the chat: "pi build X webview live") and cache-busted webview assets, so it is unambiguous that BOTH the extension host and the webview bundle are the current build.

## 0.0.155

- Added an activation toast + log showing the loaded extension version, to make it unambiguous which build VS Code is running.

## 0.0.154

- Re-architected the transcript to use Pi RPC get_messages (authoritative ACTIVE branch) as the single source of truth. The live file watcher now resyncs over RPC instead of tail-appending the local file, which stored every fork branch and could only add (never remove) messages. This fixes old/dropped branch messages reappearing after an inline edit/fork or while typing.

## 0.0.153

- Added [edit] trace logging to the Pi output channel for the inline edit/fork flow to aid diagnosis.

## 0.0.152

- Fixed old messages reappearing after an inline edit/fork on any focus/reconcile: the local transcript read now follows only the ACTIVE branch (Pi stores all fork branches in one file, linked by id/parentId). Legacy sessions without ids fall back to linear order.

## 0.0.151

- Inline edit now surfaces errors instead of failing silently, and times out a stuck fork (30s) so a rate-limited/unresponsive model no longer makes the edit appear to do nothing. Icon row alignment uses align-self for exact edge alignment.

## 0.0.150

- Fixed dropped-branch messages reappearing after inline edit/fork on any reconcile (session focus/switch): the transcript is now corrected from Pi active branch over RPC in the background, so forked sessions no longer reload the old chat.

## 0.0.149

- Fork/inline-edit truncation now sticks: after forking, the session file tail pointer is moved to EOF and a self-write is marked so the live file watcher cannot re-append the dropped branch.

## 0.0.148

- Fixed inline edit not truncating: after forking, messages are now refreshed over RPC (active branch only) so the post-fork messages no longer reappear; the edited turn is resubmitted.
- Inline edit field now spans the full conversation width.
- Clearer edit/copy icon hover.

## 0.0.147

- Edit a user message INLINE (ChatGPT/Continue style): the bubble text becomes editable in place; press Enter to fork the session at that message (removing everything after it) and resubmit the edited text. Esc cancels. Larger edit/copy icons.

## 0.0.146

- Message actions (edit/copy) now sit UNDER the message text with clearer spacing and size, aligned to the message side, revealed on hover.

## 0.0.145

- Edit (pencil) on a user message now forks the session at that message: everything after it is dropped and its text returns to the composer to resend (edit-and-restart-from-here). Pi fork creates a branch, so the original transcript is preserved.

## 0.0.144

- Empty-response hint now names the failing model (e.g. openai-codex/gpt-5.6-sol) so you know which model to switch away from.

## 0.0.143

- Chat: show a clear hint when an assistant turn returns no content (e.g. the provider is rate-limited or errored) instead of a silent blank bubble, with a button to open Pi logs.

## 0.0.142

- Fixed empty assistant responses on Pi 0.84+: message_update events are now delta-only (no message field), so the reducer applies streamed text/thinking deltas to the current assistant message instead of dropping them.

## 0.0.139

- Chat: coalesce transcript re-renders while Pi is replying (thinking/tool streaming) to a calm rate, so the UI stays readable instead of flickering several times a second. Answer text still streams smoothly.

## 0.0.138

- Hardened the sent-text-reappears fix: the composer will never re-show text you just submitted while the draft is empty (covers the after-completion caret-restore race).

## 0.0.137

- Composer: up-arrow prompt history (like the TUI) - Up at the start walks back through your sent prompts, Down walks forward, past the newest restores your draft.

## 0.0.136

- Fixed heavy transcript flicker while Pi replies: streaming now patches only the growing answer instead of rebuilding the whole message list on every update.

## 0.0.135

- Fixed sent text reappearing in the composer: the draft is now cleared before the send re-renders, so an already-sent message never comes back.

## 0.0.134

- Root-cause fix (Windows): Pi crashed on start because its shell-inheritance extension could not determine the launch shell. The extension now sets PI_LAUNCH_SHELL in Pi’s spawn env (default cmd.exe on Windows; configurable via piRpc.launchShell, e.g. Git Bash), so Pi starts with all extensions.

## 0.0.133

- Pi now starts ONLINE by default (piRpc.offline defaults to false), matching the TUI, so extensions that need the network at startup work and sessions load first try. Set piRpc.offline=true to force offline.

## 0.0.132

- Root-cause fix for “couldn’t load this chat”: VS Code ran Pi with --offline (the TUI runs online), so an extension needing the network crashed Pi on load. Now recovers by retrying ONLINE with extensions KEPT (matching the TUI); extensions are only disabled as a last resort.

## 0.0.131

- Fixed “couldn’t load this chat” when Pi crashes on session load (exit code 1) due to a failing extension: the extension now auto-retries the SAME session with Pi extensions disabled (pi -ne) so the chat loads, instead of falling back to a blank session.

## 0.0.130

- Chat font consistency: the whole transcript and the composer input now follow the editor font (was: input used the UI font), so all chat text matches.

## 0.0.129

- Fixed “couldn’t load this chat” error on longer sessions: the initial load now waits (long timeout) for Pi to finish parsing the session instead of failing at 15s.

## 0.0.127

- UI redesign: Settings gear moved to the top of the sidebar; composer is minimal (borderless clickable Model label + read-only Cost + Send); per-chat actions moved to a chat-header “…” menu; removed the Continue button and de-duplicated controls.

## 0.0.126

- Composer: auto-grows to fit up to 10 lines (then scrolls, keeping the current line in view) instead of showing a fixed-height inner scrollbar.
- Fixed the conversation scrollbar flicker on typing at its true root: draft persistence is now fully silent (no controller/UI-state fire), so a keystroke never re-renders the chat DOM.

## 0.0.125

- Real-time TUI->GUI sync: a native fs.watch on the active session file (with a stat-poll fallback) pushes terminal edits into the open chat within ~150ms, replacing the laggy out-of-workspace VS Code watcher path.

## 0.0.124

- Auto-compaction: new piRpc.autoCompact.mode (auto|off) + piRpc.autoCompact.percent (default 65) auto-detect the current model max context and compact at that percent; piRpc.autoCompact.resumeTask continues the in-progress task after compacting. (Deprecates autoCompactThreshold.)

## 0.0.122

- UI: consolidated controls — the status bar is now a single passive Pi-status indicator; model and usage live only in the chat composer (removed duplicate status-bar items and duplicate More-menu entries).

## 0.0.121

- Chat: tool results collapse by default (errors stay open); inline code, JSON keys and tool names are now mint text with no background chip.

## 0.0.120

- Chat: fixed scrollbar flicker while typing — the panel no longer rebuilds the DOM on each keystroke, and the conversation reserves a stable scrollbar gutter.

## 0.0.119

- Chat: JSON tool args/results now render as structured tables (key/value grids; arrays of objects as columnar tables) instead of raw JSON, for clearer reading.

## 0.0.117

- Connect a phone is now opt-in via the new piRpc.remote.enabled setting (off by default); the button and remote commands are hidden until enabled.

## 0.0.115

- Chat rendering parity: syntax-highlighted code blocks (highlight.js, theme-aware), GFM tables, strikethrough, task-list checkboxes, nested lists, autolinked URLs, and safe image links.

## 0.0.114

- Chat: render Markdown tables as real HTML tables (aligned columns) instead of broken pipe text in the VS Code GUI.

## 0.0.107

- Remote: pairing panel opens in the same editor group (no split) and is replaced by the shared chat once a device pairs (single-window flow).

## 0.0.106

- Remote shared session: in-chat info bar ("Shared with <device>" + Stop sharing) on the bound chat, same-window binding, device names via presence, and a guard so you can't start a duplicate share.

## 0.0.105

- Remote: starting a remote session (or a device connecting) now ensures a live chat is open in VS Code, so the phone has a real session to mirror and drive.

## 0.0.104

- README: full feature-table refresh (Compose/Ask Pi/Navigate/Flow/Feel/Remote), corrected More menu, added Settings-worth-knowing section.

## 0.0.103

- README: documented the Remote (Connect a phone) flow, updated keyboard shortcuts (Enter sends), removed stale Advanced-mode references.

## 0.0.102

- Remote: VS Code now acknowledges when a phone connects (notification + the pairing panel shows Connected + device count) and re-pushes the current chat. Pairing panel is centered.

## 0.0.101

- Remote session UX: persistent pairing panel (QR + PIN + link) instead of a vanishing notification; the PIN stays visible. Sidebar "Connect a phone" button. Pushes the current chat on start so a paired phone isn't blank.
- Bottom controls (model/usage/continue/settings/more) now right-aligned.

## 0.1.0

- Fix remote session connection: set a User-Agent on the broker HTTP + WebSocket calls. Cloudflare rejects UA-less requests (403 error 1010), which blocked Start Remote Session.

## 0.0.99

- Remote sessions (host client, experimental): "Pi: Start/Stop Remote Session" dials out to the Pi (y)ours broker (wss), streams the active chat's snapshots to paired viewers, and applies a remote driver's prompts to the chat. Configure with piRpc.remote.brokerUrl + piRpc.remote.hostSecret. The broker (slr-backend app pi_yours + k8s manifests) is in review; local end-to-end (pair -> live snapshot -> drive) verified.

## 0.0.98

- Accessibility pass:
  - Screen-reader friendly streaming: the transcript no longer spams every token (aria-live off). A dedicated status region announces concise milestones - "Pi is working", "Pi responded. <answer summary>", and errors.
  - Every icon-only control now has an aria-label (model, usage, continue, send, etc.); each message announces its author ("You said" / "Pi said").
  - Visible focus ring on every interactive element (:focus-visible), never removed.
  - Reduced motion: prefers-reduced-motion now also disables typewriter smoothing (text appears immediately), in addition to spinners/animations.

## 0.0.97

- Inline "Ask Pi" CodeLens: an "Ask Pi" action now appears above functions/methods in code files. Click it to select that symbol and pick Explain / Add tests / Fix bugs / Refactor - routed straight into the chat with the code as context. Toggle with piRpc.codeLensEnabled.

## 0.0.96

- Rich diff for edits: edit tool cards now show a real colored diff (removed lines in red, added lines in green) instead of raw JSON args, so you can review exactly what Pi changed inline. Long diffs get a Show more toggle; Open file / Open changes still available.

## 0.0.95

- Auto-compact + resume: new setting piRpc.autoCompactThreshold (default 70). When context usage crosses the threshold after a turn, Pi compacts the conversation automatically and the chat resumes on the compacted context - no manual compaction, no hitting the limit mid-task. Set 0 to disable (Pi still auto-compacts when nearly full). After any compaction, the transcript and state are re-synced for a clean resume.

## 0.0.94

- Layout polish (UI/UX pass): added top breathing room so the first message no longer hugs the editor edge; the Continue button now sits inline in the single controls row (model, usage, continue, settings, more) instead of wasting its own line; consistent 8px spacing rhythm in the toolbar.

## 0.0.93

- Retry with model: the More menu now has "Retry with model…" - it opens the model picker and, if you choose a different model, re-sends your last message with it. (Picking the same model or cancelling does nothing; use "Retry last message" for a plain retry.)

## 0.0.92

- Queue visibility: messages you queue while Pi is working (steering / follow-up) now show in a "Queued for Pi" tray above the composer, so you can see what is pending.
- Continue: after a turn finishes, a subtle "Continue" button appears (when the composer is empty) to nudge Pi to keep going / finish a truncated answer. It hides as soon as you start typing.

## 0.0.91

- Image paste: paste a screenshot or image directly into the composer (Cmd/Ctrl+V) to attach it - no need to save a file first. Respects the image size and per-message count limits.

## 0.0.90

- Cleaner layout: the top bar is now empty; the model chip, usage chip, folder picker, and the More menu moved into a toolbar next to the composer (bottom), so the conversation gets the full top space.
- New Settings gear (next to the composer) with a popover: Chat font size -/+, Working animation..., Typewriter speed..., and All Pi settings... (opens the extension's settings).

## 0.0.89

- Fix @-mentions: typing "@" now immediately loads the workspace file list to choose from. The bare "@" (empty query) was being skipped by a stale equality check, so no dropdown appeared until you typed more; it now requests on the first "@". Also hardened the file search (uses the folder URI, wider result cap).

## 0.0.88

- Enter now sends the message (TUI-style); Shift+Enter inserts a newline. Cmd/Ctrl+Enter still sends too. Enter during IME composition no longer submits mid-word. Tooltips/help updated to match.

## 0.0.87

- Fix (harder): opening/resuming a chat now reliably lands at the bottom, even for long chats. Because the virtualized list estimates off-screen heights, scrollHeight keeps changing as messages render; we now pin to the bottom across a short window (re-asserting each frame) so late relayout can't strand the view near the top. Scrolling up cancels the pin immediately.
- Jump-to-latest button uses a clearer "arrow down to a line" icon (go to end) instead of a plain chevron.

## 0.0.86

- Submit button now uses a return/enter icon instead of an up arrow, so it clearly reads as "send" (matching Cmd/Ctrl+Enter). The tooltip/label are unchanged.

## 0.0.85

- Working indicator moved to a clear "Working…" banner at the top of the composer (above the input), instead of a small glyph in the bottom-right. It is now obvious when Pi is generating. The animation style (piRpc.workingAnimation) and Stop button are unchanged.

## 0.0.84

- Fix: opening/resuming a chat now lands at the bottom (latest message) instead of the top. The jump-to-bottom previously fired on the empty loading render before messages arrived; it now waits for the messages to render and re-asserts after layout so it works correctly with the virtualized list.

## 0.0.83

- In-chat find: press Cmd/Ctrl+F inside a chat for a scoped search bar. Matches are highlighted; Enter / Shift+Enter (or the arrows) step through them with a count, Esc closes. Uses the CSS Custom Highlight API so highlights survive live streaming re-renders.
- Inline tool approvals: when Pi (via an extension) asks to run something with a select/confirm dialog, it now renders as an Allow/Deny card in the chat instead of a native popup - answer in one click. Falls back to the native dialog when no chat is open.

## 0.0.82

- piRpc.typewriterSpeed setting: control how streamed answers type out - off (show Pi's raw chunks, no smoothing), slow, normal (default), or fast. Applies live to open chats.

## 0.0.81

- Typewriter streaming: Pi streams answers as coarse snapshots (~every 400ms), not token deltas. The GUI now reveals newly-arrived characters smoothly between updates, so the reply types out fluidly like the TUI instead of appearing in jumps. It stays pinned to the bottom while typing, catches up if it falls behind, and shows the full text the instant the turn finishes.

## 0.0.80

- Completion notification: when Pi finishes a long response (>4s) while you are not watching that chat (window unfocused or a different tab active), a notification appears with an "Open chat" button. Quick replies and the chat you are actively watching never notify. Toggle with piRpc.notifyOnComplete.
- Onboarding empty state: a new chat now shows clickable example prompts (Explain this codebase, Add tests, Find and fix a bug) plus quick hints for "/" commands, "@" file mentions, and Cmd/Ctrl+K. Clicking an example loads it into the composer.

## 0.0.79

- #10 Virtualized message list: off-screen messages now use CSS content-visibility so the browser skips their layout and paint while keeping them in the DOM (find-in-page, live-append, and copy/edit still work). Long chats open and scroll noticeably faster; memory/CPU stay flat as the transcript grows. The most recent message is exempt so streaming and scroll-to-bottom stay pixel-exact.

## 0.0.78

- #9 Mentions and drag-drop: type "@" in the composer to fuzzy-search workspace files; arrow keys to move, Enter/Tab to pick, Esc to dismiss. The picked file is attached as a context chip. You can also drag a file from the Explorer onto the composer to attach it.

## 0.0.77

- #3 File edits get actions: when Pi uses an edit/write tool, its timeline card now shows the file path plus "Open file" and "Open changes". Pi applies edits itself, so "Open changes" opens the working-tree diff (via the Git extension) and "Open file" jumps to the file - one click to review what changed.

## 0.0.76

- #7 Session management: pin your favourite chats. Hover a chat in the sidebar and click the star to pin/unpin; pinned chats float to the top and keep their star visible. Pins persist per workspace. (Search, rename, and delete were already available.)

## 0.0.75

- #2 Ask Pi from the editor: select code, right-click -> "Ask Pi" -> Explain / Fix / Refactor. The selection is attached as context, a chat opens (or the current one is reused), and the composer is prefilled with the instruction so you can tweak and send. Also available as commands "Pi: Explain/Fix/Refactor Selection".

## 0.0.74

- #6 Inline slash-command autocomplete: type "/" at the start of the composer to see a filterable menu of Pi commands (with descriptions). Arrow keys to move, Enter/Tab to insert, Esc to dismiss, or click a row. Complements the existing "/" button.

## 0.0.73

- #8 Command palette in chat: press Cmd+K (Ctrl+K on Windows/Linux) inside a Pi chat for quick actions - New Chat, Resume Chat, Retry Last, Copy Conversation, Choose Model, Thinking Level, Session Stats, font size, Show Logs. Also available as "Pi: Command Palette".

## 0.0.72

- #5 Usage in the header: a compact chip next to the model shows context %, total tokens, and cost (e.g. "6% · 12k tok · $0.023"). Click it for the full session-stats breakdown. Hidden until stats are available.

## 0.0.71

- Remove the confusing "Advanced" view. The "Pi: Toggle Advanced Mode" command, the piRpc.defaultViewMode setting, and the disconnect-screen "Show details" button are gone. Advanced mode had no visual effect in the current chat UI (it was a leftover from an earlier layout), so removing it simplifies the surface with no loss of functionality.

## 0.0.70

- Fix working animation: it froze on the first frame because every streaming re-render reset the timer. Now a single persistent interval drives it (re-targets the current glyph each tick), so it spins smoothly. Also shows the working state the instant you submit (before Pi's first token), so there's immediate feedback.
- Fix submit latency feel: pressing send now flips to the busy/working state immediately.
- Fix chat font size: the chat text, bubbles, tool cards, tool names, and code now use sizes relative to piRpc.chatFontSize, so increasing/decreasing the font actually scales the content (not just paragraphs).

## 0.0.69

- Working animation while Pi generates (like the TUI). Choose a style with piRpc.workingAnimation: braille (default), dots, bars, earth (spinning globe), moon (phases), or dolphin (leaping). Shown next to Stop while streaming; respects reduced-motion.
- Chat font controls: piRpc.chatFontSize (px) and piRpc.chatFontFamily override the chat text (bubbles, cards, and content). Quick commands: "Pi: Increase/Decrease Chat Font Size". Changes apply live to open chats.

## 0.0.68

- #4 Message actions - Retry & Edit:
  - Retry last message: More menu -> "Retry last message" (command "Pi: Retry Last Message") re-sends your most recent prompt.
  - Edit: hover a user message and click the pencil to load its text back into the composer for editing/resending. Per-message copy is grouped with it.

## 0.0.67

- #1 Markdown polish: agent responses now render full Markdown - headings, bullet/numbered lists, blockquotes, horizontal rules, italic, bold, inline code, and links (which open externally). All HTML-escaped (no injection); fenced code blocks keep their Copy/Insert/New file toolbar.

## 0.0.66

- Two-tone chat bubbles for clear user/agent distinction: the user message is a teal-tinted bubble (option D); the agent now also has a bubble (neutral surface, same rounded shape, different color) for a consistent UI - the plain agent text and the timeline answer both use it. Thinking/tool cards stay as light hairline cards. Colors are single variables (--pi-user-bubble / --pi-agent-bubble) for easy tuning.

## 0.0.65

- Jump-to-latest button: replaced the bottom-heavy full arrow (which looked off-center in the circle) with a centered chevron, and switched the button to flex centering with the SVG as a block. Now optically centered.

## 0.0.64

- Silent live-append (important): when a terminal appends to the SAME session you have open, the GUI now tail-reads only the NEW lines and appends them at the bottom - no reload, no "Loading chat..." flash, no connection blink. It stays idle-guarded, dedupes by message id, ignores the GUI's own writes, and is throttled. Feels like the chat just continues.
- Jump-to-latest button now uses a properly centered down-arrow SVG (was an off-center glyph).
- Copy per message: hovering a user or agent message shows a copy button that copies that message's output.
- Double-Escape stops the current generation (abort) while streaming.
- "Show more / less" on long tool/result output retained and verified.

## 0.0.63

- #2 (partial) - Copy conversation as Markdown: More menu -> "Copy as Markdown" (and command "Pi: Copy Conversation as Markdown") copies the whole transcript (user/agent/thinking/tool/result) as clean Markdown to the clipboard.
- #6 - Jump to latest: a floating button appears when you scroll up in a chat; click it to snap back to the newest message.
- #7 - Long tool/result output is clamped (~15em) with a "Show more"/"Show less" toggle, so big logs and package lists don't dominate the transcript.

## 0.0.62

- Feature #1 - Apply code to the editor. Every fenced code block now has Insert / New file / Copy actions:
  - Insert: replaces the selection (or inserts at the cursor) in the last active text editor; falls back to a new file if there's no editor.
  - New file: opens the code in a new untitled document with the correct language (fence -> VS Code languageId mapping).
  - Copy: unchanged.
- Tracks the last real text editor (ignoring the chat webview) so Insert targets your code, not the chat.

## 0.0.61

- Fix "Maximum call stack size exceeded" (protocol fault) when resuming a large session. The RPC envelope validator (isJsonValue) walked the response payload recursively; a big session returns a deeply-nested message/entry tree, which overflowed the call stack and killed the transport. isJsonValue is now iterative (explicit stack), so payloads of any depth validate without overflowing. Large sessions resume correctly.

## 0.0.60

- Open chat now live-updates from terminal edits (near real time), performance-guarded:
  - When a terminal appends to the SAME session you have open in the GUI, the extension re-reads it from disk so the new messages appear - but only when the chat is idle (never mid-generation), debounced (~1.2s), rate-limited to once every ~4s per session, and never for the GUI's own writes (self-write grace window).
  - The chat LIST refresh is throttled: quick on create/delete, but content-change (append) refreshes are debounced to ~once every 2.5s.
  - Re-indexing bounds per-file reads (max ~800 lines) so it never scans huge session files end-to-end. This directly avoids the "frequent re-read" IDE performance risk.
- Kept the per-workspace-folder RPC model (one shared Pi process per folder; chats switch via RPC, not new processes).

## 0.0.59

- Terminal (TUI) and GUI stay in sync automatically. The extension now watches the Pi sessions directory (~/.pi/agent/sessions) and refreshes the chat list live when you create, switch, rename, or continue a session in a terminal - no need to reload the extension or the VS Code window. (The reverse already works: the terminal re-reads sessions on /resume.) Debounced so a streaming session refreshes once.

## 0.0.58

- Chat now uses the FULL editor width for text (agent and user). Removed the ~76ch cap so wide editors are utilized properly; short user messages still hug their content, long ones span the full width.
- Markdown **bold** renders as bold instead of showing literal \*\* markers (cleaner thinking/response text; thinking stays italic).

## 0.0.57

- Fix: tool args and tool/result output text no longer appear gold. They were using --vscode-editor-foreground (the editor's text color, which is gold in some themes); they now use the chat foreground (--vscode-foreground). A real fenced code block in the answer still uses the editor's code color. (Confirms: #1 tool/result inner text de-golded; #2 thinking is italic; #3 chat text uses the editor font family.)

## 0.0.56

- Tool and Result now use a fixed TEAL accent (#4ec9b0) for their icon, label, and timeline marker - theme-independent, so it no longer appears gold on themes whose link color is gold. Controlled by a single --pi-tool-accent variable.

## 0.0.55

- Loading spinner when opening a session: resuming now shows a "Loading chat…" spinner while the transcript is fetched, instead of a blank pane, so it's clear the chat is still loading.
- Chat text now respects the editor's configured font family (message text, thinking, response, user message) - matching your editor font.
- (Thinking text remains italic.) Tool/Result accent color options are provided as a browser mockup to choose from (docs/design/chat-accent-options.html).

## 0.0.54

- Fenced code block spacing fixed: my tool-args padding rule was also flattening the answer's fenced code, so it looked cramped. Real fenced code now keeps its padded, spaced block (padding + 12px margin around it).
- No generic language label: the code block header no longer shows "text"/"code"/"plaintext" etc. - it only labels a real language; otherwise it just shows the code with the Copy button.

## 0.0.53

- Tool args and tool/result output are now guaranteed transparent (no code-block background). Removed the leftover fill from the global pre rule so no bare code gets a background; only the answer's fenced code keeps the surface you chose. Tool/result text sits directly on the transparent card.

## 0.0.52

- Fix: standalone tool results now follow the same card pattern. Pi emits tool results (and bash executions) as SEPARATE messages with role "toolResult"/"bashExecution" - not as content blocks inside the assistant message - so they were rendering as a plain block with the raw "toolResult" label. They now render as a proper Result card (icon + "Result" label, rounded border, collapsible, monospace body) matching Thinking/Tool/Answer. The raw role label is no longer shown as a heading.

## 0.0.51

- Chat layout finalized per design review (timeline of rounded cards):
  - Fenced code renders as its OWN block - language label + a Copy button, on a subtle surface - clearly separated from the response prose. Tool args/results stay plain (no fill).
  - Every section is a rounded, hairline-bordered card identified by an icon in its header (Thinking, Tool, Result, and a "Pi" Response header) with a small colored dot on the timeline rail.
  - Thinking and Tool result are expanded by default; cozy spacing/padding.
  - Semantic theme colors (dim thinking, accent tools, error red, green answer); inline SVG icons; everything wraps.
- Copy button on code blocks copies the code to the clipboard.

## 0.0.50

- New chat layout: the agent turn is now a TIMELINE of rounded, hairline-bordered cards (the fused timeline + cards direction). Each step - Thinking, Tool, Result, and the final Answer - is a node with a colored dot on a connecting rail: thinking is a dim italic collapsible node, tools/results use the theme accent (errors use the error color, collapsible), and the answer is a green node with full-contrast text. No background fills. Simple text-only replies skip the timeline and render as plain text. The "You" message stays a right-aligned outlined bubble.

## 0.0.49

- Modernised, premium chat layout (UI/UX pass). Sections are now instantly distinguishable by a colored LEFT RAIL + a crisp line icon + an uppercase label - not muddy filled badges:
  - Agent response: primary text at full contrast on the plain background, comfortable 1.6 line-height, ~76ch measure.
  - Thinking: a quiet dim rail, small "Thinking" icon+label, italic secondary text, collapsed by default for brevity.
  - Tool / Tool result: the theme accent (textLink) rail+icon; errors use the semantic error color. Tool result collapsible.
  - You: right-aligned, hairline-OUTLINED bubble (no fill).
- Removed the muddy brown/yellow badge palette and low-contrast gray text; now uses semantic theme tokens (foreground, descriptionForeground, textLink, errorForeground) with dark-mode-appropriate contrast. Icons are inline SVG (no emoji, no icon font). Code/args wrap and share one calm surface. No background fill added to the chat.

## 0.0.48

- Fix (Windows): resuming a session opened a tab bound to the WRONG identity - it showed an empty transcript titled with the long .jsonl filename. Cause: the session-file path the sidebar clicked (e.g. C:\...) differs from the path the running Pi reports back after resume (drive-letter casing / forward-vs-back slashes), so the "is this tab the controller's current session?" check compared unequal strings and never bound the tab as current (falling back to the empty cached snapshot). macOS matched, so it worked there.
- Session identity now compares NORMALIZED paths (resolve, and case-insensitive on Windows) in one chokepoint (chatTargetSessionKey) plus the tab-dedup lookups, so the resumed session binds correctly, the transcript loads, and the tab shows the real chat name. Also fixes legacy sessions that failed to bind for the same reason.
- Tests: key ignores slash/.. drift and (Windows) casing, distinct files stay distinct.

## 0.0.47

- Diagnose "resumed but no old messages": every reconcile now logs exactly what Pi returned - messages/entries/tree counts AND the payload shape (e.g. getMessages object{messages:array[42]}) plus the session file. So an empty transcript on resume is now explainable: either Pi returned 0 messages (the switch didn't load the transcript) or the data was under a different key (rendering/shape issue).
- More tolerant transcript extraction: the message list is read from the documented `messages` array but falls back to a bare array or alternate keys (items/entries/transcript), so a Pi response-shape difference no longer renders an empty chat.

## 0.0.46

- Much better diagnosability for "can't type / stuck not-ready" issues. The extension now logs every connection lifecycle transition per workspace (init -> starting -> handshaking -> ready/busy/faulted, with the session file), the detected Pi version, and any reconcile failure (timeout/protocol fault) - all in More > Show Logs. So when something doesn't work you can see exactly what happened and why.

## 0.0.45

- Windows: the startup version probe is no longer a hard gate. Previously, if `pi --version` exited non-zero or printed to stderr (which can happen with the .cmd shim on Windows), the probe threw and the whole session faulted - leaving a chat you could open but not type in, change model, or submit. Now only a genuinely missing binary or a parseably-too-old version blocks startup; anything else logs a warning and proceeds to start the RPC.
- Added handshake logging ("Handshaking with Pi", "Pi is ready ... state=") so a stuck startup is visible in More > Show Logs, and pass windowsHide so no console window flashes.

## 0.0.44

- Fix: the Pi version check required an EXACT version (0.80.10), so any newer Pi failed to start. It now enforces a MINIMUM version (>= 0.80.10) and accepts any newer release. Versions older than the minimum are rejected with a clear message; unparseable/dev version strings proceed with a logged note instead of blocking.
- Tests: numeric (not lexical) semver comparison, exact-min and newer accepted (incl. a higher major), older rejected, unparseable allowed.

## 0.0.43

- Thinking and tool cards now have no fill - just a hairline border on the plain conversation background - so they match the agent text and feel fully native. Type-colored badges and the thinking accent rail keep them distinguishable; content still wraps.

## 0.0.42

- Agent replies now sit directly on the conversation background instead of inside their own grey bubble, so the text is on top of the background color (no separate fill behind it) - cleaner and more native. The "You" message keeps its accent bubble so user vs agent stays clear.
- Removed the stray border the global pre style added to code blocks, so fenced code is one clean surface. Everything continues to wrap (code, tool args/results, thinking) for readable layout.

## 0.0.41

- Cleaner, more native chat formatting. Thinking and tool blocks are now single, uniform cards (subtle solid surface, soft border, rounded) instead of a transparent dashed card with a clashing dark code box nested inside - the code/args now blend into the card. Fenced code in messages uses one harmonized surface with a language header.
- Everything wraps: code blocks, tool arguments, tool results, thinking text, tool names, and inline code now wrap (overflow-wrap/word-break) so long lines and JSON lay out nicely and stay readable instead of overflowing or scrolling horizontally.

## 0.0.40

- Fix: resuming a session right after the window opened failed with "Pi is not started for this workspace". It was a readiness race, not a path problem: warm-start sets the connection to "starting" ~1s before the RPC client exists (pi --version + spawn), and the resume fired in that window. Resuming now waits for Pi to be usable (new controller.whenReady) before switching, and starts directly on the session when Pi is fully stopped. The path in the log ([HOME]/.pi/agent/sessions/--...--/...jsonl) was correct; [HOME] is just the log redactor masking the home directory.

## 0.0.39

- Resume failures are no longer silent. Resuming a session now logs the exact path and any error (Pi output channel), records a diagnostic, and shows an error notification with a "Show Logs" action. Previously a failed switch (common on Windows for path/cwd reasons) was swallowed, so the chat just stayed blank with no explanation.
- Verified the session-directory encoding and agent dir match Pi's own implementation exactly (including the Windows drive/backslash handling), so the extension looks in the same place Pi writes.

## 0.0.38

- Fix "Assertion Failed: Argument is undefined or null" when opening a chat editor. resolveCustomEditor and the session start/switch it triggers could reject (e.g. Pi missing, version mismatch, load error); a rejected resolveCustomEditor makes VS Code fail the editor input resolution and throw that internal assertion. Editor resolution and session loading are now wrapped so they never reject - the tab stays open and shows its connecting/faulted state instead.
- Hardened the chat editor URI: it now uses a space-free path (chat-<id>.chat / new-chat-<id>.chat) to avoid path-encoding edge cases, and secondary URI parses are guarded.
- Tests updated for the space-free path.

## 0.0.37

- Fix (Windows): loading a saved chat session could fail with "ENOENT: no such file or directory, realpath 'C:\\--c--Users-...--'". canonicalizeSessionPath used realpath purely to normalize symlinks but let it throw; on Windows realpath can fail even for a valid resolved path, aborting the load. It now falls back to the resolved absolute path when realpath fails, so the session loads. (Our session-dir encoding already matches Pi's exactly.)
- Tests: canonicalizeSessionPath returns an absolute path for an existing file, does not throw when realpath fails, and resolves relative paths against the cwd.

## 0.0.36

- Clearer transcript layout: user and agent text stay in solid, per-role chat bubbles, while thinking, tool calls, tool results, and images now render as SEPARATE, lighter, dashed "meta" cards outside the bubble. This keeps the actual conversation prominent while agent internals feel granular and distinct (dim text, type-colored badges, collapsible thinking/results).
- Tests: thinking/tool render as separate meta cards and text stays in the bubble.

## 0.0.35

- Fix: opening a saved (old) chat session showed a blank transcript and a dead composer. Loading a session now always binds it to the controller - if Pi is stopped it starts directly on that session file; otherwise (including while it is still handshaking, when the RPC client already exists) it asks the running process to switch to it. Previously the switch only ran when the connection was already ready/busy, so with warm-start timing the session was never loaded and the tab stayed blank with submit doing nothing.

## 0.0.34

- Clean breadcrumb, restore-safe: chat tabs now use a short, deterministic URI path (e.g. "Chat 3f9a2c8b1d.chat" / "New Chat <id>.chat") instead of the long encoded workspace/session path. The full identity is kept in a persisted path->identity map (workspace state) that is rehydrated on activation, so restoring/reopening a tab recovers the session correctly - without relying on a URI query (which VS Code drops on restore).
- Graceful fallback: if a restored tab's mapping is ever missing, it opens as a fresh New Chat for the workspace instead of erroring with a blocked webview.
- Tests: short-id determinism, clean path format, remember/lookup round-trip, rehydrate-from-persisted-state (restore), and distinct paths per session.

## 0.0.33

- Fix "Blocked vscode-webview request" when opening old chat sessions. The chat editor URI briefly stored its identity in the query string (0.0.31/0.0.32); VS Code does not reliably preserve a custom-editor URI's query when it restores/reopens a tab, so the identity was lost, the editor could not resolve, and the webview was blocked. Identity now lives entirely in the URI path (restore-safe). A query fallback is kept so any tabs opened by 0.0.31/0.0.32 still resolve.
- Trade-off: the breadcrumb shows the encoded path again (reliable) instead of the short label. A follow-up (short-id map persisted in workspace state) can restore a clean breadcrumb without the query fragility.
- Test: session identity survives a query-less restore (path is the source of truth).

## 0.0.32

- Rich chat rendering: LLM responses are now laid out by type so it is clear what is happening. Thinking is a dim, italic, collapsible block; tool calls show a "Tool" badge with the tool name and formatted arguments; tool results are collapsible (errors highlighted); images are labelled. Message text renders Markdown fenced code blocks (with a language label) and inline `code` in a monospace, scrollable code panel. All content is HTML-escaped (no injection).
- Instant New Chat: Pi RPC now warm-starts for every workspace folder on activation, so clicking "New Chat" opens an interactive composer immediately instead of feeling stuck while it connects.
- Refactor: chat tabs are now keyed by session identity (workspace + session) instead of the raw URI string, so tab lookup/dedup is robust to cosmetic URI/label changes.
- Tests: rich-text formatting (fenced/inline code, HTML-escaping), thinking/tool/result block rendering, and content-block mapping in the snapshot model.

## 0.0.31

- Breadcrumb no longer shows the long encoded workspace/session path. The chat editor URI now carries its identity in the query and uses a short, friendly path label ("New Chat" for drafts, "Chat <id>" for sessions), so the breadcrumb stays clean. The full chat name still shows on the tab. Legacy URIs are still parsed for backward compatibility.
- History fix: recent-session listing no longer silently drops chats when a custom session directory is configured and the recorded cwd differs only by trailing slash or symlink normalization (e.g. macOS /var vs /private/var). Comparison is now normalized (resolve + realpath + trailing-slash tolerant); sessions with no recorded cwd are kept.
- Tests: breadcrumb label determinism, query identity round-trip for every kind, distinct identity on label collision, and normalized-cwd matching (trailing slash, non-normalized, empty, different dir).

## 0.0.30

- Efficient large-chat rendering: opening a chat now loads only the most recent messages (default 50, `piRpc.messageWindowSize`) instead of the whole transcript. Older messages load automatically as you scroll up (an IntersectionObserver sentinel, not a scroll spammer), and the viewport stays anchored so it never jumps.
- Opening or switching to a chat now jumps straight to the last message; live streaming sticks to the bottom only when you are already near it.
- History chats that were never renamed now show the first prompt's opening words as the tab title (from the full transcript) instead of the `.jsonl` filename.
- Removed the redundant left-hand "Pi" label from the chat header.
- Tests: message windowing (last N, grow-on-load-older, short-chat boundary, stable ids), first-prompt title (truncation, content blocks, empty), loadOlder message parsing, header no-brand, and older-sentinel visibility.

## 0.0.29

- Fix: resuming a session could crash with "Pending stdout buffer exceeded limit" (and a follow-on VS Code "Argument is undefined or null" when opening the editor). On resume, Pi replays the whole transcript as one large stdout burst; the decoder was checking the transient combined buffer instead of the unparsed residual, so a burst of many small, complete records tripped the limit. The decoder now bounds only the incomplete trailing record, so full session replays stream through.
- Raised the default max JSONL record size to 16 MiB and decoupled the stdout buffer headroom so large messages/tool outputs in a resumed session no longer break the stream.
- Added tests: large resume burst in one chunk, big single record across many chunks, and an unterminated-residual overflow guard.

## 0.0.28

- Fix chat bubble rendering: removed three stacked, conflicting bubble style blocks that were fighting in the CSS cascade and made the "You" message look heavy/sluggish. Now a single coherent design:
  - The card is a transparent shell; the visible bubble is only the message text (no grey box around the "You" label).
  - "You" is an accent bubble hugging the trailing edge (fit-content width); Pi is a neutral surface bubble on the leading edge — same rounded shape language.
  - Spacing is driven by one flex `gap` (no doubled margins), with consistent padding and wrapping.

## 0.0.27

- Much clearer error logging for easy debugging:
  - Spawn failures now say exactly what went wrong with remediation (e.g., "Pi CLI was not found. Install it with npm i -g @earendil-works/pi-coding-agent, or set the Pi: Executable Path setting"). ENOENT/EACCES are called out.
  - The full launch command (executable, args, cwd, shell) is logged on start.
  - Version-mismatch and version-probe failures include the exact reason and exit code.
  - Session start failures are logged with the precise cause, recorded as a diagnostic, and move the chat to a recoverable "faulted" state.
  - Errors carry the Node error code/errno (formatError) so causes are obvious.
  - New "Show Logs" command + a "Show logs" item in the More menu and on the error state; command failures now offer a "Show Logs" button.

## 0.0.26

- Fix (Windows): the Pi process now spawns through a shell on win32, where the npm-installed `pi` is a `.cmd` shim that Node cannot execute directly. POSIX still spawns without a shell.
- Sessions started in the terminal (`pi`) for a workspace are listed in the sidebar and can be restored — they share Pi's per-workspace session directory. Added a regression test covering terminal-created sessions (including ones with only a name and no messages).

## 0.0.25

- Set an accurate VS Code compatibility floor: engines.vscode ^1.75.0. The real gate is the tab-groups API (VS Code 1.67); this is one step above it. Aligned @types/vscode to 1.75 and the bundle target to node18 so the floor is verified (nothing newer is used). Pi RPC itself is a CLI subprocess and is independent of the VS Code version.

## 0.0.24

- Streamlined the extension id to mr-narender.pi (was mr-narender.pi-rpc-vscode). Install with: code --install-extension mr-narender.pi

## 0.0.23

- Fixed the + button: the first click now opens the file dialog. A leftover focus handler was re-rendering the composer and replacing the button mid-click, so the first click was lost (which caused the double-dialog/slow behavior).
- Attachment chips are now compact, modern pills (filename + remove ×) that wrap inline; expanding a chip shows its details in a small popover instead of a full-width block.

## 0.0.22

- Attaching a file with + is now fast and non-blocking: it checks workspace containment and file size first, then reads bytes directly (up to 512 KB) instead of opening a full TextDocument (which made VS Code tokenize/language-process the whole file). Large files show a clear warning instead of freezing the UI.

## 0.0.21

- Usage & cost is now a readable popover (messages, tokens, context, cost) with a "Copy JSON" option — no JSON editor. All other info commands also show notifications with copy-to-clipboard instead of opening JSON files.
- Fixed the slash / picker flicker: the webview no longer steals focus back while a native picker/dialog is open (also hardens thinking/model/rename pickers).
- Simplified the + button in the composer: it now directly opens a file picker (any file) instead of a menu.

## 0.0.20

- Fixed the thinking-level flicker: menu commands (thinking, model, rename) no longer re-render the webview before opening the picker, which was stealing focus and instantly closing it.
- Sidebar rename now works reliably: it prompts first, then renames the live session via Pi or writes the name directly into the saved session file for non-open chats — no tab hijack.
- Help is now a readable popover with an "Open full README" button instead of dumping the README into an editor.

## 0.0.19

- Rename now works from both the sidebar and the More menu: it reveals the target session, applies the name, refreshes the title + sidebar, and confirms.
- Webview command errors are now surfaced as notifications instead of failing silently (this is why rename/thinking could look like they did nothing).
- Connection health is now a readable popover (with a "Copy diagnostics" button) instead of a raw JSON editor.
- Removed the confusing Advanced mode drawer and its menu toggle; low-level commands remain in the Command Palette.
- Thinking level applies and confirms with a toast; the current level is checked in the picker.

## 0.0.18

- Model selection is now two-step for granularity: pick a provider (with model counts) and then a model within it. An "All providers" option keeps the flat list, and single-provider setups skip straight to models. Current provider/model are checked.

## 0.0.17

- Model picker now shows a clean list — reasoning support, context window, max output, and image support per model (no raw JSON) — with the current model checked.
- Rename chat and Thinking level from the More menu now apply and refresh immediately (title/state update; thinking shows a confirmation), and the current thinking level is checked.
- Recolored the More menu System group dot from red to neutral gray so Restart/Health/Help no longer look like errors.

## 0.0.16

- Simplified branding to "Pi" everywhere it showed "Pi RPC": Command Palette category, Settings section, status bar, output channel, workspace pickers, and default tab title. The extension display name stays "Pi - this one is (y)ours"; setting ids are unchanged.

## 0.0.15

- Renamed the extension to "Pi - this one is (y)ours".
- Added a clear disclaimer: no affiliation with pi.dev; built for personal use and shared for anyone who wants it.

## 0.0.14

- Gallery logo is now a true full-bleed image (no white edges); rendered directly so it covers the whole icon.
- More menu: open state is preserved across re-renders and items close the menu on click, so it no longer flickers or fails to open.
- Header cleanup: removed the New and History buttons (they already live in the sidebar) — the chat header now shows just a model chip and the More menu, consistent with the theme.

## 0.0.13

- Full-bleed extension logo (fills the whole icon) shared by the Activity Bar and the gallery.
- The More menu is now an anchored dropdown (no longer pushes the header off-screen) with color-tagged groups: Session (blue), Model (orange), Context (purple), System (green/red).
- Rewrote the README into a proper extension page: what it is, prerequisites, how it works, feature parity with the Pi TUI, keyboard, troubleshooting, and privacy.

## 0.0.12

- Clicking a chat now reveals its existing editor tab instead of opening a duplicate.
- Centered the empty-state ("What to do first?") in the editor.
- New original Pi x VS Code fusion icon: an angular pi mark for the activity bar and a full-color orange/smoke gallery logo (not derived from the official Pi logo).

## 0.0.11

- New sidebar: a big edge-to-edge "New Chat" button, a search box, and the session list, built as a native webview (Claude-style).
- Rename a chat: hover a session and click the pencil icon (or it prompts inline); the display name updates everywhere.
- Delete a chat: hover and click the ✕ icon (with confirmation).
- Chat bubbles are now consistent: user messages are accent bubbles on the right, Pi replies are neutral bubbles on the left, same shape/typography.

## 0.0.10

- New Chat starts a fresh session immediately with no confirmation prompt.
- The composer now clears the moment you submit (optimistic clear), so the sent text no longer lingers.
- Slash commands: the / button lists Pi commands and inserts the chosen command into the composer (add args, then send) instead of flickering.
- Sessions display as "Session N" (renameable) instead of a UUID; the real id is kept internally.
- Nicer chat bubbles: user messages are compact rounded bubbles on the right; Pi replies render as clean full-width text.

## 0.0.9

- Submitting now clears the composer (authoritative reset), while typing still preserves the caret.
- Chat bubbles hug their content and wrap/grow as the model streams (no more full-width boxes); user right-aligned, Pi left-aligned.
- Pi RPC warm-starts as soon as the extension activates, so the first chat is ready immediately.
- Delete a saved chat from the sidebar via an inline trash icon (with confirmation); closes its tab and removes the session file.

## 0.0.8

- Submit a message with Cmd+Enter (macOS) or Ctrl+Enter.
- Fix: a single submission now shows one clean exchange. Pi RPC messages have no id, so the transcript was appending a duplicate bubble on every streaming event/delta; messages are now keyed stably and the finished turn is resynced from the authoritative message list.

## 0.0.7

- Pi now starts automatically in the background when a chat tab opens.
- While connecting, the chat shows a "Connecting to Pi…" spinner and the composer (input, attach, commands, send) is disabled so you can't interact until Pi is ready.
- If Pi fails to start, the tab shows a clear error with a Try again action instead of throwing "Pi RPC is not started".

## 0.0.6

- Fix: typing in the composer no longer resets the caret to the start. The webview now preserves the live composer value, caret, and focus across re-renders, and draft keystrokes no longer trigger a tab re-render.
- Sidebar: when there are no chats, show only the New Chat button (removed the "No chats yet" row).

## 0.0.5

- Fix: New Chat no longer hangs on a permanent loading spinner (webview snapshot is no longer awaited inside resolveCustomEditor; added a pi-chat FileSystemProvider and an extension-host open-tab regression test).
- Sidebar simplified to a single Chats launcher: New Chat at top, then existing chats that resume on click.
- Center editor restyled to a native Claude-style layout: centered brand, mascot empty state, and a bottom-docked rounded composer with + (attach), / (commands), and send.

## 0.0.4

- Completed LOCAL-004 editor-tab migration with a `CustomReadonlyEditorProvider` backed by stable `pi-chat:` URIs and native editor-tab session dedup/reveal behavior.
- Moved Pi chat into center editor tabs with per-tab transcript/composer state, draft promotion, history reopening, current-vs-cached markers, and editor-title launch actions.
- Added migration coverage for custom-editor manifest/URI contracts, tab rendering/history controls, cached revive snapshots, and packaged editor-tab extension-host validation.

## 0.0.3

- Shipped the LOCAL-003 simple-first redesign with exactly three sidebar views: New Chat, Resume Chat, and Current Chat.
- Rebuilt the chat surface around a minimal header, transcript-first layout, attach/send/stop composer, and a single persistent Advanced mode.
- Added deterministic context-chip serialization, preview/accepted-send recovery, per-session draft persistence, and new UX/a11y coverage tests.

## 0.0.2

- Redesigned Start & Sessions sidebar with clear Start, New, Resume, Current, Recent, and Help sections.
- Added safe recent-session indexing, search, sorting, metadata, malformed-session handling, and accessible empty/error states.
- Improved chat session header, first-run guidance, branch terminology, keyboard navigation, and narrow layouts.

## 0.0.1

- Initial LOCAL-001 implementation
