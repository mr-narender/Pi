// Map a Markdown fence language (```ts) to a VS Code languageId so a new file
// opened from a code block gets correct syntax highlighting. Unknown but
// plausible ids pass through; generic/empty labels map to undefined (plaintext).

const ALIASES: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescriptreact',
  js: 'javascript',
  jsx: 'javascriptreact',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  sh: 'shellscript',
  bash: 'shellscript',
  zsh: 'shellscript',
  shell: 'shellscript',
  yml: 'yaml',
  md: 'markdown',
  markdown: 'markdown',
  'c++': 'cpp',
  cxx: 'cpp',
  cc: 'cpp',
  h: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  kt: 'kotlin',
  'objective-c': 'objective-c',
  objc: 'objective-c',
  ps1: 'powershell',
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  jsonc: 'jsonc',
};

const GENERIC = new Set([
  '',
  'text',
  'txt',
  'plain',
  'plaintext',
  'code',
  'output',
  'log',
  'console',
]);

export function vscodeLanguageId(fence?: string): string | undefined {
  if (!fence) {
    return undefined;
  }
  const key = fence.trim().toLowerCase();
  if (GENERIC.has(key)) {
    return undefined;
  }
  return ALIASES[key] ?? key;
}
