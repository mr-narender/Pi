# Agentic-only hard cut

Task: LOCAL-pi-agentic-only-hard-cut-20261003.

## Discovery

The task worktree was created with Worktrunk. Its initial local `main` base was
stale; no changes were made there. The clean task branch was reset to freshly
fetched `origin/main` and verified at
`8354d53a87c26df6e4640f752a858f656a1c95f4` before discovery was restarted.
Earlier source observations from the stale tip are discarded.

Read ancestor AGENTS instructions, their four referenced workspace documents,
repository CLAUDE.md, and graphify-out/GRAPH_REPORT.md. The graph is stale at
`b3fc3386`; current import/caller searches supply the dependency evidence.
History includes the existing Agentic menu, composer shortcut and deferred-empty
reply fixes, which remain preservation requirements.

## Caller classification

- Legacy-only: `src/webview/provider.ts` (`ChatPanelProvider`). Production caller
  is extension.ts; it supplies only `editorTabs.enabled=false` panel fallbacks.
  Mixed tests instantiate its prototype alongside ChatTabManager; delete those
  legacy route cases while preserving the Agentic cases.
- Legacy-only: `src/ui/sidebar/sessionsWebview.ts` and `state.ts`. Only
  extension.ts constructs the unused sessions provider; the contributed view is
  already `piRpc.chat`, not `piRpc.sessions`. Remove dead refresh calls and the
  sidebar-state tests.
- Shared: AgenticChatListHost -> ChatTabManager -> webview model, messages,
  composerState, render, html, chat.ts and chat.css. These are Agentic's existing
  chat renderer and composer, not deletable legacy UI. They preserve drafts,
  image chips, IME, held Enter, slash activation, six animations and deferred
  assistant replies.
- Shared: editorTabs provider/document/cache/filesystem/registry and current
  short URI identity contract. Agentic opens native editor chats through them.
- Compatibility-only: uri.ts fallback decoders for obsolete path/query formats;
  uriContract builders/parsers have no other production callers. Remove these
  aliases and their obsolete serialization tests; retain current short-id map,
  canonical target/session identity and native tab behavior.
- Shared, simplify: `editorTabs.enabled` gates Agentic native paths against the
  legacy provider. Remove the setting and fallback branches; keep native paths.
- Shared, characterize then simplify: `sidebarMode` chooses Agentic list versus
  the same shared full-chat SidebarChatHost. Keep both required surfaces and
  session visibility safety, replace the legacy interface setting/toggle with
  direct Agentic sidebar conversation/chat-list routing. Store the chosen surface in
  workspace state to preserve reload behavior; new workspaces start at the list.
- Legacy-only: dead simple/advanced UI state and unused display attribute; its
  public command/setting were removed previously. Retain actual shared chat
  rendering behavior rather than an obsolete mode tag.
- Retain: session controllers, lifecycle/owned operation guards, command modules,
  RPC transport and `source:"rpc"`, extension UI broker and remote integration.
  Native 27 command reservations and concrete command fixtures remain guarded.
- Package/docs/tests: remove only legacy contributions/settings/menus, obsolete
  aliases and legacy-host assertions; keep README/NOTICE/license and native
  packaging intact. Historical changelog entries remain historical evidence;
  current instructions must describe Agentic alone.

## Characterization

Initial host Pi was 1.0.1; fixtures explicitly support 0.99.1/0.99.2/1.0.0. The
initial unit run passed 553 and failed 12 due to unsupported CLI discovery.
Install isolated public Pi 1.0.0 at `/tmp/pi-agentic-characterization-sdk`, leaving
the user's global installation untouched. With its bin directory prepended to
PATH, before-deletion unit characterization is GREEN: 565 tests, 565 passed,
zero failures/skips. Before integration: 345 passed, zero failed, one optional
archived external workflow-discovery skip (346 tests). After deletion: 551 unit
passed, 268 integration passed, zero failed, the same one optional skip. The
ordered full gate also ran the real Extension Host suite successfully.

The baseline/current maps preserve actual runner names. Repeated names coalesce
in the flat maps: 906 before and 817 after. The explicit regression scope lists
101 unique deleted legacy fixture names (103 executed cases: 26 unit and 77
integration), plus 10 retained tests renamed with exact replacement IDs. Native
command assertions, including lifecycle close/compaction refusal and all 27
CORE_SLASH_NAMES reservations, remain tested. Twelve new test names guard the
hard cut, current URI persistence/rejection, passive status and the real native
surface/broker behavior. They include queued rapid sidebar conversation/chat-list navigation,
failed-close recovery, draft preservation and exact native Extension UI replies.

The removed inspection/extensionUi command IDs had only debugger registration
callers. Agentic's actual ExtensionUiBroker.track/handleRequest and
ChatTabManager.handleRespondUi continue through SessionController and RpcClient;
the corresponding select/confirm/input/editor/notify/response coverage remains.
The no-op LocalExtensionUiContext wrapper was called only by deleted debugger
commands and its own obsolete tests. Its 19 X rows are removed; all 71 actual
wire/state coverage rows remain, with 31 unique contributed action IDs.

Evidence is saved outside build clean directories under the session visualization
directory: local-gate-evidence.json, pi-agentic-before-results.json,
pi-agentic-after-results.json, pi-agentic-baseline-scope-adjustments.json,
pi-hard-cut-red-results.json, pi-hard-cut-green-results.json and
pi-vsix-inspection.json. The gate used the existing public runner with an external
task command map; canonical hooks/manifests were not edited. The one known skip
was explicitly allowed, never reported as zero skips.

## Packaging and limitations

The non-clean build is `node scripts/build.mjs`; `npm run build` would clean.
Ran vendor-pi with the isolated supported SDK and direct vsce packaging. Existing
.vscodeignore deliberately excludes development vendor/ because the published
extension uses managed Pi in globalStorage. The VSIX contains 26 files including
all shared browser/native bundles, host handlers, assets and approval resource;
no source/tests or removed legacy symbols/contributions. README, NOTICE and
license match exactly. CHANGELOG matches after vsce's standard automatic issue
link conversion (31 links); version remains 0.2.20 and the hard cut is Unreleased.

The upstream drift check is pre-existing RED: running the original main script
directly reports `bdd94e753e6d1973 → 631697cd35928fc8`, identically after deletion.
Its baseline, host and script are unchanged; both supported SDK 1.0.0 and global
1.0.1 have that same upstream hash. No drift baseline update is claimed.
`graphify update .` was attempted but the executable/tool is unavailable. The
stale graph is not represented as regenerated. Fresh callers are documented here.

## Acceptance

All 27 command paths, draft/image/IME/Enter safety, immediate slash activation,
Follow Agent default off, six animation choices, deferred empty replies,
sidebar/full-chat/editor tabs and Shift+Tab, session lifecycle and RPC provenance
must remain green. Required delivery includes formatter, lint, both source/test
types, non-clean build, unit/integration and VSIX contents/integrity inspection,
signed agentic_bot task commit, independent review, and PR into main. No release,
main write, force push or fabricated workflow receipts.
