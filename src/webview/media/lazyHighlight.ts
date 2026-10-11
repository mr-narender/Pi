import type { HighlightedCode } from '../highlight';
import { optionalModule } from './optionalModules';

let highlight: typeof import('../highlight').highlightCode | undefined;
let loading: Promise<void> | undefined;

export function highlightCode(
  code: string,
  language: string,
  escape: (value: string) => string
): HighlightedCode {
  if (highlight) return highlight(code, language, escape);
  loading ??= optionalModule('Highlight')
    .then((module) => {
      highlight = module.highlightCode;
      document.dispatchEvent(new Event('pi-highlight-ready'));
    })
    .catch(() => {
      loading = undefined;
    });
  return { html: escape(code) };
}
