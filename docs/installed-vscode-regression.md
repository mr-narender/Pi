# Installed VS Code regression validation

Historical 0.2.21 installed-test record. Its sidebar conversation checks describe
that release; 0.2.22 keeps the sidebar on the chat list and opens chats in tabs.

The Agentic-only VSIX was installed through the normal VS Code CLI, without
`extensionDevelopmentPath`. The original Pi 0.2.20 installation was backed up.
Test windows used separate user-data profiles and fixture workspaces. Subsequent
session/provider tests also isolated `PI_CODING_AGENT_DIR`; no user window was
reloaded and no user credentials or conversations were changed by those tests.

## Bugs characterized and fixed

- A chat-list snapshot posted before renderer readiness could poison deduplication
  and leave “Loading chats…” displayed. Explicit resync invalidates only the row
  identity; refresh loading remains suppressed after real data. The first empty
  ready model now replaces initial loading. Real-host tests cover delivery failure,
  reload resync and refresh completion.
- The working timer captured the first frame family. A live braille-to-Earth change
  reverted to braille on the next tick. Timer ticks now select current rendered
  frames while retaining a single timer. Tests cover all six choices and both surfaces.
- A sent draft keeps its original editor URI even when its target becomes a saved
  session. Show chat in sidebar now closes that exact resource before attaching the sidebar.
  Whole-session compaction checks run before closing anything; native boolean close
  refusal aborts the move before persisting a new sidebar target.
- Intrinsic grid/flex widths clipped Send in a 297px sidebar. Existing grid tracks
  can now shrink and composer actions wrap. All six controls fit within the composer
  and viewport at 220, 250, 297, 360 and 650px, with chat font sizes 14 and 24.

## Actual installed observations

Global Pi 1.0.1 reached Ready through stock RPC. Its existing diagnostic reports
that the canonical SDK contract is unaudited. A separately selected supported
Pi 1.0.0 used the shared SDK host. Both used fixture-owned local loopback replies;
no paid/public provider requests were needed.

Installed checks exercised immediate slash activation, native model/settings
pickers, Follow Agent off, trusted Chromium held Enter/composition handling,
all six live working animations, deferred empty assistant rendering, saved-session
Show chat in sidebar/Show chat list, draft/image preservation across moves and window reload,
and trusted Shift+Tab thinking changes. A fixture input hook recorded `source:"rpc"`.
Accepted plain-text input cleared its draft. Reloaded image chips displayed the
existing “Reselect image” contract.

The 27 command paths remain covered by the supported native fixture suites;
installed menu/reply checks are a subset. Live OAuth, external publication,
physical clipboard, OS input-method drivers, arbitrary providers and other VS Code
versions were not verified. Chromium composition is not an OS IME receipt.

## Repeating the installed layout assertion

Launch a caller-owned normal VS Code test window with an installed Pi VSIX and
`--remote-debugging-port=PORT`, separate `--user-data-dir`, fixture workspace and
isolated Pi data. Open a ready composer, then run:

```sh
node scripts/check-installed-composer.mjs http://127.0.0.1:PORT
```

The read-only native CDP harness requires visible Send and all six ready controls,
checks positive dimensions, viewport/card bounds and pairwise overlap, and rejects
CDP errors/timeouts. It does not install, close or reload VS Code. Resize the actual
sidebar sash and change the test profile's `piRpc.chatFontSize` to repeat the matrix.
An installed-origin/package hash receipt must accompany this geometry check;
the geometry alone does not prove package origin, occlusion or physical input.

The final regression gate reports 555 unit passes, 268 integration passes and the
same one optional archived-workflow skip, plus successful Extension Host execution.
Format, lint, source/test types and non-clean build passed. Existing host drift
and unavailable graphify limitations remain as documented in the hard-cut report.
Stable local artifacts are indexed under `LOCAL-pi-installed-vscode-regression-20261004`.
