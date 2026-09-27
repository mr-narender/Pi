// QuickPick orchestration for "Agent Instructions" — separate from
// resourceManager.ts on purpose: extensions/skills/prompts are open-ended
// collections you toggle; these are zero-or-one-per-slot files where the
// useful action is open-to-edit or create, never enable/disable. Same
// native-QuickPick choice as resourceManager.ts for the same reason
// (occasional config action, not moment-to-moment UI, automatically
// theme-correct).
import * as vscode from 'vscode';
import {
  userInstructionSlots,
  projectInstructionSlots,
  type InstructionSlot,
} from './instructionSlots';

function firstWorkspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function labelFor(slot: InstructionSlot): string {
  if (slot.kind === 'appendSystem') {
    return 'Append to System Prompt';
  }
  // Show the actual matched/target filename (AGENTS.md, CLAUDE.md, etc.)
  // rather than a generic label — precedence among 5 accepted names means
  // "which file" is real information, not decoration.
  const name = slot.matchedName ?? 'AGENTS.md';
  return `Agent Instructions (${name})`;
}

function starterContentFor(slot: InstructionSlot): string {
  if (slot.kind === 'appendSystem') {
    const reach =
      slot.scope === 'user'
        ? 'every chat, in every project'
        : 'every chat in this project only';
    return `<!--
  Added to π's default system prompt for ${reach} — this layers ON TOP of
  what π already knows, it does not replace anything.

  Good for: consistent tone/style, constraints that should always apply
  ("always ask before deleting files"), standing preferences.
-->

`;
  }
  const reach = slot.scope === 'user' ? 'you, across every project' : 'this project';
  return `# Instructions

<!-- π reads this whenever it runs in this directory (or below it) —
     conventions, architecture notes, how ${reach} like${slot.scope === 'user' ? '' : 's'} things done. -->

`;
}

async function openOrCreateSlot(slot: InstructionSlot): Promise<void> {
  const uri = vscode.Uri.file(slot.path);
  if (!slot.exists) {
    await vscode.workspace.fs.writeFile(uri, Buffer.from(starterContentFor(slot), 'utf8'));
  }
  await vscode.window.showTextDocument(uri);
}

interface SlotItem extends vscode.QuickPickItem {
  slot: InstructionSlot;
}

export async function showInstructionManager(): Promise<void> {
  const projectRoot = firstWorkspaceRoot();
  const slots: InstructionSlot[] = [
    ...userInstructionSlots(),
    ...(projectRoot ? projectInstructionSlots(projectRoot) : []),
  ];
  const items: SlotItem[] = slots.map((slot) => ({
    label: `${slot.exists ? '$(check)' : '$(add)'} ${labelFor(slot)}`,
    description: slot.scope === 'user' ? 'user — every project' : 'this project',
    detail: slot.exists ? slot.description : `Not created yet. ${slot.description}`,
    slot,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    title: 'π Agent Instructions',
    placeHolder: 'Open to edit, or create a new one — SYSTEM.md (full replace) is intentionally not offered here',
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!picked) {
    return;
  }
  await openOrCreateSlot(picked.slot);
}
