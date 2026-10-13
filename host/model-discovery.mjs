// Shared runtimes coalesce picker requests; Pi owns credential-scoped cache validity.
const pending = new WeakMap();

export async function discoverOpenRouterModels(runtime, offline, timeoutMs = 5000) {
  if (offline || !runtime.getProvider('openrouter') || !runtime.hasConfiguredAuth('openrouter'))
    return;
  if (pending.has(runtime)) return pending.get(runtime);
  const operation = (async () => {
    try {
      const result = await runtime.refresh({
        providers: ['openrouter'],
        allowNetwork: true,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (result.aborted || result.errors.size) return 'MODEL_DISCOVERY_UNAVAILABLE';
    } catch {
      // Never forward native errors containing credentials/endpoints to the UI.
      return 'MODEL_DISCOVERY_UNAVAILABLE';
    }
  })();
  pending.set(runtime, operation);
  try {
    return await operation;
  } finally {
    pending.delete(runtime);
  }
}
