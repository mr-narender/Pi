# LOCAL-003 UX redesign — Pi RPC as a simple coding chat

## Outcome

Pi RPC should feel like a coding chat first and an RPC surface second.

### Default Simple Mode

- **Sidebar destinations only:** **New Chat**, **Resume Chat**, **Current Chat**
- **Chat surface only:** chat header, transcript, composer, **Attach**, **Send**, **Stop**, **Model**
- **Everything else:** one **Advanced** drawer/menu and the existing **Command Palette** commands
- **No protocol loss:** all current RPC actions remain reachable

### Design rules

- Prefer **VS Code native patterns** over web styling
- Use **VS Code theme tokens, system font, codicons, focus rings, input/button styles**
- Default to **progressive disclosure**
- Optimize for **recognition over recall**
- Keep **chat as the dominant surface**

## Inputs reviewed

- `README.md`
- `docs/MANUAL_ACCEPTANCE.md`
- `docs/issues/LOCAL-003.md`
- `docs/issues/LOCAL-002.md`
- `src/webview/render.ts`
- `src/webview/media/chat.ts`
- `src/webview/provider.ts`
- `src/webview/model.ts`
- `src/webview/messages.ts`
- `src/ui/trees/providers.ts`
- `src/ui/trees/sessionSidebarModel.ts`
- `src/ui/status/statusBar.ts`
- `package.json`
- `/tmp/pi-rpc-ui-design.md`
- `/tmp/pi-rpc-ux-guidance.txt`
- `/tmp/pi-rpc-web-guidance.txt`

## Heuristic audit of current UI

| Heuristic               | Current issue                                 | Evidence from source                                                                                    | Redesign response                                                                             |
| ----------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Information hierarchy   | Too many top-level destinations               | 6 sidebar views + chat panel + status bar surfaces                                                      | Reduce default sidebar to 3 destinations; collapse all expert controls into one Advanced area |
| Cognitive load          | First-run screen reads like a tool console    | Chat renders ~60 interactive controls across header, composer, details panels, forms, and debug buttons | Keep only chat essentials in Simple Mode                                                      |
| Progressive disclosure  | Advanced controls appear before first message | Queues, workflow, status/widgets, bash, diagnostics, extension UI all render in default chat            | Hide all non-core controls behind Advanced                                                    |
| Recognition over recall | Users must know Pi concepts up front          | “Steering”, “follow-up”, “compaction”, “compatibility events” are visible before intent is established  | Replace with plain chat actions first; keep expert language only inside Advanced              |
| Consistency             | Same actions appear in several places         | Start/new/resume appear in sidebar, toolbar, and chat header; model/status also repeated in status bar  | Give each view one clear primary action; use one advanced entry point                         |
| Status visibility       | Status exists, but importance is unclear      | Header meta, pills, queue status bar, usage status bar, keyed statuses all compete                      | Use one current-state line in header; reserve detailed status for Advanced                    |
| Accessibility           | Keyboard path is long and repetitive          | Default tab order crosses many buttons/forms before transcript/composer completion                      | Shorten default focus path; add predictable focus restore and skip-to-composer                |
| Accessibility           | Duplicate content risks noisy announcements   | Widgets render inline and again inside “Status & Widgets”                                               | Keep runtime widgets only once in context                                                     |
| Narrow layouts          | Many wrap-heavy button rows                   | Header and composer actions rely on wide flex rows                                                      | Replace many buttons with attach menu + advanced menu                                         |

## Proposed information architecture

### Sidebar

1. **New Chat**
   - Primary action: **New Chat**
   - With no current chat, create a fresh chat immediately
   - With a current chat, show a focused confirmation with exactly two options:
     - **Start fresh** _(default)_
     - **Continue from current as parent**
   - If the current chat has an unsent draft, pending images, or context chips, show: `Unsent draft and attachments stay in Current Chat. They won't be sent or copied.`
   - `Cancel` closes the confirmation, preserves the current draft/chips, and returns focus to the composer
2. **Resume Chat**
   - Primary action: resume a recent chat from the list
   - Secondary content: search/filter, refresh, empty/loading/error states
3. **Current Chat**
   - Primary action: **Open Current Chat** if chat panel is not focused
   - Secondary content: workspace, session, model, status summary

### Chat panel

- Header
- Transcript
- Composer
- Advanced drawer/menu

### Advanced

Single entry point from:

- chat header: **Advanced**
- Current Chat view title/body: **Advanced**
- Command Palette: existing `Pi RPC:*` commands remain unchanged

### Advanced Mode

- **Default:** Simple Mode
- **Toggle:** `Pi RPC: Toggle Advanced Mode`
- **Persistence:** store `simple|advanced` in extension global state
- **Behavior:** Advanced drawer can stay pinned open across sessions
- **Reversible:** turning it off hides advanced UI, not capability

## Wireframes

### 1) Empty state

```text
Sidebar
┌ New Chat ────────────────────────────────┐
│ Start fresh with Pi in this workspace    │
│ [ New Chat ]                             │
└──────────────────────────────────────────┘
┌ Resume Chat ─────────────────────────────┐
│ Recent chats                             │
│ [Search]                                 │
│ • Fix tests · 2h ago                     │
│ • Refactor auth · Yesterday              │
└──────────────────────────────────────────┘
┌ Current Chat ────────────────────────────┐
│ No current chat                          │
│ Workspace: repo-name                     │
│ Status: Ready to start                   │
│ [ Open Current Chat ]                    │
└──────────────────────────────────────────┘

Chat panel
┌ Current Chat ─────────────────────── [Model v] [Advanced] ┐
│ repo-name · No chat yet · Ready                            │
├─────────────────────────────────────────────────────────────┤
│ No messages yet.                                            │
│ Start a new chat, resume a saved chat, or type below.       │
│ [ New Chat ]  [ Resume Chat ]                               │
├─────────────────────────────────────────────────────────────┤
│ Message Pi                                                  │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ Ask for code help…                                     │ │
│ └─────────────────────────────────────────────────────────┘ │
│ [Attach]                                         [Send]    │
└─────────────────────────────────────────────────────────────┘
```

### 1b) New Chat confirmation when relevant

```text
┌ New chat ──────────────────────────────────────────────────┐
│ Start a new chat from this workspace.                      │
│ Unsent draft and attachments stay in Current Chat.         │
│ They won't be sent or copied.                              │
│                                                             │
│ [Start fresh] [Continue from current as parent] [Cancel]   │
└─────────────────────────────────────────────────────────────┘
```

### 2) Running state

