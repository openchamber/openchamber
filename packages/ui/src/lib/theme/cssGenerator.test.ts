import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { opaqueColor, withOpacity } from './color';
import { requireTheme } from './definition';
import { CSSVariableGenerator } from './cssGenerator';
import { themes } from './themes';

const originals = new Map<string, PropertyDescriptor | undefined>();
const theme = themes[0];

beforeEach(() => {
  const dom = new Window({ url: 'http://localhost' });
  for (const [name, value] of Object.entries({ window: dom, document: dom.document })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
});

afterEach(() => {
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  originals.clear();
});

const applied = (backgroundOpacity?: number): string => {
  new CSSVariableGenerator().apply(theme, backgroundOpacity);
  return document.getElementById('opencode-theme-variables')?.textContent ?? '';
};

test('opaque windows emit no transparent background or text backdrop rules', () => {
  expect(applied()).not.toContain('--oc-text-backdrop');
  expect(applied(1)).not.toContain('--oc-text-backdrop');
  const opaque = { ...theme, colors: { ...theme.colors, surface: { ...theme.colors.surface, background: withOpacity(theme.colors.surface.background, 1) } } };
  new CSSVariableGenerator().apply(opaque, 1);
  expect(document.getElementById('opencode-theme-variables')?.textContent).not.toContain('--oc-text-backdrop');
});

test('transparent windows change background tokens without changing foreground colors', () => {
  for (const alpha of [0.01, 0.5, 0.9]) {
    const css = applied(alpha);
    const block = css.slice(css.indexOf('@layer base'));
    expect(block).toContain(`--oc-text-backdrop: ${opaqueColor(theme.colors.surface.background)};`);
    expect(block).toContain(`--background: ${withOpacity(theme.colors.surface.background, alpha)};`);
    expect(block).not.toContain('foreground');
    expect(/\bopacity\s*:/.test(block)).toBe(false);
    expect(block).toContain('#root .oc-panel-edge:not([data-edge-floating])');
    expect(block).toContain('#root .oc-glass-popover');
    expect(block).toContain(`#root [data-sidebar-peek] {\n  --sidebar: ${theme.colors.surface.muted};`);
  }
});

test('a new palette replaces transparent rules and an opaque palette removes them', () => {
  applied(0.5);
  expect(applied(0.8).match(/--oc-text-backdrop/g)).toHaveLength(1);
  expect(applied()).not.toContain('--oc-text-backdrop');
  expect(document.querySelectorAll('#opencode-theme-variables')).toHaveLength(1);
});

test('authored CSS-function alpha keeps native backgrounds and text cleanup', () => {
  for (const background of ['hsl(210 50% 20% / 0.4)', 'rgb(10% 20% 30% / 40%)', 'color-mix(in srgb, #123456 40%, transparent)', 'transparent']) {
    const custom = requireTheme({ ...theme, colors: { ...theme.colors, surface: { ...theme.colors.surface, background } } });
    const generator = new CSSVariableGenerator();
    generator.apply(custom);
    expect(document.getElementById('opencode-theme-variables')?.textContent).not.toContain('--oc-text-backdrop');
    generator.apply(custom, 1);
    const css = document.getElementById('opencode-theme-variables')?.textContent ?? '';
    expect(css).toContain(`--oc-text-backdrop: ${opaqueColor(background)};`);
    expect(css).toContain(':root:root.desktop-runtime body');
    expect(css).toContain('#root .oc-panel-edge:not([data-edge-floating])');
  }
});
