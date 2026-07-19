# Changelog

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
