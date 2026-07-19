# Changelog

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
