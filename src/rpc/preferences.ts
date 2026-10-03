export type PreferenceValue = boolean | string | number | null;
export interface PreferenceRow {
  key: string;
  label: string;
  choices: PreferenceValue[] | null;
  global: PreferenceValue;
  project: PreferenceValue;
  effective: PreferenceValue;
  active: PreferenceValue;
  effect: 'live' | 'next-start' | 'model-default';
  source:
    | 'global'
    | 'global-only'
    | 'project'
    | 'startup'
    | 'startup-session-thinking'
    | 'native-default';
}
export interface PreferencesSnapshot {
  revision: string;
  rows: PreferenceRow[];
  terminalOnly: string[];
}
const known: Record<string, readonly PreferenceValue[] | null> = {
  compaction: [false, true],
  retry: [false, true],
  steeringMode: ['all', 'one-at-a-time'],
  followUpMode: ['all', 'one-at-a-time'],
  transport: ['auto', 'sse', 'websocket', 'websocket-cached'],
  httpIdleTimeoutMs: null,
  cacheWarming: ['off', 'streaming', 'idle'],
  imageAutoResize: [false, true],
  blockImages: [false, true],
  enableSkillCommands: [false, true],
  defaultProjectTrust: ['ask', 'always', 'never'],
  enableInstallTelemetry: [false, true],
  anthropicExtraUsage: [false, true],
};
const levels: readonly PreferenceValue[] = [
  null,
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];
export function parsePreferencesSnapshot(input: unknown): PreferencesSnapshot {
  const bad = (): never => {
    throw new Error('Invalid native preference response.');
  };
  if (!input || typeof input !== 'object' || Array.isArray(input)) return bad();
  const d = input as Record<string, unknown>;
  if (
    Object.keys(d).some((k) => !['revision', 'rows', 'terminalOnly', 'models'].includes(k)) ||
    typeof d.revision !== 'string' ||
    !/^[a-f0-9]{64}$/.test(d.revision) ||
    !Array.isArray(d.rows) ||
    !Array.isArray(d.terminalOnly) ||
    d.terminalOnly.some((v) => typeof v !== 'string' || !/^[a-z-]+$/.test(v))
  )
    return bad();
  const seen = new Set<string>();
  const rows = d.rows.map((inputRow): PreferenceRow => {
    if (!inputRow || typeof inputRow !== 'object' || Array.isArray(inputRow)) return bad();
    const r = inputRow as Record<string, unknown>;
    if (
      Object.keys(r).some(
        (k) =>
          ![
            'key',
            'label',
            'choices',
            'global',
            'project',
            'effective',
            'active',
            'effect',
            'source',
          ].includes(k)
      ) ||
      typeof r.key !== 'string' ||
      typeof r.label !== 'string' ||
      r.label.length > 500 ||
      seen.has(r.key)
    )
      return bad();
    seen.add(r.key);
    const modelThinking = r.key.startsWith('modelThinking:') && r.key.length <= 500;
    const choices = modelThinking ? (r.choices as PreferenceValue[]) : known[r.key];
    if (modelThinking) {
      if (
        !Array.isArray(choices) ||
        choices[0] !== null ||
        choices.length < 2 ||
        new Set(choices).size !== choices.length ||
        choices.some((v) => !levels.includes(v))
      )
        return bad();
    } else if (choices === undefined || JSON.stringify(r.choices) !== JSON.stringify(choices))
      return bad();
    for (const k of ['global', 'project', 'effective', 'active']) {
      if (
        r[k] !== null &&
        !(choices
          ? (modelThinking ? levels : choices).includes(r[k] as PreferenceValue)
          : typeof r[k] === 'number' && Number.isSafeInteger(r[k]) && r[k] >= 0)
      )
        return bad();
    }
    if (
      !['live', 'next-start', 'model-default'].includes(String(r.effect)) ||
      ![
        'global',
        'global-only',
        'project',
        'startup',
        'startup-session-thinking',
        'native-default',
      ].includes(String(r.source))
    )
      return bad();
    return {
      key: r.key,
      label: r.label,
      choices: choices ? [...choices] : null,
      global: r.global as PreferenceValue,
      project: r.project as PreferenceValue,
      effective: r.effective as PreferenceValue,
      active: r.active as PreferenceValue,
      effect: r.effect as PreferenceRow['effect'],
      source: r.source as PreferenceRow['source'],
    };
  });
  if (Object.keys(known).some((key) => !seen.has(key))) return bad();
  return { revision: d.revision, rows, terminalOnly: d.terminalOnly as string[] };
}
