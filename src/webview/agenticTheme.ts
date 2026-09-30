// Browser-safe list shared by the Agentic webview and its VS Code host.
export const AGENTIC_THEMES = [
  { value: 'system', label: 'Follow VS Code' },
  { value: 'lime-mint', label: 'Lime Mint' },
  { value: 'orange', label: 'Orange' },
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
] as const;

export type AgenticTheme = (typeof AGENTIC_THEMES)[number]['value'];

export function asAgenticTheme(value: unknown): AgenticTheme {
  return AGENTIC_THEMES.find((theme) => theme.value === value)?.value ?? 'system';
}