```text
┌ Current Chat ─────────────────────── [Model v] [Advanced] ┐
│ repo-name · feature/login · Pi is replying                 │
├─────────────────────────────────────────────────────────────┤
│ You                                                        │
│ Add tests for session switching.                           │
│                                                             │
│ Pi                                                         │
│ Streaming…                                                 │
├─────────────────────────────────────────────────────────────┤
│ Message Pi                                                  │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ Add a quick summary too                                │ │
│ └─────────────────────────────────────────────────────────┘ │
│ Attachments for next message                               │
│ [IMG test.png ×] [File src/auth.ts ×] [Selection L18-34 ×] │
│ [Attach]                                   [Send next] [Stop]│
└─────────────────────────────────────────────────────────────┘
```

Behavior:

- `Send` while idle => `prompt`
- `Send next` while busy => queue as follow-up with inline confirmation
- explicit steering stays in Advanced
- `Stop` maps to `abort`
- attachment tray is hidden when empty

### 3) Resume state

```text
Resume Chat
┌ Search recent chats ________________________________ [↻] ┐
│ Current: feature/login · Ready                          │
│                                                         │
│ Today                                                   │
│ • Fix RPC layout         repo-name · gpt-4.1 · Current  │
│ • Diagnose startup       repo-name · 1h ago             │
│                                                         │
│ Yesterday                                               │
│ • Export bug             repo-name · 1d ago             │
└─────────────────────────────────────────────────────────┘
```

Selection behavior:

- one click resumes if there is no current session
- if another session is open, show concise confirmation
- preserve unsent draft per session and restore focus to composer after switch

### 4) Error state

```text
┌ Current Chat ─────────────────────── [Model v] [Advanced] ┐
│ repo-name · feature/login · Needs attention               │
│ ! Pi disconnected. Your last confirmed chat is safe.      │
│ [Restart Pi] [Resume another chat] [Show details]         │
├─────────────────────────────────────────────────────────────┤
│ Last confirmed messages remain visible.                    │
├─────────────────────────────────────────────────────────────┤
│ Message Pi                                                  │
│ Draft preserved. Not resent. [Copy to composer] [Send again]│
│ [Attach]                                         [Send]    │
└─────────────────────────────────────────────────────────────┘
```

`Show details` opens the Advanced drawer to diagnostics/recovery.

## Interaction and state transitions

```text
Open extension
  ├─ no active session → Current Chat empty state
  │    ├─ New Chat → auto-start if needed → create fresh session → focus composer
  │    ├─ Resume Chat → open recent list → switch session → focus composer
  │    └─ Send first message → auto-start if needed → create session → stream reply
  └─ active session exists → Current Chat with restored draft/transcript

New Chat from active chat
  ├─ open focused confirmation
  ├─ Start fresh (default) → create unrelated session → keep old draft/chips on old session
  ├─ Continue from current as parent → create child session from confirmed history only
  │    └─ keep old draft/chips on old session; do not copy unsent content
  └─ Cancel → keep current chat unchanged → restore focus to composer

Composer send path
  ├─ edit draft/chips/images inside workspace+session composer state
  ├─ Send / Send next / Steer → build exact preflight preview
  ├─ Cancel preview → return to editor unchanged
  ├─ Accept preview → freeze immutable accepted-send snapshot
  ├─ send exact RPC request shape (`prompt`/`follow_up`/`steer`) with serialized text envelope + RPC images
  ├─ accepted workflow stays frozen until `agent_settled`
  └─ failure before `agent_settled` → never auto-resend → offer Copy to composer / Send again

While streaming
  ├─ Stop → abort current run
  ├─ Send next → queue follow-up from the current editable composer state
  ├─ Attach → add pending chips for next send only
  └─ Advanced → steering / queue modes / diagnostics / workflow

Session switch
  ├─ store composer state keyed by canonical workspace folder + session path/id (or workspace draft slot before first session)
  ├─ switch session
  ├─ restore transcript snapshot
  └─ restore draft + chips + in-memory images + keyboard focus for that session only

Recovery
  ├─ start failure before ready → Start again
  ├─ disconnect/crash after ready → Restart Pi → reconcile state/messages/session
  ├─ prompt failed after acceptance → keep immutable accepted-send snapshot → offer Copy to composer / Send again
  └─ preflight rejected before acceptance → return draft/chips/images unchanged

Advanced Mode toggle
  ├─ Simple → hide advanced UI, keep command palette access
  └─ Advanced → pin advanced drawer open, persist preference
```

## Deterministic journey specs

### New Chat

| Situation                                | UI                                          | Result                                                                            |
| ---------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------- |
| No current chat                          | Clicking `New Chat` acts immediately        | Fresh chat opens; composer is empty and focused                                   |
| Current chat, no unsent draft/chips      | Focused confirmation                        | `Start fresh` is default; `Continue from current as parent` creates a child chat  |
| Current chat with unsent draft/chips     | Same confirmation + explicit warning        | Warning states the unsent draft/chips stay on the current chat and are not copied |
| Choose `Start fresh`                     | Create unrelated session                    | Current chat remains unchanged; returning restores its draft/chips exactly        |
| Choose `Continue from current as parent` | Create child from current confirmed history | New chat starts empty; unsent draft/chips remain only on the original chat        |
| Choose `Cancel`                          | Dismiss confirmation                        | No session change; draft/chips preserved; focus returns to composer               |

### Attachment model

- `Attach` opens one menu, but each source becomes an explicit pending chip in the composer tray.
- Composer text stays user-authored. Active file, picked file, selection, and diagnostics are carried as **structured client context**, not silently inserted prose.
- Each chip exposes a preview affordance plus source, scope, size, removal, and privacy text.
- `Clear attachments` removes only pending chips for the next send. It never edits draft text and never removes already-sent message metadata.

| Source              | Chip                                             | Preview                                                                     | Scope + size                                                      | Removal + privacy                                                                                                              |
| ------------------- | ------------------------------------------------ | --------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `Image…`            | Removable image chip with thumbnail + filename   | Thumbnail, filename, MIME, file size                                        | Sent on the next message only; exact file size shown              | `×` removes one image; `Clear attachments` removes all pending chips; privacy label: `Local image · sent on next message only` |
| `Active file`       | Context chip: `Active file: <relative path>`     | Path, workspace, language, line/byte count, first excerpt, open-file action | Full active editor snapshot taken at attach time                  | `×` removes the chip; privacy label: `Workspace file snapshot`                                                                 |
| `Pick file…`        | Context chip: `File: <relative path>`            | Path, workspace, line/byte count, first excerpt, open-file action           | Picked file snapshot taken at attach time                         | `×` removes the chip; privacy label: `Selected file snapshot`                                                                  |
| `Current selection` | Context chip: `Selection: <file> Lx-Ly`          | Code excerpt with path and selected range                                   | Selected text only; line count and character count shown          | `×` removes the chip; privacy label: `Selected text only`                                                                      |
| `Diagnostics`       | Context chip: `Diagnostics: <file> · <n> issues` | Severity counts + first issues for the active file                          | Active-file diagnostic snapshot at attach time; issue count shown | `×` removes the chip; privacy label: `Active-file diagnostics snapshot`                                                        |

