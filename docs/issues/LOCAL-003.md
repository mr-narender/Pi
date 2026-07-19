# LOCAL-003 — Simplify Pi RPC into a user-first interface

State: closed
Agent: pi
Kind: UX redesign

## Acceptance criteria

- [x] Default experience exposes only New Chat, Resume Chat, Current Chat, message composer, model, attachments, Send, and Stop.
- [x] Low-level RPC/event/queue/compatibility controls are absent from the default sidebar and available through a single Advanced area or Command Palette.
- [x] Sidebar uses no more than three primary destinations and one clear primary action per view.
- [x] New users receive an obvious empty state and can start or resume in one click.
- [x] Chat is the dominant surface; session navigation preserves drafts, state, and focus.
- [x] Attachment/chip transport, preview, persistence, invalidation, and recovery follow the deterministic composer/send-snapshot spec in `docs/UX_REDESIGN.md`.
- [x] Advanced mode is opt-in, persistent, reversible, and does not alter protocol capability.
- [x] Visual system follows VS Code theme tokens, consistent spacing/type/icon hierarchy, accessible contrast, keyboard navigation, and reduced motion.
- [x] User testing scenarios for start, resume, message, stop, attach, and advanced discovery pass without Command Palette knowledge.
- [x] Existing 90/90 RPC coverage remains available and all security/protocol tests pass.
- [x] VSIX is independently reviewed, installed, and manually testable.

## Context

User reported that exposing comprehensive RPC controls made the extension confusing and unintuitive. The redesign must optimize for user intent rather than protocol completeness. Attachment and local-context behavior must still remain deterministic and faithful to the actual Pi RPC `message` + `images` protocol.

## Proof

- Sidebar reduced to three default views: `New Chat`, `Resume Chat`, `Current Chat`.
- Chat header/composer reduced to model, New, Resume, More, Attach, Send/Send next, and Stop while streaming.
- Advanced capability preserved behind the persistent `piRpc.toggleAdvancedMode` surface and unchanged command IDs.
- Deterministic context envelope, accepted-send snapshot recovery, per-session draft/chip persistence, and stale ref invalidation implemented in `src/webview/composer.ts`, `src/webview/composerState.ts`, and `src/webview/provider.ts`.
- UX, transport, DOM, CSS accessibility, integration, Extension Host, coverage, and reviewer repro suites pass.
