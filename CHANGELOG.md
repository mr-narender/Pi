# Changelog

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