### Client-side composer state

```ts
type PendingContextItem =
  | {
      kind: 'activeFile';
      itemId: string;
      workspaceFolder: string;
      workspaceRelativePath: string;
      lineStart: number;
      lineEnd: number;
      languageId: string;
      sanitizedContent: string;
      capturedAt: string;
      persistedRef: {
        workspaceRelativePath: string;
        lineStart: number;
        lineEnd: number;
        languageId: string;
        contentFingerprint: string;
      };
    }
  | {
      kind: 'pickedFile';
      itemId: string;
      workspaceFolder: string;
      workspaceRelativePath: string;
      lineStart: number;
      lineEnd: number;
      languageId: string;
      sanitizedContent: string;
      capturedAt: string;
      persistedRef: {
        workspaceRelativePath: string;
        lineStart: number;
        lineEnd: number;
        languageId: string;
        contentFingerprint: string;
      };
    }
  | {
      kind: 'selection';
      itemId: string;
      workspaceFolder: string;
      workspaceRelativePath: string;
      lineStart: number;
      lineEnd: number;
      languageId: string;
      sanitizedContent: string;
      capturedAt: string;
      persistedRef: {
        workspaceRelativePath: string;
        lineStart: number;
        lineEnd: number;
        languageId: string;
        contentFingerprint: string;
      };
    }
  | {
      kind: 'diagnostics';
      itemId: string;
      workspaceFolder: string;
      workspaceRelativePath: string;
      lineStart: number;
      lineEnd: number;
      severity: 'error' | 'warning' | 'info' | 'hint' | 'mixed';
      issueCount: number;
      sanitizedContent: string;
      capturedAt: string;
      persistedRef: {
        workspaceRelativePath: string;
        lineStart: number;
        lineEnd: number;
        severity: 'error' | 'warning' | 'info' | 'hint' | 'mixed';
        issueCount: number;
        diagnosticFingerprint: string;
      };
    };

type ComposerSessionState = {
  draft: string;
  pendingContextItems: PendingContextItem[];
  pendingImages: Array<{
    itemId: string;
    name: string;
    mimeType: string;
    sizeBytes: number;
    width?: number;
    height?: number;
    inMemoryBase64: string;
  }>;
  focus: 'composer' | 'attach' | 'contextChip' | 'imageChip' | 'preview' | 'none';
  acceptedSendSnapshot?: {
    command: 'prompt' | 'follow_up' | 'steer';
    draft: string;
    serializedContextEnvelope: string;
    rpcMessage: string;
    rpcImages: Array<{ type: 'image'; data: string; mimeType: string }>;
    contextItems: PendingContextItem[];
    imageItems: Array<{
      itemId: string;
      name: string;
      mimeType: string;
      sizeBytes: number;
    }>;
    acceptedAt: string;
    state: 'accepted' | 'failed';
  };
};
```

Rules:

- Composer state is keyed per canonical workspace folder and per session path/id; before the first session exists, use a workspace-scoped draft slot.
- Draft text is always user-authored text only.
- Non-image chips live in `pendingContextItems` and are never mirrored into `images`.
- Images live in `pendingImages` and are the only data transformed into RPC `images` objects.
- After preview acceptance, `acceptedSendSnapshot` becomes immutable and remains the only recovery source until `agent_settled`.

### Deterministic transport and preview

Non-image chips are transported only through the RPC `message` string as one escaped context envelope. Images remain exact Pi RPC `images` entries.

Exact envelope shape:

```text
<pi-vscode-context-v1>
{"kind":"activeFile","workspaceRelativePath":"src/auth.ts","lineStart":1,"lineEnd":80,"languageId":"typescript","content":"..."}
{"kind":"selection","workspaceRelativePath":"src/auth.ts","lineStart":18,"lineEnd":34,"languageId":"typescript","content":"..."}
{"kind":"diagnostics","workspaceRelativePath":"src/auth.ts","lineStart":18,"lineEnd":34,"severity":"mixed","content":"ERROR L20: ...\nWARNING L30: ..."}
</pi-vscode-context-v1>
```

Serialization rules:

- Preserve visible chip order exactly.
- Normalize all captured text to LF.
- Remove NUL and replace other control characters except TAB/LF with `�` before serialization.
- Serialize each item as a single canonical JSON line with fields in this order: `kind`, `workspaceRelativePath`, `lineStart`, `lineEnd`, `severity` when present, `languageId` when present, `content`.
- Use workspace-relative paths only; do not serialize absolute paths.
- Bound file/selection snapshots to at most 200 lines or 16,000 characters per chip, diagnostics to at most 100 issues or 8,000 characters per chip, and the total serialized envelope to at most 32,000 characters. If a cap is exceeded, require the user to narrow or remove the chip before send.
- If there are no non-image chips, omit the envelope entirely.
- If there is at least one non-image chip, append the envelope to the draft as:
  - `rpcMessage = draft + "\n\n" + envelope` when `draft` is non-empty
  - `rpcMessage = envelope` when `draft` is empty

Exact RPC request shapes:

- Idle `Send`:

```json
{
  "command": "prompt",
  "message": "<draft plus optional envelope>",
  "images": [{ "type": "image", "data": "<base64>", "mimeType": "image/png" }]
}
```

- Busy `Send next`:

```json
{
  "command": "follow_up",
  "message": "<draft plus optional envelope>",
  "images": [{ "type": "image", "data": "<base64>", "mimeType": "image/png" }]
}
```

- Advanced `Steer`:

```json
{
  "command": "steer",
  "message": "<draft plus optional envelope>",
  "images": [{ "type": "image", "data": "<base64>", "mimeType": "image/png" }]
}
```

- When there are no pending images, omit `images` entirely rather than inventing placeholders.

- Do not invent a separate RPC `context`, `attachments`, or non-image `images` payload.
- Simple Mode does not use `prompt.streamingBehavior`; command choice alone defines `prompt` vs `follow_up` vs `steer`.

Preview rules:

- Any send with one or more pending chips opens a preflight preview.
- The preview must show the exact final `rpcMessage` text, including the literal serialized envelope, plus the exact image list and image count that will populate RPC `images`.
- Accepting the preview is the only transition that may create an `acceptedSendSnapshot` and clear the editable pending chips/images for the next message.
- Cancelling the preview returns to the composer with draft, chips, images, and focus unchanged.

### Invalidation, persistence, trust, and restart behavior

