import { createHash } from 'node:crypto';
import { redactMcpStatus } from './mcp-status.mjs';

const exposures = new Set(['direct', 'model-only', 'codemode', 'deferred']);
const nameValid = (value) =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 200 &&
  !/[\u0000-\u001f\u007f]/.test(value);
export const supportsModelTools = (session) =>
  ['getAllTools', 'getActiveToolNames', 'setActiveToolsByName'].every(
    (name) => typeof session[name] === 'function'
  );

/** Only the public, already filtered registry is observed. This is a model loadout, not permissions. */
export function readModelTools(session) {
  if (!supportsModelTools(session)) throw new Error('MODEL_TOOLS_UNSUPPORTED');
  const definitions = session.getAllTools();
  const active = session.getActiveToolNames();
  if (
    !Array.isArray(definitions) ||
    definitions.length > 512 ||
    !Array.isArray(active) ||
    active.length > 512 ||
    active.some((name) => !nameValid(name)) ||
    new Set(active).size !== active.length
  )
    throw new Error('MODEL_TOOLS_INVALID_CATALOG');
  const names = new Set();
  for (const tool of definitions) {
    if (
      !tool ||
      !nameValid(tool.name) ||
      names.has(tool.name) ||
      ![...exposures, 'hidden'].includes(tool.exposure ?? 'direct') ||
      typeof tool.description !== 'string'
    )
      throw new Error('MODEL_TOOLS_INVALID_CATALOG');
    names.add(tool.name);
  }
  const tools = definitions
    .filter((tool) => exposures.has(tool.exposure ?? 'direct'))
    .map((tool) => ({
      name: tool.name,
      description: redactMcpStatus(tool.description).slice(0, 160),
      exposure: tool.exposure ?? 'direct',
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (active.some((name) => !tools.some((tool) => tool.name === name)))
    throw new Error('MODEL_TOOLS_INVALID_CATALOG');
  const encoded = JSON.stringify([
    definitions.slice().sort((a, b) => a.name.localeCompare(b.name)),
    active.slice().sort(),
  ]);
  if (Buffer.byteLength(encoded) > 2 * 1024 * 1024) throw new Error('MODEL_TOOLS_INVALID_CATALOG');
  return {
    contract: 1,
    tools,
    active: [...active],
    revision: createHash('sha256').update(encoded).digest('hex'),
  };
}

export function setModelTools(session, revision, names) {
  const current = readModelTools(session);
  if (revision !== current.revision) throw new Error('MODEL_TOOLS_STALE_CATALOG');
  if (
    !Array.isArray(names) ||
    names.length > 512 ||
    names.some((name) => !nameValid(name)) ||
    new Set(names).size !== names.length ||
    names.some((name) => !current.tools.some((tool) => tool.name === name))
  )
    throw new Error('MODEL_TOOLS_INVALID_SELECTION');
  let applyFailed = false;
  try {
    session.setActiveToolsByName([...names]);
  } catch {
    applyFailed = true;
  } // The public setter may already have changed the active set.
  const result = readModelTools(session);
  const actual = result.active.slice().sort();
  const requested = names.slice().sort();
  return {
    ...result,
    matched:
      actual.length === requested.length &&
      actual.every((name, index) => name === requested[index]),
    ...(applyFailed ? { applyFailed: true } : {}),
  };
}
