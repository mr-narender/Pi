# LOCAL-004 — Adopt the proven Claude Code VS Code interaction pattern

State: implemented
Agent: pi
Kind: UX architecture redesign

## Acceptance criteria

- [x] Analyze official `anthropic.claude-code` VS Code extension v2.1.215 from observable behavior, public documentation, manifest contributions, settings, commands, menus, views, walkthroughs, and accessibility surfaces.
- [x] Produce an evidence-backed pattern analysis; clearly separate observed facts from inferred behavior and avoid copying proprietary code/assets.
- [x] Define phased implementation and validation plan before changing Pi extension source.
- [x] Sidebar becomes a minimal native session launcher/history surface.
- [x] Chat opens as a stable center editor tab with native VS Code lifecycle and session identity.
- [x] New and resume flows match learned interaction principles while remaining faithful to Pi RPC semantics.
- [x] Existing Pi RPC coverage, security, multi-root behavior, attachments, extension UI, and advanced commands remain available.
- [x] Automated and manual UX comparisons prove the new pattern; independent review passes.
- [x] Updated VSIX is installed for user testing.

## Context

The user rejected assumptions and requested direct analysis of the official Claude Code VS Code extension before planning or implementation.

## Planning links

- [Claude Code pattern analysis](../CLAUDE_CODE_PATTERN_ANALYSIS.md)
- [Editor-tab migration plan](../EDITOR_TAB_MIGRATION_PLAN.md)

## Proof

- Custom editor + stable URI implementation: `src/editorTabs/`
- Per-tab composer persistence + image reselect revival: `src/webview/composerState.ts`
- Manifest/editor-title contributions: `package.json`
- Automated coverage: `test/unit/editor-tabs.test.ts`, `test/extension/suite/index.cjs`, `npm test`
- Packaged artifact: `pi-rpc-vscode-0.0.4.vsix`
