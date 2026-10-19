export interface ModelTool {
  name: string;
  description: string;
  exposure: 'direct' | 'model-only' | 'codemode' | 'deferred';
}

export interface ModelToolsSnapshot {
  status: 'loading' | 'ready' | 'applying' | 'unsupported' | 'unknown' | 'stale';
  originKey: string;
  requestId: string;
  tools: ModelTool[];
  active: string[];
  revision?: string;
  persistence?: 'after-turn' | 'runtime-only';
  message?: string;
}
