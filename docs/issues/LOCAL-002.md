# LOCAL-002 — Make Pi RPC session navigation intuitive

State: closed
Agent: pi
Kind: UX enhancement
Closed with: `fc2f698`

## Acceptance criteria

- [x] Activity Bar/sidebar clearly separates Start, New Session, Resume Session, Current Session, Recent Sessions, and Help.
- [x] A first-time user can identify how to start or resume without using the Command Palette.
- [x] Recent sessions show name, workspace, model, relative time, active/current marker, and useful empty/loading/error states.
- [x] Selecting a prior session resumes it safely; new-session behavior is explicit and confirms destructive context changes when needed.
- [x] Chat header and status explain current workspace/session/model/state and provide primary actions.
- [x] Session tree/branch/fork/clone controls use understandable labels and progressive disclosure.
- [x] Keyboard navigation, screen-reader labels, focus order, contrast, and narrow sidebar layouts are tested.
- [x] README and manual acceptance documentation include a visual session workflow.
- [x] Unit, integration, Extension Host, package, install, and independent UX review pass.

## Context

User testing found the initial sidebar confusing, especially locating start/new/resume and following sessions.

## Closure notes

Implemented a new Start & Sessions information architecture, a read-only recent-session index sourced from Pi session files/header metadata, a first-run help view, safer resume/new-session flows, clearer branch terminology, and updated chat header/actions. Verified with unit, integration, extension host, package, and isolated VSIX install smoke. VSIX `0.0.2` was installed locally for continued user testing.
