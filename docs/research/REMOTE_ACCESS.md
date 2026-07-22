# Remote access to a Pi chat session — research

Goal: let a user reach the **same Pi chat session** from another machine / device
/ browser, not just the local VS Code window where the extension runs.

## Current architecture (what we have)

- The extension spawns `pi --mode rpc` as a **local child process** per workspace
  folder (`PiProcessSupervisor`).
- Communication is newline-delimited JSON over the child's **stdio**
  (`RpcTransport` ⇄ `RpcClient`). One controller = one folder = one live session.
- Sessions persist as JSONL at `~/.pi/agent/sessions/--<cwd>--/<ts>_<uuid>.jsonl`.
- UI is a VS Code **custom editor webview** driven by `WebviewSnapshot`s.

Implication: "remote access" can mean three different things. Pick per use case.

---

## Option A — Run the extension remotely, view locally (ZERO new code)

Use VS Code's built-in remote hosts. The extension host (and therefore Pi) runs
on the remote machine; your local VS Code is just the UI.

- **Remote-SSH**: `code --remote ssh-remote+host /path`. Pi runs on `host`.
- **Tunnels**: on the remote box run `code tunnel`; open from another machine via
  `https://vscode.dev/tunnel/<name>` or desktop. Works through NAT, no ports.
- **Dev Containers / Codespaces**: same model.

Pros: nothing to build; secure (SSH / MS tunnel auth); full VS Code UX.
Cons: it's _your_ VS Code driving a _remote_ Pi — not multi-device sharing of one
live session, and not a browser-native chat.
Action: verify the extension declares no `extensionKind` that forces `ui`; it
should run as a **workspace** extension so it executes on the remote host (it
spawns a subprocess + touches the FS, so workspace is correct). Add
`"extensionKind": ["workspace"]` to `package.json` to be explicit, and gate the
"virtual workspace" case (already unsupported).

## Option B — Session-broker server + thin remote clients (MOST FLEXIBLE)

Add a small **broker** that owns the Pi RPC process and multiplexes it to N
remote clients (browser, phone, another VS Code) over WebSocket.

```
[Pi rpc child] ⇄ RpcTransport ⇄ [Broker (ws server)] ⇄ ws ⇄ [remote web UI / VS Code]
```

- Reuse `RpcTransport` + `RpcClient` unchanged; add a `WsTransport` that speaks
  the same framed-JSON protocol over a WebSocket instead of stdio.
- Broker responsibilities: 1 Pi process per session, fan-out events to all
  connected clients, forward client commands, replay the current
  `WebviewSnapshot` (or the JSONL tail) to a newly-connected client so it "joins"
  mid-session, backpressure + the same record/buffer caps we already enforce.
- Web client: reuse the existing webview `render.ts` + `chat.ts` (they already
  consume `WebviewSnapshot` and post messages) — serve them as a static page and
  swap `acquireVsCodeApi()` for a WebSocket shim. ~90% of the UI is reusable.

Pros: real multi-device / browser access, mid-session join, collaboration.
Cons: new server + auth + transport; security surface (see below).
Effort: medium. This is the "native remote" story.

## Option C — Piggyback the webview over a tunnel (QUICK DEMO)

VS Code can forward ports; expose the broker's ws port via
`vscode.env.asExternalUri` + the built-in port forwarding / `code tunnel`. Lets a
browser hit the broker without opening firewall ports. Good for demos; still
needs Option B's broker.

## Option D — Live Share

Microsoft Live Share shares the editor/session collaboratively. Heavyweight and
not chat-native; only worth it if you want full co-editing, not just chat.

---

## Security (mandatory for B/C — this is the risk surface)

Remote access to a coding agent = remote code execution. Non-negotiable:

- **Auth**: per-session bearer token (rotating), or device-pairing code; never
  an open port. Prefer VS Code tunnel auth (MS/GitHub) where possible.
- **Transport**: WSS/TLS only. Bind to loopback + tunnel by default, not `0.0.0.0`.
- **Approvals**: keep `--no-approve` semantics; remote clients must NOT silently
  gain write/exec. Surface tool-approval prompts to the remote UI and require
  explicit confirmation. Respect workspace trust.
- **Scope**: read-only "spectator" vs "driver" client roles; only one driver.
- **Caps**: reuse `maxRecordBytes` / buffer caps; rate-limit remote commands.

---

## Recommendation

1. **Now / free**: document + verify **Option A** (Remote-SSH / tunnels). Set
   `extensionKind: ["workspace"]`. This ships today with zero risk.
2. **Next**: build **Option B** broker as an opt-in feature
   (`piRpc.remote.enable`), reusing `RpcTransport`/`RpcClient` and the existing
   webview render, with token auth + WSS + spectator/driver roles. Start behind a
   setting, loopback+tunnel only.
3. Skip C/D unless a specific need (C = demo shortcut, D = full co-edit).

## Concrete first steps for Option B (spike)

- `src/remote/wsTransport.ts` — same frame format as `RpcTransport`, over `ws`.
- `src/remote/broker.ts` — owns one supervisor/session, fans out snapshots,
  applies inbound `WebviewInboundMessage`s (reuse `parseWebviewMessage`).
- `src/webview/remoteHost.ts` — static bundle of `render.ts`+`chat.ts` with a
  `vscodeApi` shim backed by WebSocket.
- Command `piRpc.remote.share` → starts broker, mints a token, returns an
  `asExternalUri` link (+ QR) to open the web client.
- Tests: transport frame round-trip, broker fan-out + mid-session join snapshot,
  auth reject, role enforcement.

## Open question for you

Your message was cut off at "...remote access to this session **using** \_\_\_".
Which target did you have in mind so I scope the spike precisely?

- (a) VS Code **tunnels / Remote-SSH** (Option A, ready today), or
- (b) a **browser / phone** web client (Option B broker), or
- (c) something specific (ngrok/Cloudflare tunnel, Tailscale, a self-hosted
  relay, WebRTC, etc.)?
