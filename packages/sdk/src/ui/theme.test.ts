import { describe, expect, test } from 'bun:test';
import { applyHostReady, applyHostTheme } from './theme.ts';
import type { HostTheme } from '../contract.ts';

const theme: HostTheme = {
  mode: 'light',
  tokens: {
    background: '#fff', elevated: '#fafafa', foreground: '#111', muted: '#666',
    subtle: '#eee', border: '#ddd', hover: '#eee', selection: '#ddf', focus: '#4af',
    primary: '#4af', primaryForeground: '#fff', mutedSurface: '#f4f4f5',
    elevatedForeground: '#111', active: '#e5e5e5', selectionForeground: '#111',
    success: '#16a34a', warning: '#d97706', error: '#dc2626', info: '#2563eb',
    primaryText: '#123456', errorText: '#654321', warningText: '#112233', successText: '#445566', infoText: '#778899',
    font: 'sans-serif', mono: 'monospace', radius: '9px',
  },
};

const captureRoot = () => {
  const seen = new Map<string, string>();
  const root = {
    style: { colorScheme: '', setProperty: (name: string, value: string) => { seen.set(name, value); } },
    dataset: { ocSurface: '', ocTheme: '' },
  };
  return { root, seen };
};

describe('host theme application', () => {
  test('applies computed text separately from fills and updates it on the next snapshot', () => {
    const { root, seen } = captureRoot();
    applyHostTheme(theme, root);
    for (const name of ['primary', 'error', 'warning', 'success', 'info'] as const) {
      expect(seen.get(`--${name}-text`)).toBe(theme.tokens[`${name}Text`]);
      expect(seen.get(`--oc-${name}-text`)).toBe(theme.tokens[`${name}Text`]);
      expect(seen.get(`--oc-${name}`)).toBe(theme.tokens[name]);
    }
    const next = { ...theme, tokens: { ...theme.tokens, primary: '#abcdef', primaryText: '#234567' } };
    applyHostTheme(next, root);
    expect(seen.get('--primary-text')).toBe('#234567');
    expect(seen.get('--oc-primary-text')).toBe('#234567');
    expect(seen.get('--primary')).toBe('#abcdef');
  });

  test('writes host token names and oc aliases, including plain DOM defaults', () => {
    const { root, seen } = captureRoot();
    applyHostTheme(theme, root);
    expect(root.style.colorScheme).toBe('light');
    expect(seen.get('--surface-elevated')).toBe(theme.tokens.elevated);
    expect(seen.get('--oc-elevated')).toBe(theme.tokens.elevated);
    expect(seen.get('--interactive-hover')).toBe(theme.tokens.hover);
    expect(seen.get('--interactive-focus-ring')).toBe(theme.tokens.focus);
    expect(seen.get('--font-sans')).toBe(theme.tokens.font);
    expect(seen.get('--radius')).toBe(theme.tokens.radius);
    expect(seen.get('font-family')).toBe(theme.tokens.font);
    expect(seen.get('color')).toBe(theme.tokens.foreground);
  });

  test('applyHostReady stamps the host surface on the root', () => {
    const { root } = captureRoot();
    applyHostReady({ theme, surface: 'dialog' }, root);
    expect(root.dataset.ocSurface).toBe('dialog');
    expect(root.dataset.ocTheme).toBe('light');
  });
});
