// Predictive pre-fetch, zero external dependencies: a small regex-based
// import scanner (JS/TS/Python) we wrote ourselves — NOT graphify or any
// tool that isn't part of a stock Pi + VS Code install. When π opens a file,
// this resolves its LOCAL imports so the follow engine can silently warm
// VS Code's document cache for files π is likely to touch next.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

const JS_TS_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

/** Extract raw import/require specifiers from JS/TS or Python source. Only
 * LOCAL specifiers matter for pre-fetch (bare package names resolve into
 * node_modules/site-packages — nothing useful to warm there). */
export function scanImportSpecifiers(content: string, language: string): string[] {
  const specifiers: string[] = [];
  if (
    ['typescript', 'typescriptreact', 'javascript', 'javascriptreact'].includes(language) ||
    language === ''
  ) {
    const patterns = [
      /\bimport\s+(?:[\s\S]*?\sfrom\s+)?['"]([^'"]+)['"]/g,
      /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
      /\bexport\s+(?:[\s\S]*?\sfrom\s+)?['"]([^'"]+)['"]/g,
    ];
    for (const pattern of patterns) {
      for (const match of content.matchAll(pattern)) {
        if (match[1]) {
          specifiers.push(match[1]);
        }
      }
    }
  }
  if (language === 'python' || language === '') {
    const patterns = [/^\s*from\s+(\.+[\w.]*|\w[\w.]*)\s+import\b/gm, /^\s*import\s+(\w[\w.]*)/gm];
    for (const pattern of patterns) {
      for (const match of content.matchAll(pattern)) {
        if (match[1]) {
          specifiers.push(match[1]);
        }
      }
    }
  }
  return [...new Set(specifiers)];
}

/** Resolve a specifier to a real file on disk relative to the importing file.
 * Bare/package specifiers (no relative or dotted-Python form) are skipped —
 * they live outside the workspace and pre-warming them buys nothing. */
export function resolveLocalImport(
  specifier: string,
  fromFile: string,
  language: string
): string | undefined {
  const fromDir = dirname(fromFile);
  if (language === 'python' || (!specifier.startsWith('.') && !specifier.startsWith('/'))) {
    if (language === 'python') {
      if (!specifier.startsWith('.')) {
        return undefined; // absolute python imports usually resolve outside the workspace
      }
      const relative = specifier.replace(/^\.+/, '').replaceAll('.', '/');
      const base = join(fromDir, relative || '.');
      for (const candidate of [`${base}.py`, join(base, '__init__.py')]) {
        if (existsSync(candidate)) {
          return candidate;
        }
      }
      return undefined;
    }
    return undefined; // bare JS/TS package specifier — node_modules, not ours
  }
  const base = join(fromDir, specifier);
  for (const extension of ['', ...JS_TS_EXTENSIONS]) {
    const candidate = `${base}${extension}`;
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  for (const extension of JS_TS_EXTENSIONS) {
    const candidate = join(base, `index${extension}`);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/** Top N local files this file is likely to lead to next. */
export function predictNextFiles(
  content: string,
  fromFile: string,
  language: string,
  limit = 3
): string[] {
  const resolved: string[] = [];
  for (const specifier of scanImportSpecifiers(content, language)) {
    const path = resolveLocalImport(specifier, fromFile, language);
    if (path && path !== fromFile && !resolved.includes(path)) {
      resolved.push(path);
      if (resolved.length >= limit) {
        break;
      }
    }
  }
  return resolved;
}
