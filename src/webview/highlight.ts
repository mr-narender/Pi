// Syntax highlighting for fenced code blocks. We use highlight.js core with a
// curated set of languages (keeps the webview bundle lean vs. the full build).
// highlight.js escapes its output, so the returned HTML is safe to inject. The
// emitted `hljs-*` token classes are styled in chat.css against VS Code theme
// colors, so highlighting matches the active editor theme.
import hljs from 'highlight.js/lib/core';

import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import go from 'highlight.js/lib/languages/go';
import ini from 'highlight.js/lib/languages/ini';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import kotlin from 'highlight.js/lib/languages/kotlin';
import less from 'highlight.js/lib/languages/less';
import lua from 'highlight.js/lib/languages/lua';
import markdown from 'highlight.js/lib/languages/markdown';
import objectivec from 'highlight.js/lib/languages/objectivec';
import perl from 'highlight.js/lib/languages/perl';
import php from 'highlight.js/lib/languages/php';
import python from 'highlight.js/lib/languages/python';
import ruby from 'highlight.js/lib/languages/ruby';
import rust from 'highlight.js/lib/languages/rust';
import scss from 'highlight.js/lib/languages/scss';
import shell from 'highlight.js/lib/languages/shell';
import sql from 'highlight.js/lib/languages/sql';
import swift from 'highlight.js/lib/languages/swift';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

let registered = false;

function ensureRegistered(): void {
  if (registered) {
    return;
  }
  const langs: Record<string, LanguageFn> = {
    bash,
    c,
    cpp,
    csharp,
    css,
    diff,
    go,
    ini,
    java,
    javascript,
    json,
    kotlin,
    less,
    lua,
    markdown,
    objectivec,
    perl,
    php,
    python,
    ruby,
    rust,
    scss,
    shell,
    sql,
    swift,
    typescript,
    xml,
    yaml,
  };
  for (const [name, fn] of Object.entries(langs)) {
    hljs.registerLanguage(name, fn);
  }
  registered = true;
}

// highlight.js exports LanguageFn but importing the type adds noise; alias here.
type LanguageFn = Parameters<typeof hljs.registerLanguage>[1];

// Common fence aliases -> registered language names.
const ALIASES: Record<string, string> = {
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  py: 'python',
  py3: 'python',
  rb: 'ruby',
  sh: 'bash',
  zsh: 'bash',
  shell: 'shell',
  console: 'shell',
  'c++': 'cpp',
  cc: 'cpp',
  h: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  'c#': 'csharp',
  golang: 'go',
  kt: 'kotlin',
  rs: 'rust',
  yml: 'yaml',
  html: 'xml',
  htm: 'xml',
  svg: 'xml',
  xml: 'xml',
  md: 'markdown',
  markdown: 'markdown',
  'objective-c': 'objectivec',
  objc: 'objectivec',
  toml: 'ini',
  conf: 'ini',
  patch: 'diff',
};

function resolveLanguage(language: string): string | undefined {
  const key = language.trim().toLowerCase();
  if (!key) {
    return undefined;
  }
  const resolved = ALIASES[key] ?? key;
  return hljs.getLanguage(resolved) ? resolved : undefined;
}

export interface HighlightedCode {
  html: string;
  language?: string;
}

/**
 * Highlight a code string. When the fence language is known it is used
 * directly; otherwise auto-detection runs over the registered subset. The
 * returned html is highlight.js output (already escaped) OR, if highlighting
 * fails, the raw code escaped by the caller-provided escaper.
 */
export function highlightCode(
  code: string,
  language: string,
  escape: (value: string) => string
): HighlightedCode {
  ensureRegistered();
  const resolved = resolveLanguage(language);
  try {
    if (resolved) {
      const result = hljs.highlight(code, { language: resolved, ignoreIllegals: true });
      return { html: result.value, language: resolved };
    }
    // No explicit language: only auto-detect for multi-line blocks (single
    // lines are too ambiguous and often mis-detected).
    if (code.includes('\n')) {
      const auto = hljs.highlightAuto(code);
      if (auto.relevance >= 5 && auto.value) {
        return { html: auto.value, language: auto.language };
      }
    }
  } catch {
    // Fall through to plain escaped output on any highlighter error.
  }
  return { html: escape(code) };
}