- Persist draft, focus, and only safe `persistedRef` metadata for `activeFile`, `pickedFile`, `selection`, and `diagnostics` chips.
- Never persist `sanitizedContent`, full file snapshots, diagnostic bodies, or base64 image data across VS Code restart.
- On restore, re-resolve persisted refs only inside the same workspace folder and current trust mode; if re-resolution fails or content fingerprint/range is no longer valid, mark the chip stale and require the user to refresh or remove it before send.
- In-memory images survive `New Chat` confirmation cancel/return and normal session switching back to the originating session, but they are dropped on VS Code restart and on workspace removal.
- File, selection, and diagnostics chips become stale on file delete/move, file content change outside the captured bounds, diagnostic refresh that changes the captured range/severity set, workspace trust downgrade, session replacement into another workspace, or explicit clear/remove.
- Stale chips remain visible with an `Expired` state, cannot be sent, and must never be silently reserialized from old content.

### Accepted-send snapshot and recovery

State transitions:

| From              | Event                                                        | To                                          | Rule                                                                                                                                                           |
| ----------------- | ------------------------------------------------------------ | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| editable          | `Send` / `Send next` / `Steer` with valid draft/chips/images | preview                                     | build exact `rpcMessage` and `rpcImages`, but do not mutate editable state yet                                                                                 |
| preview           | `Cancel`                                                     | editable                                    | restore focus to the preview trigger; no data changes                                                                                                          |
| preview           | `Accept`                                                     | accepted snapshot + fresh editable composer | freeze `draft`, `contextItems`, `imageItems`, `serializedContextEnvelope`, `rpcMessage`, and `rpcImages`; send once                                            |
| accepted snapshot | RPC ack + streaming                                          | accepted snapshot                           | snapshot stays immutable; completion is still pending                                                                                                          |
| accepted snapshot | `agent_settled`                                              | editable only                               | drop snapshot; transcript becomes the source of truth                                                                                                          |
| accepted snapshot | transport/session failure before `agent_settled`             | failed snapshot                             | keep snapshot for explicit recovery; never auto-resend                                                                                                         |
| failed snapshot   | `Copy to composer`                                           | editable                                    | restore original draft text, restore still-valid context refs as chips, restore in-memory images if still present, otherwise add `Reselect image` placeholders |
| failed snapshot   | `Send again`                                                 | preview                                     | rebuild preview from reconstructed editable state; never send immediately                                                                                      |

`Copy to composer` rules:

- It never sends RPC traffic.
- It reconstructs the user draft as draft text and reconstructs still-valid local context as chips, not as pasted envelope prose.
- If an image still exists in memory for the originating workspace/session, restore it as an image chip.
- If an image byte payload is no longer available, show `Reselect image: <name>` and require explicit user reselection before the next send.
- Expired local refs stay excluded from the reconstructed send until the user refreshes or removes them.

### Recovery semantics

- Simple Mode does **not** use a generic `Retry` label. Recovery actions are named for the actual behavior.

| Error class                                  | Primary action                      | System behavior                                                           | Draft / resend rule                                                                                                                                                 |
| -------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pi process failed to start before ready      | `Start again`                       | Retry process start in the same workspace                                 | Do not auto-create a session or auto-send; draft/chips/images stay unchanged                                                                                        |
| Pi disconnected or crashed after ready       | `Restart Pi`                        | Restart Pi, refresh state, and reconcile transcript/session data          | Never auto-resend an uncertain prompt                                                                                                                               |
| Prompt failed after Pi accepted it           | `Copy to composer` and `Send again` | Keep last confirmed transcript visible; offer explicit user recovery only | Restore the draft, restore still-valid context refs as chips, require reselection for expired images, and mark the recovery state `Not resent`; no automatic resend |
| Send rejected in preflight before acceptance | return to composer                  | Show inline error and leave the composer editable                         | Draft/chips/images return unchanged                                                                                                                                 |

## Current visible element inventory — keep / move / hide / remove

