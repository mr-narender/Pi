// QuickPick orchestration for the extensions/skills/prompts manager.
// Deliberately native VS Code QuickPick, not a webview — this is occasional,
// deliberate configuration (not moment-to-moment chat UI), and native
// QuickPick is automatically theme-correct, avoiding the whole class of
// "doesn't match the theme" CSS bugs a new webview panel could reintroduce.
import * as vscode from 'vscode';
import * as path from 'node:path';
import {
  canonicalDir,
  agentSkillsSpecUserDir,
  agentSkillsSpecProjectDirs,
} from './resourceLocations';
import { discoverSkills, discoverExtensions, discoverPrompts } from './resourceDiscovery';
import { isResourceExcluded, listPlainEntries, listExcludedPaths } from './resourceSettings';
import { applyResourceChange, readResourceSettingsText } from './resourceManagerFs';
import type {
  DiscoveredResource,
  ResourceKind,
  ResourceScope,
  ResourceState,
  ResourceConfigSnapshot,
} from './resourceTypes';

const KIND_LABEL: Record<ResourceKind, string> = {
  extensions: 'Extensions',
  skills: 'Skills',
  prompts: 'Prompts',
};

const KIND_ICON: Record<ResourceKind, string> = {
  extensions: '$(extensions)',
  skills: '$(symbol-misc)',
  prompts: '$(comment-discussion)',
};

function firstWorkspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

export async function discoverAll(
  kind: ResourceKind,
  projectRoot: string
): Promise<DiscoveredResource[]> {
  const found: DiscoveredResource[] = [];
  if (kind === 'extensions') {
    found.push(...discoverExtensions('user', canonicalDir('extensions', 'user', projectRoot)));
    found.push(
      ...discoverExtensions('project', canonicalDir('extensions', 'project', projectRoot))
    );
  } else if (kind === 'prompts') {
    found.push(...discoverPrompts('user', canonicalDir('prompts', 'user', projectRoot)));
    found.push(...discoverPrompts('project', canonicalDir('prompts', 'project', projectRoot)));
  } else {
    found.push(...discoverSkills('user', canonicalDir('skills', 'user', projectRoot)));
    found.push(...discoverSkills('user', agentSkillsSpecUserDir(), true));
    found.push(...discoverSkills('project', canonicalDir('skills', 'project', projectRoot)));
    for (const dir of agentSkillsSpecProjectDirs(projectRoot)) {
      found.push(...discoverSkills('project', dir, true));
    }
  }
  // De-dup by absolute path — canonical and Agent-Skills-spec locations
  // shouldn't overlap in practice, but never show the same real resource twice.
  const seen = new Set<string>();
  return found.filter((item) =>
    seen.has(item.absolutePath) ? false : (seen.add(item.absolutePath), true)
  );
}

export async function withEnabledState(
  items: DiscoveredResource[],
  projectRoot: string
): Promise<ResourceState[]> {
  const userText = await readResourceSettingsText('user', projectRoot);
  const projectText = await readResourceSettingsText('project', projectRoot);
  return items.map((item) => {
    const text = item.scope === 'user' ? userText : projectText;
    // Paths are stored ABSOLUTE — settings.md documents absolute paths as
    // explicitly supported, which sidesteps computing an agent-dir/.pi-
    // relative form (fragile across platforms/symlinks) for zero downside.
    return { ...item, enabled: !isResourceExcluded(text, item.kind, item.absolutePath) };
  });
}

interface ToggleItem extends vscode.QuickPickItem {
  state: ResourceState;
}

