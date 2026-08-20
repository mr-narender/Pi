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

- **Parallel chats** — every chat tab is its own independent Pi session on ONE shared
  runtime (not one process per chat). Fire off a long task in one chat and keep working
  in another; closing a tab tears down just that session.
- A **sidebar launcher** with an instant **New Chat** (a draft session is prewarmed for
  you), your saved chats, an **Other projects** group with every chat from every
  project, live status badges, and **full-text search across chat content**.
- **Mission Control** — the status bar shows how many chats are open / generating /
  waiting for your approval; background chats that need permission raise a notification.
- **Turn review** — when a turn changes files, review a consolidated list: open
  before↔after diffs, revert one file, or revert everything the turn touched.
- **Edits fork, visibly** — editing a message re-runs the chat on a fork in the same
  tab; `Pi: Show Chat Versions` opens any earlier version.
- **Quick switcher** (`Cmd/Ctrl+Alt+P`), aggregate usage/cost across open chats,
  export/copy conversations, and everything the Pi TUI can do: models, thinking levels,
  slash commands, attachments/context, compaction, retry, usage, diagnostics.
- **Watch & drive from your phone** — a **Connect a phone** button mirrors the live chat
  to a phone browser (opt-in via `piRpc.remote.enabled`).

It talks to Pi over Pi’s documented RPC protocol, so your existing Pi setup, models,
sessions, skills, prompts, and extensions all work unchanged.

## Prerequisites

**No manual Pi install needed.** By default (`piRpc.piSource: managed`) the extension
bootstraps the **latest Pi** from npm into its own storage on first use and silently
keeps it updated (staged downloads apply on reload). You only need:

1. **npm on your PATH + network once** (for the first-run bootstrap and updates).
2. **Authenticate Pi** once (either is fine):
   - Subscription / OAuth: run `pi` in a terminal and use `/login`, **or**
   - API key: export your provider key, e.g. `export ANTHROPIC_API_KEY=…`
3. **Open a folder** in VS Code.

> Prefer your own install? Set `piRpc.piSource` to `external` and (optionally)
> **Settings → Pi RPC → Pi Executable Path**.

## How it works

```
VS Code
├─ Sidebar (Pi)            New Chat · search (titles + content) · saved chats · Other projects
└─ Editor tabs "Pi Chat"   one INDEPENDENT Pi session per tab — chats run in parallel
        │
        ▼
shared Pi runtime host     ONE worker hosts every session (per-session extensions/MCP);
                           a draft session is prewarmed so New Chat opens instantly
```

- The first chat boots the shared runtime; every further chat attaches in the background
  while the tab paints immediately (animated loader, then the composer goes live).
- Sessions are named **Session N** by default and can be renamed; the real session id
  stays internal. Closing a tab tears down only that chat's session — never the file.
- Each message **edit forks** the session and stays in the same tab; stale fork
  ancestors are collapsed in the sidebar and reachable via `Pi: Show Chat Versions`.

## Getting started

1. Install this extension and open a project folder (Pi auto-installs on first use).
2. Log in once if you haven't (see **Prerequisites**).
3. Click the **Pi** icon in the Activity Bar → **New Chat**.
4. Type your message and press **Enter** to send (**Shift+Enter** for a newline).

## Features (TUI parity, in a GUI)

| Area               | What you get                                                                                               |
| ------------------ | ---------------------------------------------------------------------------------------------------------- |
| **Chats**          | Editor-tab conversations, live streaming, one tab per session, reopen/resume, branch & duplicate           |
| **Sessions**       | Sidebar launcher, search, **pin**, rename, delete, warm-start                                              |
| **Models**         | Choose/cycle model, thinking level, retry last message (optionally with a different model)                 |
| **Compose**        | `/` slash commands, `@file` mentions, drag-drop & **pasted** images, attach file/selection/diagnostics     |
| **Ask Pi**         | Right-click a selection or use the inline **CodeLens** above functions to Explain / Fix / Refactor         |
| **Navigate**       | Command palette (`Cmd/Ctrl+K`), find-in-chat (`Cmd/Ctrl+F`), jump-to-latest, conversation map              |
| **Flow**           | Queue/steer follow-ups, Continue, abort/stop, auto-retry, auto-compaction, usage & cost chip               |
| **Feel**           | Enter-to-send, typewriter streaming, working animation, chat-font controls, completion notifications, a11y |
| **Remote (phone)** | **Connect a phone** to watch the live chat in a browser and take control to drive it                       |

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

## The More menu

The **More ▾** menu in a chat groups actions with color tags for quick scanning:

- 🔵 **Session** — Rename chat, Retry last message, Copy as Markdown, Export as HTML
- 🟠 **Model** — Choose model, Thinking level
- 🟣 **Context** — Compact conversation
- 🟢 / 🔴 **System** — Restart Pi, Connection health, Show logs, Help

Model, usage/cost, Continue and the ⚙️ settings gear live in the **composer toolbar** at the
bottom-right of the chat.

## Settings worth knowing (Settings → Pi RPC)

- **Working Animation** — spinner style shown while Pi is working.
- **Typewriter Speed** — how smoothly streamed answers type out (off / slow / normal / fast).
- **Chat Font Family / Size** — the transcript font.
- **Notify On Complete** — ping when a long response finishes and the chat isn’t focused.
- **Auto Compact Threshold** — auto-compact the conversation when context usage hits this %.
- **CodeLens Enabled** — the inline “Ask Pi” action above functions/methods.
- **Remote → Broker URL / Host Secret** — required for **Connect a phone**.
- **Pi Executable Path** — set this if `pi` isn’t on your `PATH`.

## Troubleshooting

- **Stuck on “Connecting…”** → run **More → Connection health**, or **Restart Pi**. Make sure
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

## Notes

- One Pi process per workspace folder; multi-root workspaces are isolated.
- The Activity Bar icon and gallery logo are an original Pi × VS Code fusion mark.

## Credits & affiliation

This is an **independent, unofficial** project. I am **not affiliated with pi.dev** and
claim no endorsement by them. All credit for the Pi coding agent goes to its authors at
[pi.dev](https://pi.dev); this extension only talks to Pi over its documented RPC protocol.
Built for personal use and shared freely for anyone who finds it useful.

## License

MIT