| Current visible element                                                                                       | Disposition                           | Future location / behavior                                               |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------ |
| Activity Bar container `Pi RPC`                                                                               | **Keep**                              | Same container                                                           |
| View: `Start & Sessions`                                                                                      | **Move**                              | Split across `New Chat`, `Resume Chat`, `Current Chat`                   |
| View: `Help & Walkthrough`                                                                                    | **Remove** as top-level view          | Move help text into empty states and Advanced > Help                     |
| View: `Conversation & Branches`                                                                               | **Hide** from Simple                  | Advanced > Session & Branches                                            |
| View: `Queues`                                                                                                | **Hide** from Simple                  | Advanced > Queue & steering                                              |
| View: `Workflow`                                                                                              | **Hide** from Simple                  | Advanced > Commands & tools                                              |
| View: `Advanced & Diagnostics`                                                                                | **Hide** from Simple                  | Advanced > Diagnostics & developer                                       |
| Outline intro `Conversation map`                                                                              | **Move**                              | Advanced > Session & Branches                                            |
| Outline entry rows (`User message`, `Assistant reply`, `Tool result`, `Branch summary`, `Saved branch label`) | **Move**                              | Advanced > Session & Branches                                            |
| Queue empty item `No active queue` / `No queued notes`                                                        | **Move**                              | Advanced > Queue & steering                                              |
| Queue item rows (`Steering note`, `Follow-up note`)                                                           | **Move**                              | Advanced > Queue & steering                                              |
| Workflow command rows (`Run /...`)                                                                            | **Move**                              | Advanced > Commands & tools                                              |
| Workflow tool rows                                                                                            | **Move**                              | Advanced > Commands & tools                                              |
| Diagnostics empty item (`No diagnostics yet`, `Everything looks healthy.`)                                    | **Move**                              | Advanced > Diagnostics                                                   |
| Diagnostics item rows                                                                                         | **Move**                              | Advanced > Diagnostics                                                   |
| Quick Start section                                                                                           | **Move**                              | New Chat / Resume Chat / Current Chat                                    |
| Choose Workspace action                                                                                       | **Hide** by default                   | Show only for multi-root inline picker or Advanced                       |
| Start Pi action                                                                                               | **Hide** by default                   | Auto-run behind New/Resume/Send; keep command + Advanced recovery        |
| New Session action                                                                                            | **Move/Rename**                       | `New Chat`                                                               |
| Resume Session action                                                                                         | **Move/Rename**                       | `Resume Chat`                                                            |
| Open Chat action                                                                                              | **Move**                              | `Current Chat` primary action                                            |
| Current Session section                                                                                       | **Move/Rename**                       | `Current Chat` summary                                                   |
| Current Session empty item `No workspace selected`                                                            | **Move/Rename**                       | `No current chat` empty summary                                          |
| Current Session > Workspace                                                                                   | **Keep**                              | Current Chat summary/header                                              |
| Current Session > Session                                                                                     | **Keep**                              | Current Chat summary/header                                              |
| Current Session > Model                                                                                       | **Keep**                              | Header + model control                                                   |
| Current Session > Status                                                                                      | **Keep**                              | Header summary line                                                      |
| Recent Sessions section                                                                                       | **Move**                              | Resume Chat                                                              |
| Search recent sessions                                                                                        | **Keep**                              | Resume Chat search                                                       |
| Clear session search                                                                                          | **Keep**                              | Resume Chat, only when active                                            |
| Recent sessions loading state                                                                                 | **Keep**                              | Resume Chat                                                              |
| Recent sessions empty state                                                                                   | **Keep**                              | Resume Chat                                                              |
| Recent sessions error state                                                                                   | **Keep**                              | Resume Chat                                                              |
| Recent session list items                                                                                     | **Keep**                              | Resume Chat                                                              |
| First Run Tips / Need a refresher                                                                             | **Remove** as persistent section      | Fold into empty state microcopy + Advanced help                          |
| Help view action: Start Pi                                                                                    | **Hide** from Simple                  | Advanced / Command Palette                                               |
| Help view action: New Session                                                                                 | **Move/Rename**                       | New Chat                                                                 |
| Help view action: Resume Session                                                                              | **Move/Rename**                       | Resume Chat                                                              |
| Help view action: Open Chat                                                                                   | **Move**                              | Current Chat                                                             |
| Help view info: Start Branch                                                                                  | **Move**                              | Advanced > Session & Branches                                            |
| Help view info: Duplicate Path                                                                                | **Move**                              | Advanced > Session & Branches                                            |
| Help view info: Conversation Map                                                                              | **Move**                              | Advanced > Session & Branches                                            |
| Sessions view title: Start Pi                                                                                 | **Hide** from Simple                  | Advanced / Command Palette                                               |
| Sessions view title: New Session                                                                              | **Move/Rename**                       | New Chat                                                                 |
| Sessions view title: Resume Session                                                                           | **Move/Rename**                       | Resume Chat                                                              |
| Sessions view title: Open Chat                                                                                | **Move**                              | Current Chat                                                             |
| Sessions view title: Search Recent Sessions                                                                   | **Move**                              | Resume Chat search                                                       |
| Sessions view title: Refresh Recent Sessions                                                                  | **Move**                              | Resume Chat refresh                                                      |
| Outline view title: Show Conversation Map                                                                     | **Move**                              | Advanced > Session & Branches                                            |
| Outline view title: Refresh Entries                                                                           | **Move**                              | Advanced > Session & Branches                                            |
| Diagnostics view title: Show Health                                                                           | **Move**                              | Advanced > Diagnostics                                                   |
| Chat eyebrow `Pi RPC Chat`                                                                                    | **Remove**                            | Unneeded label noise                                                     |
| Chat title                                                                                                    | **Keep**                              | Use session name or `Current Chat`                                       |
| Header meta: Workspace                                                                                        | **Keep**                              | Header summary                                                           |
| Header meta: Session                                                                                          | **Keep**                              | Header summary                                                           |
| Header meta: Model                                                                                            | **Keep**                              | Header summary + control                                                 |
| Header meta: Status                                                                                           | **Keep**                              | Header summary                                                           |
| Header button: Start Pi                                                                                       | **Hide** from Simple                  | Advanced / auto-start                                                    |
| Header button: New Session                                                                                    | **Move/Rename**                       | New Chat / empty-state CTA                                               |
| Header button: Resume Session                                                                                 | **Move/Rename**                       | Resume Chat / empty-state CTA                                            |
| Header button: Refresh                                                                                        | **Hide** from Simple                  | Advanced > Recovery                                                      |
| Header button: Abort                                                                                          | **Move/Rename**                       | Composer `Stop`                                                          |
| Active workspace select                                                                                       | **Hide** by default                   | Multi-root only                                                          |
| Trusted / Restricted pill                                                                                     | **Keep**                              | Compact banner/chip                                                      |
| Waiting count pill                                                                                            | **Hide** from Simple                  | Advanced > Queue                                                         |
| Message count pill                                                                                            | **Hide** from Simple                  | Advanced > Stats                                                         |
| Thinking level pill                                                                                           | **Hide** from Simple                  | Advanced > Model & thinking                                              |
| Composer heading `Ask Pi`                                                                                     | **Rename**                            | `Message Pi`                                                             |
| Pending images strip                                                                                          | **Keep**                              | Attachment tray                                                          |
| `No images selected` empty text                                                                               | **Remove**                            | No empty filler text                                                     |
| Above-editor widgets                                                                                          | **Keep** conditionally                | Inline only when RPC sends them                                          |
| Draft textarea                                                                                                | **Keep**                              | Main composer                                                            |
| Below-editor widgets                                                                                          | **Keep** conditionally                | Inline only when RPC sends them                                          |
| Send button                                                                                                   | **Keep**                              | Composer                                                                 |
| Add Steering Note                                                                                             | **Hide** from Simple                  | Advanced > Queue & steering                                              |
| Queue Follow-up                                                                                               | **Remove** as explicit default button | `Send next` while busy; direct command stays in Advanced/Command Palette |
| Pick Images                                                                                                   | **Move**                              | Attach menu                                                              |
| Clear Images                                                                                                  | **Move**                              | Attachment tray/menu                                                     |
| Use Active File                                                                                               | **Move**                              | Attach menu                                                              |
| Pick File                                                                                                     | **Move**                              | Attach menu                                                              |
| Use Selection                                                                                                 | **Move**                              | Attach menu                                                              |
| Use Diagnostics                                                                                               | **Move**                              | Attach menu                                                              |
| Conversation details section                                                                                  | **Keep/Rename**                       | Transcript                                                               |
| Message cards                                                                                                 | **Keep**                              | Transcript                                                               |
| Attachment metadata cards                                                                                     | **Simplify**                          | Compact chips by default; raw metadata in Advanced/details               |
| Attachment open button                                                                                        | **Keep**                              | Attachment chip overflow/action                                          |
| Queues details section                                                                                        | **Hide** from Simple                  | Advanced > Queue & steering                                              |
| Steering Mode button                                                                                          | **Move**                              | Advanced > Queue & steering                                              |
| Follow-up Mode button                                                                                         | **Move**                              | Advanced > Queue & steering                                              |
| Auto Retry button                                                                                             | **Move**                              | Advanced > Queue & steering                                              |
| Abort Retry button                                                                                            | **Move**                              | Advanced > Queue & steering                                              |
| Workflow & Models details section                                                                             | **Split**                             | Model stays simple; rest move to Advanced                                |
| Choose Model button                                                                                           | **Keep**                              | Header model control                                                     |
| Cycle Model button                                                                                            | **Hide** from Simple                  | Advanced > Model                                                         |
| Set Thinking Level button                                                                                     | **Hide** from Simple                  | Advanced > Model & thinking                                              |
| Cycle Thinking button                                                                                         | **Hide** from Simple                  | Advanced > Model & thinking                                              |
| Show Pi Commands button                                                                                       | **Move**                              | Advanced > Commands & tools                                              |
| Compact Conversation button                                                                                   | **Move**                              | Advanced > Context                                                       |
| Auto Compaction button                                                                                        | **Move**                              | Advanced > Context                                                       |
| Session Tools details section                                                                                 | **Hide** from Simple                  | Advanced > Session & Branches                                            |
| Rename Session form                                                                                           | **Move**                              | Advanced > Session                                                       |
| Start Branch button                                                                                           | **Move**                              | Advanced > Session & Branches                                            |
| Duplicate Path button                                                                                         | **Move**                              | Advanced > Session & Branches                                            |
| Branch Starting Points button                                                                                 | **Move**                              | Advanced > Session & Branches                                            |
| Conversation Map button                                                                                       | **Move**                              | Advanced > Session & Branches                                            |
| Refresh Branches button                                                                                       | **Move**                              | Advanced > Session & Branches                                            |
| Status & Widgets details section                                                                              | **Hide** from Simple                  | Advanced > Runtime UI                                                    |
| Keyed status rows                                                                                             | **Move**                              | Advanced > Runtime UI                                                    |
| Set Status demo form                                                                                          | **Remove** from user-facing UI        | Command Palette / developer-only Advanced section                        |
| Widget preview column                                                                                         | **Move**                              | Advanced > Runtime UI                                                    |
| Set Widget demo form                                                                                          | **Remove** from user-facing UI        | Command Palette / developer-only Advanced section                        |
| Advanced details section                                                                                      | **Keep/Rename**                       | Sole `Advanced` drawer                                                   |
| Bash form                                                                                                     | **Move**                              | Advanced > Commands & tools                                              |
| Title form                                                                                                    | **Move**                              | Advanced > Runtime UI / developer                                        |
| Abort Bash                                                                                                    | **Move**                              | Advanced > Commands & tools                                              |
| Session Stats                                                                                                 | **Move**                              | Advanced > Stats                                                         |
| Export HTML                                                                                                   | **Move**                              | Advanced > Export                                                        |
| Copy Last Assistant                                                                                           | **Move**                              | Advanced > Transcript tools                                              |
| RPC Errors                                                                                                    | **Move**                              | Advanced > Diagnostics                                                   |
| Parse Errors                                                                                                  | **Move**                              | Advanced > Diagnostics                                                   |
| Extension Errors                                                                                              | **Move**                              | Advanced > Diagnostics                                                   |
| Compatibility Events                                                                                          | **Move**                              | Advanced > Diagnostics                                                   |
| Health                                                                                                        | **Move**                              | Advanced > Diagnostics                                                   |
| Export Diagnostics                                                                                            | **Move**                              | Advanced > Diagnostics                                                   |
| Extension UI details section                                                                                  | **Remove** as top-level chat section  | Advanced > Developer tools / Command Palette                             |
| Select Dialog preview                                                                                         | **Move**                              | Advanced > Developer tools                                               |
| Confirm Dialog preview                                                                                        | **Move**                              | Advanced > Developer tools                                               |
| Input Dialog preview                                                                                          | **Move**                              | Advanced > Developer tools                                               |
| Editor Dialog preview                                                                                         | **Move**                              | Advanced > Developer tools                                               |
| Notify preview                                                                                                | **Move**                              | Advanced > Developer tools                                               |
| Set Draft preview                                                                                             | **Move**                              | Advanced > Developer tools                                               |
| Inspect Responses                                                                                             | **Move**                              | Advanced > Developer tools                                               |
| Local UI preview buttons                                                                                      | **Move**                              | Advanced > Developer tools                                               |
| Status bar: connection                                                                                        | **Hide** in Simple                    | Show only in Advanced Mode or on error                                   |
| Status bar: model                                                                                             | **Hide** in Simple                    | Show only in Advanced Mode                                               |
| Status bar: queue                                                                                             | **Hide** in Simple                    | Show only in Advanced Mode                                               |
| Status bar: usage                                                                                             | **Hide** in Simple                    | Show only in Advanced Mode                                               |
| Status bar: keyed statuses                                                                                    | **Hide** in Simple                    | Advanced > Runtime UI                                                    |