async function showKindPicker(kind: ResourceKind, projectRoot: string): Promise<void> {
  const discovered = await discoverAll(kind, projectRoot);
  const states = await withEnabledState(discovered, projectRoot);
  if (states.length === 0) {
    void vscode.window.showInformationMessage(
      `No ${KIND_LABEL[kind].toLowerCase()} discovered yet. Use "π: Add Custom Extension/Skill/Prompt" to add one, or place one in the standard locations and reopen this.`
    );
    return;
  }
  states.sort((a, b) => a.name.localeCompare(b.name));
  const items: ToggleItem[] = states.map((state) => ({
    label: state.name,
    description: `${state.scope}${state.viaAgentSkillsSpec ? ' · .agents/skills' : ''}`,
    detail: state.description,
    picked: state.enabled,
    state,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    title: `π ${KIND_LABEL[kind]} — check to enable, uncheck to disable`,
    canPickMany: true,
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (picked === undefined) {
    return; // cancelled — no changes
  }
  const pickedPaths = new Set(picked.map((item) => item.state.absolutePath));
  const changes: Array<{ state: ResourceState; nowEnabled: boolean }> = [];
  for (const item of items) {
    const nowEnabled = pickedPaths.has(item.state.absolutePath);
    if (nowEnabled !== item.state.enabled) {
      changes.push({ state: item.state, nowEnabled });
    }
  }
  if (changes.length === 0) {
    return;
  }
  await Promise.all(
    changes.map(({ state, nowEnabled }) =>
      applyResourceChange(
        state.scope,
        projectRoot,
        kind,
        nowEnabled ? 'unexclude' : 'exclude',
        state.absolutePath
      )
    )
  );
  const on = changes.filter((c) => c.nowEnabled).length;
  const off = changes.length - on;
  const parts: string[] = [];
  if (on > 0) {
    parts.push(`${on} enabled`);
  }
  if (off > 0) {
    parts.push(`${off} disabled`);
  }
  void vscode.window.showInformationMessage(`π ${KIND_LABEL[kind]}: ${parts.join(', ')}.`);
}

export async function showResourceManager(): Promise<void> {
  const projectRoot = firstWorkspaceRoot();
  if (!projectRoot) {
    void vscode.window.showWarningMessage('Open a folder to manage project-scoped resources.');
    return;
  }
  interface MenuItem extends vscode.QuickPickItem {
    resourceKind?: ResourceKind;
    action?: 'export' | 'import';
  }
  const items: MenuItem[] = [
    { label: `${KIND_ICON.extensions} Extensions`, resourceKind: 'extensions' },
    { label: `${KIND_ICON.skills} Skills`, resourceKind: 'skills' },
    { label: `${KIND_ICON.prompts} Prompts`, resourceKind: 'prompts' },
    { label: '', kind: vscode.QuickPickItemKind.Separator },
    { label: '$(export) Export configuration…', action: 'export' },
    { label: '$(cloud-download) Import configuration…', action: 'import' },
  ];
  const picked = await vscode.window.showQuickPick(items, {
    title: 'π Extensions, Skills & Prompts',
    placeHolder: 'Choose what to manage',
  });
  if (!picked) {
    return;
  }
  if (picked.action === 'export') {
    return exportConfiguration(projectRoot);
  }
  if (picked.action === 'import') {
    return importConfiguration(projectRoot);
  }
  if (picked.resourceKind) {
    return showKindPicker(picked.resourceKind, projectRoot);
  }
}

export async function addCustomResource(): Promise<void> {
  const projectRoot = firstWorkspaceRoot();
  if (!projectRoot) {
    void vscode.window.showWarningMessage('Open a folder to add a project-scoped resource.');
    return;
  }
  const kindPick = await vscode.window.showQuickPick(
    [
      { label: `${KIND_ICON.extensions} Extension`, resourceKind: 'extensions' as const },
      { label: `${KIND_ICON.skills} Skill`, resourceKind: 'skills' as const },
      { label: `${KIND_ICON.prompts} Prompt`, resourceKind: 'prompts' as const },
    ],
    { title: 'Add a custom…', placeHolder: 'What kind of resource?' }
  );
  if (!kindPick) {
    return;
  }
  const scopePick = await vscode.window.showQuickPick(
    [
      { label: 'This project only', scope: 'project' as const },
      { label: 'Every project (user-level)', scope: 'user' as const },
    ],
    {
      title: `Add a custom ${kindPick.resourceKind.replace(/s$/, '')}`,
      placeHolder: 'Where should it apply?',
    }
  );
  if (!scopePick) {
    return;
  }
  const isSkill = kindPick.resourceKind === 'skills';
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: !isSkill,
    canSelectFolders: isSkill,
    canSelectMany: false,
    openLabel: 'Add',
    title: isSkill
      ? 'Select a skill folder (containing SKILL.md)'
      : `Select a ${kindPick.resourceKind.replace(/s$/, '')} file`,
  });
  const uri = picked?.[0];
  if (!uri) {
    return;
  }
  await applyResourceChange(
    scopePick.scope,
    projectRoot,
    kindPick.resourceKind,
    'include',
    uri.fsPath
  );
  void vscode.window.showInformationMessage(
    `π: added ${path.basename(uri.fsPath)} to ${KIND_LABEL[kindPick.resourceKind].toLowerCase()} (${scopePick.scope}).`
  );
}

const ALL_KINDS: readonly ResourceKind[] = ['extensions', 'skills', 'prompts'];

async function buildSnapshot(projectRoot: string): Promise<ResourceConfigSnapshot> {
  async function forScope(
    scope: ResourceScope
  ): Promise<{ excluded: Record<ResourceKind, string[]>; added: Record<ResourceKind, string[]> }> {
    const text = await readResourceSettingsText(scope, projectRoot);
    const excluded = {} as Record<ResourceKind, string[]>;
    const added = {} as Record<ResourceKind, string[]>;
    for (const kind of ALL_KINDS) {
      excluded[kind] = listExcludedPaths(text, kind);
      added[kind] = listPlainEntries(text, kind);
    }
    return { excluded, added };
  }
  const [user, project] = await Promise.all([forScope('user'), forScope('project')]);
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    excluded: { user: user.excluded, project: project.excluded },
    added: { user: user.added, project: project.added },
  };
}

