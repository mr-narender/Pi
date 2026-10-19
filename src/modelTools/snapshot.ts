import type { ModelToolsSnapshot, ModelTool } from './types';

const nameValid = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 200 &&
  !/[\u0000-\u001f\u007f]/.test(value);
export function modelToolsSnapshot(
  value: unknown,
  originKey: string,
  requestId: string,
  includeTools = true
): ModelToolsSnapshot {
  if (!value || typeof value !== 'object') throw new Error('MODEL_TOOLS_INVALID_REPLY');
  const data = value as Record<string, unknown>;
  if (
    data.persistence !== undefined &&
    !['after-turn', 'runtime-only'].includes(data.persistence as string)
  )
    throw new Error('MODEL_TOOLS_INVALID_REPLY');
  if (
    data.contract !== 1 ||
    typeof data.revision !== 'string' ||
    !/^[a-f0-9]{64}$/.test(data.revision) ||
    !Array.isArray(data.tools) ||
    data.tools.length > 512 ||
    !Array.isArray(data.active) ||
    data.active.length > 512 ||
    !data.active.every(nameValid) ||
    new Set(data.active).size !== data.active.length
  )
    throw new Error('MODEL_TOOLS_INVALID_REPLY');
  const tools: ModelTool[] = [];
  for (const entry of data.tools) {
    if (!entry || typeof entry !== 'object') throw new Error('MODEL_TOOLS_INVALID_REPLY');
    const tool = entry as Record<string, unknown>;
    if (
      !nameValid(tool.name) ||
      typeof tool.description !== 'string' ||
      tool.description.length > 160 ||
      typeof tool.exposure !== 'string' ||
      !['direct', 'model-only', 'codemode', 'deferred'].includes(tool.exposure) ||
      Object.keys(tool).some((key) => !['name', 'description', 'exposure'].includes(key)) ||
      tools.some((item) => item.name === tool.name)
    )
      throw new Error('MODEL_TOOLS_INVALID_REPLY');
    tools.push({
      name: tool.name,
      description: tool.description,
      exposure: tool.exposure as ModelTool['exposure'],
    });
  }
  if (data.active.some((name) => !tools.some((tool) => tool.name === name)))
    throw new Error('MODEL_TOOLS_INVALID_REPLY');
  if (
    (data.matched !== undefined && typeof data.matched !== 'boolean') ||
    (data.applyFailed !== undefined && data.applyFailed !== true)
  )
    throw new Error('MODEL_TOOLS_INVALID_REPLY');
  return {
    status: data.applyFailed === true ? 'unknown' : 'ready',
    originKey,
    requestId,
    tools: includeTools ? tools : [],
    active: data.active,
    revision: data.revision,
    persistence: data.persistence as ModelToolsSnapshot['persistence'],
    message:
      data.applyFailed === true
        ? 'Pi reported an error while changing tools. Review the current tools before continuing.'
        : data.matched === false
          ? 'Pi kept a different selection. Review the tools currently listed to the model.'
          : undefined,
  };
}