## Capability preservation map

If a feature leaves Simple Mode, it must stay reachable from **Advanced** and from the **Command Palette** with the current command id.

### Simple Mode promoted commands

- `piRpc.newSession`
- `piRpc.switchSession`
- `piRpcInternal.openChat`
- `piRpc.prompt`
- `piRpc.abort`
- `piRpc.selectModel` / `piRpc.showModels`

### Advanced drawer groups

| Group                        | Commands retained                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session lifecycle            | `piRpcInternal.start`, `piRpcInternal.stop`, `piRpcInternal.restart`, `piRpc.refreshState`, `piRpc.refreshMessages`, `piRpc.renameSession`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Queue & steering             | `piRpc.steer`, `piRpc.followUp`, `piRpc.setSteeringMode`, `piRpc.setFollowUpMode`, `piRpc.toggleAutoRetry`, `piRpc.abortRetry`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Model & thinking             | `piRpc.showModels`, `piRpc.selectModel`, `piRpc.cycleModel`, `piRpc.setThinkingLevel`, `piRpc.cycleThinkingLevel`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Context & compaction         | `piRpc.compact`, `piRpc.toggleAutoCompaction`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Commands & tools             | `piRpc.showPiCommands`, `piRpc.runBash`, `piRpc.abortBash`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Session & branches           | `piRpc.forkSession`, `piRpc.cloneSession`, `piRpc.showForkMessages`, `piRpc.refreshEntries`, `piRpc.showSessionTree`, `piRpc.copyLastAssistant`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Stats & export               | `piRpc.showSessionStats`, `piRpc.exportHtml`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Diagnostics & recovery       | `piRpc.inspectRpcError`, `piRpc.inspectParseError`, `piRpc.inspectAgentStart`, `piRpc.inspectAgentEnd`, `piRpc.inspectAgentSettled`, `piRpc.inspectTurnStart`, `piRpc.inspectTurnEnd`, `piRpc.inspectMessageStart`, `piRpc.inspectMessageUpdate`, `piRpc.inspectMessageEnd`, `piRpc.inspectToolStart`, `piRpc.inspectToolUpdate`, `piRpc.inspectToolEnd`, `piRpc.inspectQueueUpdate`, `piRpc.inspectCompactionStart`, `piRpc.inspectCompactionEnd`, `piRpc.inspectRetryStart`, `piRpc.inspectRetryEnd`, `piRpc.inspectExtensionError`, `piRpc.inspectCompatibilityEvents`, `piRpc.inspectEntryAppended`, `piRpc.inspectSessionInfoChanged`, `piRpc.inspectThinkingChanged`, `piRpcInternal.showHealth`, `piRpcInternal.exportDiagnostics`, `piRpcInternal.openWorktree` |
| Extension UI developer tools | `piRpc.respondExtensionUi`, all `piRpc.extensionUi.*`, all `piRpc.extensionUiLocal.*`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