export async function exportConfiguration(projectRoot?: string): Promise<void> {
  const root = projectRoot ?? firstWorkspaceRoot();
  if (!root) {
    void vscode.window.showWarningMessage('Open a folder to export its resource configuration.');
    return;
  }
  const snapshot = await buildSnapshot(root);
  const target = await vscode.window.showSaveDialog({
    title: 'Export π resource configuration',
    filters: { JSON: ['json'] },
    defaultUri: vscode.Uri.file(path.join(root, 'pi-resources.json')),
  });
  if (!target) {
    return;
  }
  await vscode.workspace.fs.writeFile(
    target,
    Buffer.from(JSON.stringify(snapshot, null, 2) + '\n', 'utf8')
  );
  void vscode.window.showInformationMessage(
    `π: exported resource configuration to ${target.fsPath}.`
  );
}

function isValidSnapshot(value: unknown): value is ResourceConfigSnapshot {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const v = value as Partial<ResourceConfigSnapshot>;
  return v.version === 1 && typeof v.excluded === 'object' && typeof v.added === 'object';
}

export async function importConfiguration(projectRoot?: string): Promise<void> {
  const root = projectRoot ?? firstWorkspaceRoot();
  if (!root) {
    void vscode.window.showWarningMessage(
      'Open a folder to import a resource configuration into it.'
    );
    return;
  }
  const picked = await vscode.window.showOpenDialog({
    title: 'Import π resource configuration',
    filters: { JSON: ['json'] },
    canSelectMany: false,
  });
  const source = picked?.[0];
  if (!source) {
    return;
  }
  let snapshot: ResourceConfigSnapshot;
  try {
    const text = Buffer.from(await vscode.workspace.fs.readFile(source)).toString('utf8');
    const parsed: unknown = JSON.parse(text);
    if (!isValidSnapshot(parsed)) {
      throw new Error('not a recognized π resource configuration file');
    }
    snapshot = parsed;
  } catch (error) {
    void vscode.window.showErrorMessage(
      `π: could not import ${path.basename(source.fsPath)} — ${error instanceof Error ? error.message : String(error)}`
    );
    return;
  }
  const kinds: ResourceKind[] = ['extensions', 'skills', 'prompts'];
  let count = 0;
  for (const scope of ['user', 'project'] as const) {
    for (const kind of kinds) {
      for (const p of snapshot.excluded[scope]?.[kind] ?? []) {
        await applyResourceChange(scope, root, kind, 'exclude', p);
        count++;
      }
      for (const p of snapshot.added[scope]?.[kind] ?? []) {
        await applyResourceChange(scope, root, kind, 'include', p);
        count++;
      }
    }
  }
  void vscode.window.showInformationMessage(
    `π: imported ${count} resource setting${count === 1 ? '' : 's'} from ${path.basename(source.fsPath)}.`
  );
}
