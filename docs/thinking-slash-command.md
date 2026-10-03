# `/thinking` (SDK 0.99.1)

Bare `/thinking` opens the existing VS Code QuickPick with the current native
`AgentSession.getAvailableThinkingLevels()` result. A trimmed, case-insensitive
single supported level applies directly. Invalid, multiword, unsupported and
model-suffix arguments are local errors, never prompts or clamped selections.
Both the thinking chip/menu and the model settings flow use this same picker.

The adapter advertises protocol 1, SDK 0.99.1, thinking contract 1 (read and
strictSet). Unknown/stock backends are explicitly unsupported: the GUI does not
assume stock RPC has a capabilities getter. Shared and dedicated SDK adapters
use the same host. Capabilities are read-only; no provider/catalog refresh or
credential DTO is involved. Native no-model semantics return all seven native
levels; this is a no-model fallback, not a claim of model capability. The tested
SDK startup with no available models instead creates its native nonreasoning
`unknown/unknown` sentinel, which offers only off. Nonreasoning
models return only off. Extended levels come from native thinkingLevelMap, not
from the reasoning flag alone.

Selection is bound to the originating chat/model before discovery, serialized
through modelOperations and checked with a native revision at mutation time.
Model/session changes invalidate pending choices, including command-driven ABA
changes. Success clears only owned, unchanged draft text via existing strict
frame-generation acknowledgement; cancel/errors retain text and attachments.

The strict backend validates the actual current native levels before calling
`setThinkingLevel(level, { persist: false })` and returns the effective level.
Native transcript/event/extension behavior is retained; global defaults are not
modified. Shift-Tab continues using native `cycleThinkingLevel()` with its native
wrap and nonreasoning no-op behavior. No keyboard handlers were added.

Limits: live VS Code/provider authentication and production deployment are not
verified. No global-save gesture is added. Automated status is not independent
verification or overall command completion.