**Halt check:** no current RPC function becomes inaccessible under this redesign.

## Component inventory and microcopy

| Component                   | Label / microcopy                                                                           | Notes                                                                           |
| --------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Sidebar view                | `New Chat`                                                                                  | plain-language, task-based                                                      |
| Sidebar view                | `Resume Chat`                                                                               | plain-language, task-based                                                      |
| Sidebar view                | `Current Chat`                                                                              | current place, not protocol term                                                |
| Empty transcript            | `No messages yet.`                                                                          | short, not instructional overload                                               |
| Empty state helper          | `Start a new chat, resume a saved chat, or type below.`                                     | supports one-click or direct typing                                             |
| New Chat confirmation title | `New chat`                                                                                  | shown only when a current chat exists                                           |
| New Chat option             | `Start fresh`                                                                               | default choice                                                                  |
| New Chat option             | `Continue from current as parent`                                                           | creates a child chat from confirmed current history only                        |
| New Chat warning            | `Unsent draft and attachments stay in Current Chat. They won't be sent or copied.`          | shown only when draft/chips exist                                               |
| Composer label              | `Message Pi`                                                                                | visible label; not placeholder-only                                             |
| Attach button               | `Attach`                                                                                    | opens one menu for image/file/selection/diagnostics; never inserts hidden prose |
| Attachment tray             | `Attachments for next message`                                                              | hidden when empty                                                               |
| Clear attachments           | `Clear attachments`                                                                         | clears pending chips only                                                       |
| Send button                 | `Send`                                                                                      | idle state                                                                      |
| Busy send button            | `Send next`                                                                                 | clarifies queue behavior                                                        |
| Stop button                 | `Stop`                                                                                      | maps to abort                                                                   |
| Advanced button             | `Advanced`                                                                                  | discoverable without Command Palette                                            |
| Resume empty state          | `No recent chats yet`                                                                       | not “sessions” in primary copy                                                  |
| Resume error                | `Couldn't read recent chats`                                                                | action: `Try again`                                                             |
| Start failure action        | `Start again`                                                                               | Pi never reached ready state                                                    |
| Crash/disconnect action     | `Restart Pi`                                                                                | restart + reconcile                                                             |
| Recovery draft note         | `Draft preserved. Not resent.`                                                              | paired with `Copy to composer` and `Send again`                                 |
| Restricted banner           | `Restricted Mode: chat can read, but changes stay disabled until you trust this workspace.` | explicit safety wording                                                         |
| Multi-root prompt           | `Choose workspace`                                                                          | shown only when needed                                                          |

### Attach menu items

- `Image…`
- `Active file`
- `Pick file…`
- `Current selection`
- `Diagnostics`
- `Clear attachments` _(only when at least one pending chip exists)_

### Advanced drawer sections

- `Session`
- `Branches`
- `Queue & steering`
- `Model & thinking`
- `Commands & tools`
- `Stats & export`
- `Diagnostics`
- `Developer tools`

## Visual, spacing, type, and icon tokens

### Use

- `font-family: var(--vscode-font-family)`
- `color: var(--vscode-foreground)`
- `background: var(--vscode-editor-background)`
- `border/focus: var(--vscode-focusBorder)`, `var(--vscode-panel-border)`
- buttons/inputs from VS Code theme tokens already in use
- codicons / `ThemeIcon` only

### Avoid

- custom fonts from web guidance
- brand color overrides from web guidance
- decorative gradients/glows
- motion-heavy transitions

### Spacing scale

- `4px` micro gap
- `8px` control gap
- `12px` group gap
- `16px` section padding
- `24px` panel separation

### Type hierarchy

- Title: VS Code heading scale, semibold
- Section label: body size, semibold
- Metadata labels: smaller secondary text
- Transcript/body: normal body size
- Code/paths/tool output: `var(--vscode-editor-font-family)`

### Icon set

- New Chat: `add`
- Resume Chat: `history`
- Current Chat: `comment-discussion`
- Attach: `attach`
- Send: `send`
- Stop: `debug-stop` or `primitive-square`
- Advanced: `gear`
- Error: `warning`
- Status/ready: `pulse`

## Keyboard, focus, and accessibility

### Keyboard order

1. Skip link: `Skip to composer`
2. Header model
3. Header advanced
4. Transcript actions if present
5. Composer field
6. Attach
7. Send / Send next
8. Stop when visible

### Focus rules

- `New Chat` / `Resume Chat` success => move focus to composer
- cancelling `New Chat` confirmation => return focus to the current composer
- session switch => restore draft, then focus composer
- closing Advanced => return focus to the trigger
- attach menu close => return focus to `Attach`
- chip preview close => return focus to the originating chip
- stop/error banners never trap focus

### A11y rules

- visible labels on inputs; no placeholder-only controls
- transcript uses `role="log"` with throttled `aria-live="polite"`
- no token-by-token announcements
- icon-only controls require names
- color never carries status alone
- runtime widgets render once only
- attachment chips expose source, scope, size, and remove action to assistive tech
- focus ring uses VS Code token and remains visible at 200% zoom

## Narrow, high-contrast, and reduced-motion behavior

### Narrow widths

- header metadata collapses to two lines max
- model and Advanced sit on a second row if needed
- composer actions stay to one primary row: `Attach`, `Send`, `Stop`
- attachments wrap as chips; no multi-row button grids

### High contrast

- rely on tokenized borders/backgrounds only
- do not encode states with subtle fills alone
- error/warning states include icon + text label

### Reduced motion

- no animated section expansion required for comprehension
- streaming uses text/state changes, not pulse animations
- any spinner has a static text equivalent: `Starting`, `Loading`, `Streaming`

## Usability validation plan

### Participants

- 6 users minimum
- 3 existing VS Code users new to Pi RPC
- 3 current Pi RPC users

### Tasks and measurable success

