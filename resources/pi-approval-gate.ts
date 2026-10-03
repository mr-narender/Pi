/**
 * π Approval Gate (managed by the Pi VS Code extension — piRpc.requireApprovalForEdits)
 *
 * TRUE pre-apply approval: intercepts every file-mutating tool call BEFORE it
 * runs and asks Allow / Allow rest of turn / Deny. Uses Pi's own tool_call
 * hook — the change never touches disk unless you approve it. This is a
 * PROJECT-scoped policy: it applies everywhere π runs for this project
 * (VS Code, terminal, CI) — not just inside the extension.
 *
 * Safe to delete: disabling the setting removes it from .pi/settings.json;
 * re-enabling regenerates this exact file.
 */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

const EDIT_TOOL_NAMES = ['edit', 'write'];
const EDIT_TOOL_SUBSTRINGS = ['edit_file', 'write_file', 'str_replace', 'apply_patch'];

function isFileMutatingTool(name: string | undefined): boolean {
  const lower = (name ?? '').toLowerCase();
  return (
    EDIT_TOOL_NAMES.includes(lower) || EDIT_TOOL_SUBSTRINGS.some((part) => lower.includes(part))
  );
}

function extractPath(input: Record<string, unknown>): string {
  for (const key of ['path', 'file_path', 'filePath']) {
    if (typeof input[key] === 'string') {
      return input[key] as string;
    }
  }
  return 'a file';
}

function extractPreview(input: Record<string, unknown>): string {
  const oldText = (input.oldString ?? input.old_str) as string | undefined;
  const newText = (input.newString ?? input.new_str) as string | undefined;
  if (typeof newText === 'string') {
    const before = typeof oldText === 'string' ? `- ${oldText.split('\n')[0]?.slice(0, 80)}\n` : '';
    const after = newText.split('\n').slice(0, 6).join('\n').slice(0, 400);
    return `${before}+ ${after}`;
  }
  if (typeof input.content === 'string') {
    return input.content.split('\n').slice(0, 6).join('\n').slice(0, 400);
  }
  if (typeof input.appendContent === 'string') {
    return `(appending)\n${input.appendContent.split('\n').slice(0, 4).join('\n').slice(0, 300)}`;
  }
  return '(no preview available)';
}

export default function (pi: ExtensionAPI) {
  // "Allow rest of turn" avoids re-prompting for every file in a multi-file
  // scaffold. Resets on `agent_end` (the whole run finishing), NOT
  // `turn_end` — the SDK's own type definition is explicit that "a turn is
  // ONE assistant response + any tool calls/results", not the whole
  // multi-step task. A model that writes a file then edits it almost always
  // does that as two separate assistant messages (tool call, wait for the
  // result, decide the next step), which is two separate turns — so
  // resetting on turn_end meant "Allow rest of turn" only ever covered a
  // single message's tool calls, re-prompting on the very next one even
  // though nothing new was actually approved. Reported as "keeps asking for
  // permission even when all permissions are allowed".
  let allowRestOfTurn = false;
  pi.on('agent_end', () => {
    allowRestOfTurn = false;
  });

  pi.on('tool_call', async (event, ctx) => {
    if (!isFileMutatingTool(event.toolName)) {
      return undefined;
    }
    if (allowRestOfTurn) {
      return undefined;
    }
    const input = (event.input ?? {}) as Record<string, unknown>;
    const path = extractPath(input);
    if (!ctx.hasUI) {
      return { block: true, reason: `Approval required for ${path}, but no UI is attached.` };
    }
    const prompt = `π wants to change ${path}\n\n${extractPreview(input)}`;
    const choice = await ctx.ui.select(prompt, ['Allow', 'Allow rest of turn', 'Deny']);
    if (choice === 'Allow rest of turn') {
      allowRestOfTurn = true;
      return undefined;
    }
    if (choice !== 'Allow') {
      return { block: true, reason: 'Blocked — change was not approved.' };
    }
    return undefined;
  });
}
