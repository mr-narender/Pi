import type { JsonObject } from '../rpc/protocol';
import { CORE_SLASH_NAMES } from './coreSlash';

/** Only genuinely implemented operations are discoverable. Native qualified
 * resource names remain untouched; unqualified builtins have priority. */
export function mergeLocalCommands(resources: JsonObject[]): JsonObject[] {
  const builtin: JsonObject = { name: 'model', description: 'Select a model', source: 'builtin' };
  const scopes: JsonObject = {
    name: 'scoped-models',
    description: 'Choose model cycling scope (session or global default)',
    source: 'builtin',
  };
  return [
    builtin,
    scopes,
    {
      name: 'bug',
      description: 'Review a safe bug ZIP or explicitly upload to Radius',
      source: 'builtin',
    },
    {
      name: 'share',
      description: 'Review and upload current branch to an explicitly selected secret gist',
      source: 'builtin',
    },
    {
      name: 'login',
      description: 'Authenticate with a provider using private GUI prompts',
      source: 'builtin',
    },
    {
      name: 'logout',
      description: 'Remove a stored Pi credential with confirmation',
      source: 'builtin',
    },
    {
      name: 'tree',
      description: 'Navigate the native conversation tree without a paid summary',
      source: 'builtin',
    },
    {
      name: 'trust',
      description: 'Save native project trust for future Pi processes',
      source: 'builtin',
    },
    {
      name: 'reload',
      description: 'Reload native resources in an already-dedicated OS process',
      source: 'builtin',
    },
    { name: 'thinking', description: 'Set session thinking level', source: 'builtin' },
    { name: 'copy', description: 'Copy latest assistant text', source: 'builtin' },
    { name: 'name', description: 'Show or set session name', source: 'builtin' },
    {
      name: 'session',
      description: 'Show session identity and all-branch usage',
      source: 'builtin',
    },
    { name: 'hotkeys', description: 'GUI shortcut help and VS Code bindings', source: 'builtin' },
    { name: 'changelog', description: 'Selected Pi engine changelog', source: 'builtin' },
    {
      name: 'export',
      description: 'Export locally (HTML tree or .jsonl branch)',
      source: 'builtin',
    },
    {
      name: 'compact',
      description:
        'Summarize older context using current provider; original session history remains',
      source: 'builtin',
    },
    { name: 'debug', description: 'Preview safe local diagnostic metrics', source: 'builtin' },
    { name: 'settings', description: 'Edit native engine preferences', source: 'builtin' },
    { name: 'fork', description: 'Fork before a user message in this chat', source: 'builtin' },
    { name: 'clone', description: 'Copy the active branch into this chat', source: 'builtin' },
    { name: 'new', description: 'Replace this chat with a fresh session', source: 'builtin' },
    {
      name: 'import',
      description: 'Validate and copy a local Pi JSONL into this chat',
      source: 'builtin',
    },
    { name: 'resume', description: 'Resume a saved session in this chat', source: 'builtin' },
    { name: 'quit', description: 'Save and close this Pi chat only', source: 'builtin' },
    ...resources.filter(
      (resource) =>
        resource.name !== 'bug' &&
        resource.name !== 'share' &&
        resource.name !== 'login' &&
        resource.name !== 'logout' &&
        resource.name !== 'model' &&
        resource.name !== 'scoped-models' &&
        resource.name !== 'thinking' &&
        resource.name !== 'copy' &&
        resource.name !== 'name' &&
        resource.name !== 'session' &&
        resource.name !== 'hotkeys' &&
        resource.name !== 'changelog' &&
        resource.name !== 'export' &&
        resource.name !== 'compact' &&
        resource.name !== 'debug' &&
        resource.name !== 'settings' &&
        !CORE_SLASH_NAMES.includes(resource.name as (typeof CORE_SLASH_NAMES)[number])
    ),
  ];
}