| Test ID | Task                                                                                                                                | Pass target                                                                                                                                                                                                                                                            | Failure condition                                                                                                                                           |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UT-01   | Start a brand-new chat and send one message                                                                                         | 5/6 succeed, median `<=20s`, `<=3` primary actions, no Command Palette                                                                                                                                                                                                 | asks what “session” means, opens wrong surface, cannot find send                                                                                            |
| UT-02   | Resume a prior chat from the sidebar                                                                                                | 5/6 succeed, median `<=25s`, `<=3` clicks from sidebar                                                                                                                                                                                                                 | resumes wrong chat, cannot tell current vs saved                                                                                                            |
| UT-03   | Send a second message in Current Chat                                                                                               | 6/6 succeed, median `<=10s`, no navigation detour                                                                                                                                                                                                                      | user searches sidebar for message action                                                                                                                    |
| UT-04   | Stop a running reply                                                                                                                | 5/6 succeed, median `<=5s`, one obvious click                                                                                                                                                                                                                          | user cannot distinguish Stop from Advanced                                                                                                                  |
| UT-05   | Attach image/file/selection/diagnostics, explain what will be sent, inspect the exact serialized preview, remove one chip, and send | 5/6 succeed, median `<=25s`; participant correctly predicts source/scope for all chip types, can identify the exact serialized context preview, and removes one chip or clears all without editing prose                                                               | user cannot find `Attach`, cannot explain chip meaning, cannot predict the preview, assumes hidden prose was inserted, or cannot remove the wrong item      |
| UT-06   | Find an advanced feature (branch, diagnostics, or bash) without Command Palette knowledge                                           | 5/6 succeed, median `<=30s`, opens `Advanced` first                                                                                                                                                                                                                    | user concludes feature was removed                                                                                                                          |
| UT-07   | Start a new chat from an active draft and keep the draft safe                                                                       | 5/6 succeed; user chooses `Start fresh` vs `Continue from current as parent` correctly; notices unsent-draft warning; original draft/chips restore exactly on return                                                                                                   | wrong parent behavior chosen, warning missed, draft/chips lost, or focus not restored                                                                       |
| UT-08   | Recover from start failure, crash/disconnect, accepted-prompt failure, and preflight rejection                                      | 5/6 succeed across all four cases; users distinguish `Start again` from `Restart Pi`; no one expects auto-resend; preflight returns unchanged draft/chips/images; `Copy to composer` restores text and still-valid context refs and asks for expired-image reselection | user thinks content was resent automatically, cannot predict recovery result, loses the draft/chips/images, or sees silent image resurrection after restart |

### Inspection and QA checks

| Test ID | Check                                                                                                                                                                                                                                      |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| QA-01   | Count default destinations and default visible chat controls; confirm only `New Chat`, `Resume Chat`, `Current Chat`, header, transcript, composer, `Attach`, `Send`, `Stop`, and model remain in Simple Mode                              |
| QA-02   | Command accessibility audit: every current command id remains reachable through Simple Mode, Advanced, or Command Palette                                                                                                                  |
| QA-03   | Toggle Advanced Mode off/on across reload; confirm persistence and reversibility without capability loss                                                                                                                                   |
| QA-04   | Theme/a11y audit in keyboard-only, screen-reader, 200% zoom, high-contrast, and reduced-motion conditions                                                                                                                                  |
| QA-05   | Packaged VSIX manual review against the updated acceptance plan                                                                                                                                                                            |
| QA-06   | Journey determinism audit: verify `New Chat` confirmation/defaults, attachment chip preview/removal/clear-all/privacy labels, exact serialized context preview, and error-class recovery labels match this spec exactly                    |
| QA-07   | Transport/state audit: verify the exact RPC request shape (`prompt`/`follow_up`/`steer` + message envelope + RPC `images`) and every editable → preview → accepted snapshot → `agent_settled` / failure transition match this spec exactly |

## LOCAL-003 acceptance criteria to validation map

| LOCAL-003 criterion                                                                                                                     | Design answer                                                 | Validation                                             |
| --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------ |
| Default experience exposes only New Chat, Resume Chat, Current Chat, composer, model, attachments, Send, Stop                           | Simple IA + inventory table                                   | **QA-01**, UT-01, UT-03, UT-04, UT-05                  |
| Low-level RPC/event/queue/compatibility controls absent from default sidebar and available through one Advanced area or Command Palette | One Advanced drawer/menu + command preservation map           | **QA-01**, **QA-02**, UT-06                            |
| Sidebar uses no more than three primary destinations and one clear primary action per view                                              | 3-view sidebar                                                | **QA-01**, **QA-06**                                   |
| New users receive an obvious empty state and can start or resume in one click                                                           | empty-state wireframe + CTAs                                  | UT-01, UT-02                                           |
| Chat is dominant surface; session navigation preserves drafts, state, and focus                                                         | transcript-first panel + explicit New Chat/recovery rules     | UT-03, UT-07, UT-08, **QA-06**, **QA-07**              |
| Advanced mode is opt-in, persistent, reversible, and does not alter protocol capability                                                 | mode toggle + persistence rule + capability map               | **QA-02**, **QA-03**, UT-06                            |
| Visual system follows VS Code theme tokens, spacing/type/icon hierarchy, accessible contrast, keyboard nav, reduced motion              | token section + a11y section                                  | **QA-04**                                              |
| User testing scenarios for start, resume, message, stop, attach, advanced discovery pass without Command Palette knowledge              | UT-01..UT-06 plus deterministic New Chat/recovery checks      | UT-01, UT-02, UT-03, UT-04, UT-05, UT-06, UT-07, UT-08 |
| Existing 90/90 RPC coverage remains available and all security/protocol tests pass                                                      | capability preservation map keeps all commands reachable      | **QA-02** + existing coverage/manual suites            |
| VSIX is independently reviewed, installed, and manually testable                                                                        | no new protocol dependency; documentation updates manual plan | **QA-05**                                              |

## Migration plan from current layout

1. **Collapse the default IA**
   - Replace 6 default sidebar views with 3 simple views
   - Remove Help as a permanent destination
2. **Make chat primary**
   - Keep Current Chat open/returnable as the main working surface
   - Remove nonessential header actions
3. **Compress the composer**
   - Replace 9 composer actions with one Attach menu + Send/Stop
4. **Create one Advanced drawer**
   - Move queue, workflow, diagnostics, extension UI, branching, bash, stats, export there
5. **Preserve commands**
   - Keep all existing command ids for coverage and Command Palette muscle memory
6. **Preserve composer state per session**
   - store draft, context chips, in-memory images, focus target, and immutable accepted-send snapshot by session id/path (or workspace draft slot before first session)
   - keep unsent draft/chips/images on the original chat when `New Chat` starts fresh or continues as parent
   - persist only safe refs/metadata for local context and never base64 images across restart
7. **Hide protocol-first status clutter**
   - remove default queue/usage/status bar noise in Simple Mode
8. **Run usability + manual acceptance**
   - execute UT-01..UT-08, then packaged manual acceptance

## Implementation notes

- Prefer evolving the existing `ChatPanelProvider` and sidebar providers instead of adding another major surface.
- Preserve current RPC behavior; this is a **surface redesign**, not a protocol redesign.
- The Advanced drawer should be the only place where queue internals, diagnostics, extension UI preview, and compatibility tooling are visible.
- Multi-root remains supported via on-demand workspace picking, not permanent first-run clutter.
