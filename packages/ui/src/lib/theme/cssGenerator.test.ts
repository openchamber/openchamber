import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { withOpacity } from './color';
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
});

test('transparent windows change background tokens without changing foreground colors', () => {
  for (const alpha of [0.01, 0.5, 0.9]) {
    const css = applied(alpha);
    const block = css.slice(css.indexOf('@layer base'));
    expect(block).toContain(`--oc-text-backdrop: ${withOpacity(theme.colors.surface.background, 1)};`);
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
