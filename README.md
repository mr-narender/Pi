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

Pi RPC embeds the [Pi coding agent](https://pi.dev) inside VS Code. It runs the real
`pi` process in the background (`pi --mode rpc`) and gives you a native GUI on top of it:

- A **sidebar launcher** with a big **New Chat** button and your saved chats (search, rename, delete).
- **Chats open as editor tabs** in the center — one tab per session, reopenable and reload-safe.
- Everything the Pi TUI can do, surfaced through the UI: models, thinking levels, slash
  commands, attachments/context, compaction, retry, usage, and diagnostics.

It talks to Pi over Pi’s documented RPC protocol, so your existing Pi setup, models,
sessions, skills, prompts, and extensions all work unchanged.

## Prerequisites

You need Pi installed and authenticated **before** using this extension:

1. **Install the Pi CLI** (Node.js 18+):
   ```bash
   npm install -g @earendil-works/pi-coding-agent
   ```
   Verify it’s on your `PATH`:
   ```bash
   pi --version
   ```
2. **Authenticate Pi** once (either is fine):
   - Subscription / OAuth: run `pi` in a terminal and use `/login`, **or**
   - API key: export your provider key, e.g. `export ANTHROPIC_API_KEY=…`
3. **Open a folder** in VS Code (Pi runs per workspace folder).

> If `pi` isn’t on your `PATH`, set **Settings → Pi RPC → Pi Executable Path** to the full path.

## How it works

```
VS Code
├─ Sidebar (Pi)            New Chat · search · your saved chats (open / rename / delete)
└─ Editor tab "Pi Chat"    transcript · composer · attachments · model · More menu
        │
        ▼
pi --mode rpc              one background Pi process per workspace folder
```

- Pi **warm-starts** when the extension activates, so your first chat is ready fast.
- While Pi connects, the chat shows a **Connecting…** state and the composer is disabled.
- Sessions are named **Session N** by default and can be renamed; the real session id
  stays internal. Closing a tab never deletes the session.

## Getting started

1. Install the Pi CLI and log in (see **Prerequisites**).
2. Install this extension (VSIX or Marketplace) and open a project folder.
3. Click the **Pi** icon in the Activity Bar → **New Chat**.
4. Type your message and press **Cmd+Enter** (macOS) or **Ctrl+Enter** to send.

## Features (TUI parity, in a GUI)

| Area               | What you get                                                                         |
| ------------------ | ------------------------------------------------------------------------------------ |
| **Chats**          | Editor-tab conversations, streaming replies, one tab per session, reopen/resume      |
| **Sessions**       | Sidebar launcher, search, rename, delete, warm-start                                 |
| **Models**         | Choose model, cycle, set thinking level                                              |
| **Slash commands** | `/` lists Pi commands (skills, prompts, extension commands) and inserts them         |
| **Context**        | Attach the active file, a picked file, the current selection, diagnostics, or images |
| **Reliability**    | Auto-compaction, auto-retry, abort/stop, connection health                           |
| **Advanced**       | An opt-in Advanced mode exposes the full RPC surface via the Command Palette         |

## Keyboard

| Shortcut                   | Action                   |
| -------------------------- | ------------------------ |
| `Cmd+Enter` / `Ctrl+Enter` | Send the current message |

## The More menu

The **More ▾** menu in a chat groups actions with color tags for quick scanning:

- 🔵 **Session** — Rename chat, Export as HTML
- 🟠 **Model** — Choose model, Thinking level
- 🟣 **Context** — Compact conversation, Usage & cost
- 🟢 / 🔴 **System** — Advanced mode, Restart Pi, Connection health, Help

## Troubleshooting

- **Stuck on “Connecting…”** → run **More → Connection health**, or **Restart Pi**. Make sure
  `pi --version` works in a terminal and that you’ve logged in.
- **“Pi is still connecting…”** when using `/` → wait a moment; slash commands need a live session.
- **Wrong/old Pi** → set the **Pi Executable Path** setting to the exact binary.

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
