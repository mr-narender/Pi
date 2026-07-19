# Public resource observations

Source files:

- `resources/walkthrough/click.png`
- `resources/walkthrough/chat.png`
- `resources/walkthrough/past.png`
- `resources/walkthrough/welcome.png`
- `resources/AcceptMode.jpg`
- `resources/PlanMode.jpg`
- `resources/HighlightText.jpg`
- `resources/walkthrough/step1.md`
- `resources/walkthrough/step2.md`
- `resources/walkthrough/step3.md`
- `resources/walkthrough/step4.md`

Observed labels and layout:

- `click.png`: orange Claude launcher sits in the editor title area at top right; callout says to click there or press `Ctrl/Cmd+Escape`.
- `chat.png` and `HighlightText.jpg`: Claude can appear as a right-hand editor pane beside the active code editor; empty/right pane shows a large `Claude Code` logo with a bottom composer.
- `past.png`: inside the Claude tab, session history is exposed as a top control labeled `Past conversations`; new conversation entry point is a `+` button at top right, with callout `New conversation tab` and optional `Ctrl/Cmd + N` shortcut.
- `past.png`: tab labels can be generic (`Claude`) or session-titled/truncated (`Accessibility au...`), implying session-aware tab naming after conversation state exists.
- `AcceptMode.jpg`: composer footer includes a compact mode chip labeled `Accept edits`, a current-file chip (`TextEditor.tsx`), and a send arrow button.
- `PlanMode.jpg`: the same composer/footer pattern can switch to a compact mode chip labeled `Plan mode`.
- `welcome.png`: public screenshot shows inline permission review with numbered options (`Yes`, `Yes, and don't ask again`, `No, and tell Claude what to do instead`) plus a comment field, suggesting approval happens inline in the Claude surface rather than only via modal dialogs.

Walkthrough markdown text reinforces:

- `step2.md`: launcher is the orange Claude icon / `Ctrl/Cmd+Escape`.
- `step3.md`: `@` mentions files/folders; editor selection can be asked about directly.
- `step4.md`: `Past Conversations` button and `/resume` both browse prior sessions; `New Chat` starts a fresh conversation.
