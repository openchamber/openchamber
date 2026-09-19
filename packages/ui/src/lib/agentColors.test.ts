import { expect, test } from 'bun:test';
import { createAgentColorResolver } from './agentColors';
import { getDefaultTheme, getThemeById } from './theme/themes';
import { chromaticDistance } from './theme/color';
import type { Theme } from '@/types/theme';

const roster = ['architect', 'build', 'plan', 'simplifier'].map((name) => ({ name }));
function colorValue(theme: Theme, token: string) {
  const values = new Map<string, string>(Object.entries(theme.colors.syntax.base).map(([key, value]) => [`--syntax-${key}`, value]));
  values.set('--status-success', theme.colors.status.success);
  const value = values.get(token);
  if (!value) throw new Error(`Missing color ${token}`);
  return value;
}

test('Build keeps success and four visible agents get distinct Monokai colors', () => {
  for (const id of ['monokai-dark', 'monokai-light']) {
    const theme = getThemeById(id);
    if (!theme) throw new Error(`Missing theme ${id}`);
    const resolve = createAgentColorResolver(theme, roster);
    expect(resolve('build')).toEqual({ var: '--status-success', class: 'agent-success' });
    expect(new Set(roster.map(({ name }) => colorValue(theme, resolve(name).var))).size).toBe(4);
    const resolved = roster.map(({ name }) => colorValue(theme, resolve(name).var));
    for (let i = 0; i < resolved.length; i++) {
      for (let j = i + 1; j < resolved.length; j++) {
        expect(chromaticDistance(resolved[i], resolved[j], theme.colors.surface.elevated, theme.colors.surface.background)).toBeGreaterThanOrEqual(0.055);
      }
    }
  }
});

test('aliases, near-duplicates and the Build green do not consume separate palette slots', () => {
  const theme = structuredClone(getDefaultTheme(true));
  Object.assign(theme.colors.syntax.base, {
    keyword: '#e888aa', operator: '#e989ab', type: '#66ccee', number: '#eebb66',
    function: theme.colors.status.success, string: theme.colors.status.success,
  });
  const resolve = createAgentColorResolver(theme, roster);
  const selected = roster.map(({ name }) => colorValue(theme, resolve(name).var));
  expect(new Set(selected).size).toBe(4);
  for (let i = 0; i < selected.length; i++) {
    for (let j = i + 1; j < selected.length; j++) {
      expect(chromaticDistance(selected[i], selected[j], theme.colors.surface.background, theme.colors.surface.background)).toBeGreaterThanOrEqual(0.055);
    }
  }
  for (const { name } of roster.filter(({ name }) => name !== 'build')) {
    expect(resolve(name).var.startsWith('--syntax-')).toBe(true);
    expect(chromaticDistance(colorValue(theme, resolve(name).var), theme.colors.status.success, theme.colors.surface.background, theme.colors.surface.background)).toBeGreaterThanOrEqual(0.055);
  }
});

test('roster order and additional subagents do not change primary assignments', () => {
  const theme = getDefaultTheme(true);
  const first = createAgentColorResolver(theme, roster);
  const reordered = createAgentColorResolver(theme, [...roster].reverse());
  const withSubagent = createAgentColorResolver(theme, [{ name: 'aaa-helper', mode: 'subagent' }, ...roster]);
  for (const { name } of roster) {
    expect(reordered(name)).toEqual(first(name));
    expect(withSubagent(name)).toEqual(first(name));
  }
  expect(first(undefined).var).toBe('--status-success');
  expect(first('removed-agent')).toEqual(first('removed-agent'));
});

test('sparse palettes reuse syntax colors without borrowing new status colors', () => {
  const theme = structuredClone(getDefaultTheme(true));
  for (const key of ['keyword', 'type', 'function', 'number', 'string', 'operator', 'variable'] as const) {
    theme.colors.syntax.base[key] = '#dddddd';
  }
  const agents = Array.from({ length: 50 }, (_, index) => ({ name: `agent-${index}` }));
  const resolve = createAgentColorResolver(theme, agents);
  for (const { name } of agents) {
    expect(resolve(name).var.startsWith('--syntax-')).toBe(true);
    expect(colorValue(theme, resolve(name).var)).toBe('#dddddd');
  }
  expect(resolve('build').var).toBe('--status-success');
});
