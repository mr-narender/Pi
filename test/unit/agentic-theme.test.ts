import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { AGENTIC_THEMES, asAgenticTheme } from '../../src/webview/agenticTheme';

const css = readFileSync('src/webview/media/chat.css', 'utf8');
const colors = (theme: string): Record<string, string> => {
  const section = css.match(new RegExp(`\\[data-agentic-theme='${theme}'\\] \\{([^}]+)\\}`))?.[1];
  assert.ok(section, `missing ${theme} palette`);
  return Object.fromEntries(
    [...section.matchAll(/(--[\w-]+):\s*(#[\da-f]{6});/gi)].map((m) => [m[1]!, m[2]!])
  );
};
const luminance = (hex: string): number => {
  const [r, g, b] = hex
    .slice(1)
    .match(/../g)!
    .map((part) => {
      const value = parseInt(part, 16) / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
  return r! * 0.2126 + g! * 0.7152 + b! * 0.0722;
};
const contrast = (one: string, two: string): number => {
  const a = luminance(one);
  const b = luminance(two);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
};

test('only known Agentic themes are accepted; system stays the default', () => {
  assert.deepEqual(
    AGENTIC_THEMES.map((theme) => theme.value),
    ['system', 'lime-mint', 'orange', 'dark', 'light']
  );
  assert.equal(asAgenticTheme(undefined), 'system');
  assert.equal(asAgenticTheme('bad-theme'), 'system');
  assert.equal(asAgenticTheme('orange'), 'orange');
  const settings = JSON.parse(readFileSync('package.json', 'utf8')) as {
    contributes: { configuration: { properties: Record<string, { default: string }> } };
  };
  assert.equal(
    settings.contributes.configuration.properties['piRpc.agenticTheme']?.default,
    'system'
  );
  assert.match(css, /:not\(\.vscode-high-contrast\):not\(\.vscode-high-contrast-light\)/);
  assert.match(css, /--vscode-menu-background: var\(--vscode-editorWidget-background\)/);
});

test('Agentic palettes retain AA text and non-text/focus contrast', () => {
  for (const { value } of AGENTIC_THEMES.slice(1)) {
    const p = colors(value);
    for (const [fg, bg] of [
      ['--vscode-foreground', '--vscode-editor-background'],
      ['--vscode-descriptionForeground', '--vscode-editorWidget-background'],
      ['--vscode-input-foreground', '--vscode-input-background'],
      ['--vscode-button-foreground', '--vscode-button-background'],
      ['--vscode-button-foreground', '--vscode-button-hoverBackground'],
    ]) {
      assert.ok(contrast(p[fg!]!, p[bg!]!) >= 4.5, `${value}: ${fg} against ${bg}`);
    }
    for (const control of ['--vscode-input-border', '--vscode-focusBorder']) {
      assert.ok(
        contrast(p[control]!, p['--vscode-editorWidget-background']!) >= 3,
        `${value}: ${control}`
      );
    }
  }
});
