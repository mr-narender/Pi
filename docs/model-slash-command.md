# GUI `/model`

`/model` opens the existing all-provider model picker for the originating chat.
It selects a session model only; it does not save defaults or open the separate
thinking dialog. Cancelling leaves command text and attachment chips intact.
Accepting clears only the unchanged originating command text, never attachments.

Arguments follow the installed Pi 0.99.1 TUI's `handleModelCommand` policy:
case-insensitive exact canonical `provider/modelId`, then uniquely matching bare
ID, otherwise explicit filtered selection. Canonical references are compared as
whole strings, including provider and model IDs containing `/`. No invented
aliases or automatic fuzzy selection. The entire trimmed remainder is a query;
spaces, quotes and `:high` are not CLI tokens or scope thinking-level syntax.
A model whose actual ID contains a colon can still match exactly.

The GUI adapts `findExactModelReferenceMatch` to the `get_available_models`
wire catalog and uses its existing separator-agnostic fuzzy picker for queries.
Stock RPC does not expose the TUI's scoped catalog or catalog-refresh helper;
this command uses available models, not cycling scope. It uses only existing
`get_available_models`, `set_model` and state refresh operations on both existing
transports. No SDK host migration or new RPC is required. Shared-native/live GUI
verification is separate from mock route and stock-shaped wire verification.

Errors remain local, including empty catalogs and provider setter failures.
Busy steer/follow-up submissions are commands, not model prompts. Chat identity
is checked after asynchronous catalog/picker work. Composer revisions prevent
acknowledgements from overwriting newer drafts or chips. Acknowledgements must
match this webview generation's submission, originating chat and unchanged edit;
unknown or replayed replies cannot advance composer reset/edit bookkeeping, even
in a fresh webview with no pending command. Their model/transcript/status updates
still apply. Ordinary hydration and non-command clears remain supported.
All other 26 core spellings remain reserved and unimplemented.
