# RPC topology + live TUI↔GUI sync — analysis

## 1. It is already NOT "one RPC per chat"

Verified in code:

- `SessionRegistry.controllers` is a `Map` keyed by **workspace folder URI**
  (`folder.uri.toString()`), created via `getOrCreate(folder)`.
- Each `SessionController` owns exactly **one** `PiProcessSupervisor` =
  **one `pi --mode rpc` process**.
- Every chat tab for a folder resolves to that **same** controller
  (`contextForResource` → `getByFolderUri(target.workspaceFolderUri)`).
- Switching chats does **not** spawn a process — it calls the `switch_session`
  RPC on the existing one.

So today it's **one Pi process per workspace folder**, shared by all chats in
that folder. Not per‑chat. (With N folders open you get N processes.)

A hard constraint from Pi: **one RPC process has exactly one ACTIVE session at a
time.** With multiple chat tabs open, only the current one is live‑bound; the
others render a cached snapshot until re‑activated (this is the existing
`isCurrent` behavior).

## 2. Could we have a SINGLE global RPC (one process for everything)?

Feasible — Pi's `switchSession` accepts a `cwdOverride`, so one process could
serve multiple folders by switching sessions across working directories.

|                            | Per‑folder (current)   | Single global                      |
| -------------------------- | ---------------------- | ---------------------------------- |
| Processes                  | 1 per folder           | 1 total                            |
| Concurrent live sessions   | 1 per folder           | **1, globally**                    |
| Memory                     | higher w/ many folders | lowest                             |
| Switch cost                | cheap within a folder  | reload on every folder/chat switch |
| Warm‑start                 | pre‑warm each folder   | only one can be warm               |
| Trust/cwd/approval context | clean per folder       | must re‑establish on each switch   |

**Recommendation: keep per‑folder.** It already gives you the "single shared
RPC" you want _within a project_, with cheap chat switching, while still letting
different projects run concurrently. Single‑global only pays off if you routinely
open many folders and memory is the pain point — and it makes multi‑tab UX worse
(every switch reloads). The live‑sync feature does **not** require single‑global.

## 3. Live‑update of the OPEN chat from terminal edits

Both sides already persist to the same on‑disk `.jsonl`. The sidebar list is now
watched (v0.0.59). The remaining gap: an **open** transcript in the GUI is served
from its RPC process's **in‑memory** state, so it doesn't reflect messages the
terminal appended to that same session file.

Mechanism to fix it:

1. The sessions watcher already fires on `.jsonl` change.
2. If the changed file **is the active session** for a controller AND the
   controller is **idle** (`connectionState === 'ready'`, not busy/streaming),
   re‑open that session in the RPC process (`switch_session` to the same file
   re‑reads from disk) and reconcile → the terminal's new messages appear.
3. Debounce; briefly show the existing "Loading chat…" state.

### The one caveat — don't reload on our OWN writes

The GUI's RPC process also writes that file (when it generates). Naively
reloading on every change would loop / interrupt a live GUI turn. Mitigations:

- Only reload when the controller is **idle** (never mid‑stream / mid‑send).
- Suppress changes that happen within ~1.5s of our own send/reconcile
  (track a `lastSelfWriteAt` timestamp per controller).
- Only reload when the on‑disk size/mtime actually advanced beyond what we last
  wrote (external change detection).

This is safe and self‑correcting: if you're typing/generating in the GUI, nothing
reloads; when idle, a terminal append flows in within a debounce window.

## 4. Proposed plan (for confirmation)

- Keep **per‑folder RPC** (no single‑global).
- Add live open‑chat sync: on a watched change to the **active** session file,
  if the controller is idle and the change is external, re‑switch to it and
  reconcile (guarded by `lastSelfWriteAt` + idle + size/mtime check).
- Result: switch a session in the terminal → the GUI's open chat updates in
  place; switch in the GUI → the terminal sees it on `/resume`. Seamless both
  ways, no reload.

Open question for you: OK to proceed with the **idle‑reload** approach above
(safe, never interrupts an active GUI turn), or do you also want the GUI to
reload **mid‑generation** if the terminal changes the file (riskier — can clash
with an in‑flight GUI response)?
