import { describe, expect, test } from 'bun:test';

import { applyHostReady, applyHostTheme } from './theme.ts';

describe('applyHostTheme', () => {
  test('writes host token names and oc aliases', () => {
    const seen = new Map<string, string>();
    const root = {
      style: {
        colorScheme: '',
        setProperty: (name: string, value: string) => {
          seen.set(name, value);
        },
      },
    };

    applyHostTheme({
      mode: 'dark',
      tokens: {
        background: '#111',
        elevated: '#1a1a1a',
        foreground: '#eee',
        muted: '#666',
        subtle: '#222',
        border: '#333',
        hover: '#2a2a2a',
        selection: '#334',
        focus: '#4af',
        primary: '#4af',
        font: 'SF Pro Text, sans-serif',
        mutedSurface: '#f4f4f5',
        elevatedForeground: '#111111',
        active: '#e5e5e5',
        selectionForeground: '#111111',
        primaryForeground: '#ffffff',
        success: '#16a34a',
        warning: '#d97706',
        error: '#dc2626',
        info: '#2563eb',
        mono: 'Menlo, monospace',
        radius: '0.5625rem',
      },
    }, root);

    expect(root.style.colorScheme).toBe('dark');
    expect(seen.get('--surface-elevated')).toBe('#1a1a1a');
    expect(seen.get('--interactive-hover')).toBe('#2a2a2a');
    expect(seen.get('--interactive-focus-ring')).toBe('#4af');
    expect(seen.get('--oc-elevated')).toBe('#1a1a1a');
    expect(seen.get('--font-sans')).toBe('SF Pro Text, sans-serif');
    expect(seen.get('--radius')).toBe('0.5625rem');
    // Plain DOM outside the kit inherits the host font and text colour from the root.
    expect(seen.get('font-family')).toBe('SF Pro Text, sans-serif');
    expect(seen.get('color')).toBe('#eee');
  });

  test('applyHostReady stamps the host surface on the root', () => {
    const root = {
      style: {
        colorScheme: '',
        setProperty: () => {},
      },
      dataset: { ocSurface: '', ocTheme: '' },
    };
    applyHostReady({
      theme: {
        mode: 'light',
        tokens: {
          background: '#fff',
          elevated: '#fafafa',
          foreground: '#111',
          muted: '#666',
          subtle: '#eee',
          border: '#ddd',
          hover: '#eee',
          selection: '#ddf',
          focus: '#4af',
          primary: '#4af',
          font: 'SF Pro Text, sans-serif',
          mutedSurface: '#f4f4f5',
          elevatedForeground: '#111111',
          active: '#e5e5e5',
          selectionForeground: '#111111',
          primaryForeground: '#ffffff',
          success: '#16a34a',
          warning: '#d97706',
          error: '#dc2626',
          info: '#2563eb',
          mono: 'Menlo, monospace',
          radius: '0.5625rem',
        },
      },
      surface: 'dialog',
    }, root);
    expect(root.dataset.ocSurface).toBe('dialog');
    expect(root.dataset.ocTheme).toBe('light');
  });
});
