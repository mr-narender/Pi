<h1 align="center">Pi — this one is (y)ours</h1>

<p align="center"><em>An unofficial, personal VS Code chat UI for the Pi coding agent.</em></p>

> **Disclaimer.** I have **no affiliation with [pi.dev](https://pi.dev)**. I genuinely
> appreciate their work — this extension simply builds a GUI on top of Pi’s public RPC
> protocol. I made it for myself and I’m sharing it for anyone who wants to use it.
> It is provided as-is, with no warranty, and “Pi” belongs to its respective owners.

<p align="center">
  The <strong>Pi coding agent</strong>, natively in VS Code — the same power as the
  <code>pi</code> terminal, in a clean chat UI with editor-tab conversations and a session launcher.
</p>

---

## What it is

Pi RPC embeds the [Pi coding agent](https://pi.dev) inside VS Code. It hosts real Pi
sessions on a shared runtime in the background and gives you a native GUI on top:

- **Parallel chats** — every chat tab is its own independent Pi session on a shared
  runtime worker pool (with per-chat process fallback if the shared host cannot start). Fire off a long task in one chat and keep working
  in another; closing a tab tears down just that session.
- A **sidebar launcher** with an instant **New Chat** (a draft session is prewarmed for
  you), your saved chats, an **Other projects** group with every chat from every
  project, live status badges, and **full-text search across chat content**.
- **Mission Control** — the status bar shows how many chats are open / generating /
  waiting for your approval; background chats that need permission raise a notification.
- **Turn review** — when a turn changes files, review a consolidated list: open
  before↔after diffs, revert one file, or revert everything the turn touched.
- **Manual Mode** — off by default. Enable the composer shield to approve each
  Pi tool action (reads, commands, edits and extension tools) individually. Follow
  Agent controls file following separately. The project hook stays loaded and reads
  the current mode before each tool call, without restarting warm workers. Already
  running actions are not interrupted; an outstanding approval still needs Allow
  or Deny. Model text and internal processing do not request approval. Reload Window
  once after upgrading so existing sessions load the updated hook.
  Manual Mode needs trusted, writable project settings and enabled Pi extensions;
  if setup fails, its tools stay blocked and history remains readable. With Manual
  Mode off, a read-only project remains usable in automatic mode. Selected nested
  and other project folders get their own managed hook before the session starts.
- **Edits fork, visibly** — editing a message re-runs the chat on a fork in the same
  tab; `Pi: Show Chat Versions` opens any earlier version.
- **Quick switcher** (`Cmd/Ctrl+Alt+P`), aggregate usage/cost across open chats,
  export/copy conversations, and many Pi TUI workflows: models, thinking levels,
  slash commands, attachments/context, compaction, retry, usage, diagnostics.
- **Watch & drive from your phone** — a **Connect a phone** button mirrors the live chat
  to a phone browser (opt-in via `piRpc.remote.enabled`).

It talks to Pi over Pi’s documented RPC protocol, so your existing Pi setup, models,
sessions, skills, prompts, and extensions all work unchanged.

## Prerequisites

**Have `pi` installed already? It's used as-is** — the extension detects `pi` on your
PATH and runs on it directly (no duplicate copy, no surprise npm installs; you manage
updates). **No `pi` yet?** Either install it yourself (`npm install -g
@earendil-works/pi-coding-agent`) or set **`piRpc.autoInstall`: `true`** and the
extension installs the newest Pi version supported by its native host into its own
storage. Auto-install is **off by default** — nothing is ever
downloaded without your consent.

The native host supports the audited Pi SDK versions **0.99.1, 0.99.2, 1.0.0,
1.0.4, 1.1.0, 1.2.0 and 1.3.0**. Other versions and custom wrappers use stock RPC; features
requiring the native SDK report their unsupported capability.

Resolution is deterministic: an explicit `piRpc.executable` wins, otherwise the
current `pi` on `PATH` wins, and only then can a compatible managed installation
be used. With `piRpc.autoInstall: false`, the extension performs no npm check,
download, replacement, or staged-update application.

You also need:

1. **Authenticate Pi** once (either is fine):
   - Subscription / OAuth: run `pi` in a terminal and use `/login`, **or**
   - API key: export your provider key, e.g. `export ANTHROPIC_API_KEY=…`
2. **Open a folder** in VS Code.

> Prefer your own install? Set `piRpc.piSource` to `external` and (optionally)
> **Settings → Pi RPC → Pi Executable Path**.

## How it works

```
VS Code
├─ Sidebar (Pi)            New Chat · search (titles + content) · saved chats · Other projects
└─ Editor tabs "Pi Chat"   one INDEPENDENT Pi session per tab — chats run in parallel
        │
        ▼
shared Pi runtime pool     configurable workers host sessions (per-session extensions/MCP);
                           a draft session is prewarmed so New Chat opens instantly
```

- The first chat boots the shared runtime; every further chat attaches in the background
  while the tab paints immediately (animated loader, then the composer goes live).
- Sessions are named **Session N** by default and can be renamed; the real session id
  stays internal. Closing a tab tears down only that chat's session — never the file.
- Each message **edit forks** the session and stays in the same tab; stale fork
  ancestors are collapsed in the sidebar and reachable via `Pi: Show Chat Versions`.

## Getting started

1. Install this extension and open a project folder (your PATH `pi` is auto-detected;
   otherwise install Pi or enable `piRpc.autoInstall`).
2. Log in once if you haven't (see **Prerequisites**).
3. Click the **Pi** icon in the Activity Bar → **New Chat**.
4. Type your message and press **Enter** to send (**Shift+Enter** for a newline).

## Features (Pi workflows in a GUI)

| Area               | What you get                                                                                                                     |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| **Chats**          | Editor-tab conversations, live streaming, one tab per session, reopen/resume, branch & duplicate                                 |
| **Sessions**       | Sidebar launcher, search, **pin**, rename, delete, warm-start                                                                    |
| **Models**         | Choose/cycle model, thinking level, retry last message (optionally with a different model)                                       |
| **Compose**        | `/` slash commands, `@file` mentions, local/remote file drag-drop, **pasted** images, file/selection/diagnostics                 |
| **Ask Pi**         | Right-click a selection or use the inline **CodeLens** above functions to Explain / Fix / Refactor                               |
| **Navigate**       | Command palette (`Cmd/Ctrl+K`), find-in-chat (`Cmd/Ctrl+F`), jump-to-latest, conversation map                                    |
| **Flow**           | Queue/steer follow-ups, Continue, abort/stop, auto-retry, auto-compaction, usage & cost chip                                     |
| **Activity**       | **View activity** expands beneath its reply with grouped reads, folded reasoning and runtime details; raw calls stay inspectable |
| **IDE**            | Read-only diagnostics, symbols, definitions and references; result files open only when you click                                |
| **Changes**        | Undo recorded Pi edits after checking for newer edits; conflicts leave your changes intact                                       |
| **Connections**    | One on-demand MCP check in **Chat settings**, showing Pi's last reported snapshot, not live health                               |
| **Outbox**         | Edit/remove pending follow-ups before sending; restored messages stay paused; Pi-accepted entries are read-only                  |
| **Model tools**    | Edit this chat's model tool declarations in **Chat settings**; not a permission boundary, deferred tools may remain callable     |
| **Extensions**     | Pi 1.3 compatibility, inline select/confirm/input/editor prompts with Cancel, and draft suggestions with Use/Keep                |
| **Feel**           | Enter-to-send, typewriter streaming, working animation, chat-font controls, completion tab markers, a11y                         |
| **Remote (phone)** | **Connect a phone** to watch the live chat in a browser and take control to drive it                                             |

The Outbox holds follow-ups in the extension until sending. If delivery cannot be
confirmed, it pauses pending messages and never automatically resends the uncertain
message. Terminal-only extension interfaces show an unsupported notice in chat.

### While Pi is working

In native editor chat tabs, your sent message stays visible with a
**Working…** indicator while Pi prepares a reply. The current empty assistant
container and its **π** role label are deferred until the first meaningful reply
content arrives; the reply then streams normally, without waiting for completion.
Thinking, tool activity, errors and completed history (including empty-reply
Retry/Logs feedback) remain available.

## Watch & drive from your phone

You can mirror a live chat to your phone — handy for kicking off a long task and keeping an
eye on it (or nudging it) from the couch.

**One-time setup** (Settings → Pi RPC → Remote):

- **Broker URL** — the address of your Pi relay (e.g. `https://pi.fromlab.work`).
- **Host Secret** — the shared secret your relay expects.

**Each session:**

1. Open a chat, then click **📱 Connect a phone** in the Pi sidebar (or run
   **Pi: Start Remote Session** from the Command Palette).
2. A **pairing panel** opens with a **QR code** and a **6-digit PIN**. It stays open until you stop.
3. On your phone, **scan the QR** (or open the link) and **enter the PIN**.
4. The phone shows the conversation **live**. Tap **Take control** to send prompts; VS Code
   pops a confirmation when a device connects.
5. Click **Stop session** in the panel (or **Pi: Stop Remote Session**) when you’re done.

> **Security.** The relay never sees your code or Pi — it only forwards messages. Pairing is
> QR + PIN, a per-session token is minted server-side and held only on the phone (never in a
> URL), sessions expire, and only one device can drive at a time.

## Keyboard

| Shortcut                   | Action                             |
| -------------------------- | ---------------------------------- |
| `Enter`                    | Send the current message           |
| `Shift+Enter`              | Insert a newline                   |
| `Cmd+Enter` / `Ctrl+Enter` | Also sends (works while composing) |
| `Cmd+K` / `Ctrl+K`         | Command palette of in-chat actions |
| `Cmd+F` / `Ctrl+F`         | Find in the current chat           |
| `Cmd+Z` / `Ctrl+Z`         | Undo composer text edits           |
| `Cmd+Shift+Z` / `Ctrl+Y`   | Redo composer text edits           |

Undo after sending restores the submitted text into the composer for editing.
It does not retract or resend the message. `Ctrl+Shift+Z` also supports Redo.

## Chat menus

In the current source tree, the sidebar **ellipsis** menu groups actions as:

- **Chat** — Review last turn, Chat versions, Export chat
- **Configure** — Extensions…, Skills…, Prompts…, Agent instructions…, Working Animation
  (opens the existing animation selector for `piRpc.workingAnimation`; choose braille,
  dots, bars, earth, moon, or dolphin there; braille is the default, and the picker
  describes your current preference)
- **System** — Restart π

The sidebar always shows the Agentic chat list. Opening a chat or starting a new
one uses a native editor tab. The **editor-title Pi Chat Actions**
menu additionally offers rename, retry (including with another model), find, copy as
Markdown, thinking level, compaction, attachments, health, logs, and help.
Model and thinking controls live in the composer status chip; there is no composer gear.
With Pi 1.2.0 or 1.3.0, opening model selection refreshes OpenRouter's key-specific models
in the background while cached choices remain usable. Discovery does not run during
activation or warmup. Offline mode keeps cached models; a failed refresh shows a
clear fallback message in the picker.

## Settings worth knowing (Settings → Pi RPC)

- **Working Animation** — choose one of the six working glyph styles (default:
  braille). The separate decorative **π** logo has a fixed shape; this setting does
  not change it. Its breathing motion and the glyph animation respect reduced motion.
- **Typewriter Speed** — how smoothly streamed answers type out (off / slow / normal / fast).
- **Chat Font Family / Size** — the transcript font.
- **Notify On Complete** — ping when a long response finishes and the chat isn’t focused.
- **Auto Compact Mode / Percent** — `piRpc.autoCompact.mode` defaults to `auto`;
  `piRpc.autoCompact.percent` defaults to **75%** of the model's detected context window.
  The old `piRpc.autoCompactThreshold` setting is deprecated.
- **CodeLens Enabled** — the inline “Ask Pi” action above functions/methods.
- **Remote → Broker URL / Host Secret** — required for **Connect a phone**.
- **Pi Executable Path** — set this if `pi` isn’t on your `PATH`.

## Troubleshooting

- **Stuck on “Connecting…”** → use **Show Health** in the editor-title menu or Command
  Palette, or **Restart π**. Make sure
  `pi --version` works in a terminal and that you’ve logged in.
- **“Pi is still connecting…”** when using `/` → wait a moment; slash commands need a live session.
- **Wrong/old Pi** → set the **Pi Executable Path** setting to the exact binary.
- **Phone won’t pair** → make sure **Remote → Broker URL** and **Host Secret** are set, and pair
  before the code expires. If it says the code expired, just run **Start Remote Session** again.
- **Phone connected but blank** → open (or click into) a chat in VS Code so there’s an active
  conversation to mirror.

## Privacy & security

- Runs entirely locally against your own `pi` process — this extension adds **no telemetry**.
- Respects **VS Code Workspace Trust**: in a restricted workspace, chat is read-only and
  mutating actions stay disabled until you trust the folder.
- Diagnostics exports are redacted and never include transcript text, drafts, or secrets.
- Pi extension prompts use inline selection, confirmation, input and multiline
  editor controls with Cancel. Suggested composer text always waits for Use or
  Keep, including an empty composer; later typing and attachments stay protected.
  The synchronous native `getEditorText()` getter remains unavailable over RPC
  and returns an empty string, matching Pi's terminal RPC contract.

## Notes

- Workspace folders are isolated. `piRpc.runtimeWorkers` sizes the shared worker pool
  (`auto`, or 1–8); disabling shared runtime or a host startup failure uses per-chat processes.
- Agentic is the sole interface in 0.2.22. Its 27 supported command paths have
  automated coverage, with additional installed VS Code checks for chat-list
  navigation, deletion and composer layout. Terminal-only extension UI
  and physical OS input methods retain their documented limits; this does not
  establish universal native TUI parity.
- The Activity Bar icon and gallery logo are an original Pi × VS Code fusion mark.

## Credits & affiliation

This is an **independent, unofficial** project. I am **not affiliated with pi.dev** and
claim no endorsement by them. All credit for the Pi coding agent goes to its authors at
[pi.dev](https://pi.dev); this extension only talks to Pi over its documented RPC protocol.
Built for personal use and shared freely for anyone who finds it useful.

## License

MIT
