import { describe, expect, test } from 'bun:test';

import type { PermissionRule } from '@/stores/useAgentsStore';

import {
  effectiveEffect,
  modelsEqual,
  parseRules,
  serializeRules,
} from './agentPermissionModel';

const rule = (action: string, resource: string, effect: PermissionRule['effect']): PermissionRule => ({ action, resource, effect });

// Mirrors OpenCode 2.x `Permission.evaluate` + `Wildcard.match`
// (packages/core/src/permission.ts, packages/core/src/util/wildcard.ts): the
// LAST rule whose action and resource patterns both match decides.
const wildcard = (input: string, pattern: string): boolean => {
  let escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  if (escaped.endsWith(' .*')) escaped = `${escaped.slice(0, -3)}( .*)?`;
  return new RegExp(`^${escaped}$`, 's').test(input);
};
const decide = (rules: readonly PermissionRule[], action: string, resource: string): PermissionRule['effect'] => {
  for (let index = rules.length - 1; index >= 0; index -= 1) {
    const entry = rules[index];
    if (wildcard(action, entry.action) && wildcard(resource, entry.resource)) return entry.effect;
  }
  return 'ask';
};

describe('per-tool view of an ordered rule list', () => {
  test('an empty ruleset is an empty model and serializes back to nothing', () => {
    expect(parseRules([])).toEqual({ global: null, keys: {}, source: [] });
    expect(serializeRules(parseRules([]))).toEqual([]);
  });

  test('the agent wildcard, a tool wildcard and its patterns round-trip', () => {
    const rules = [
      rule('*', '*', 'allow'),
      rule('shell', '*', 'ask'),
      rule('shell', 'git status *', 'allow'),
      rule('shell', 'git push *', 'deny'),
    ];
    const model = parseRules(rules);
    expect(model.global).toBe('allow');
    expect(model.keys.shell).toEqual({
      effect: 'ask',
      patterns: [
        { pattern: 'git status *', effect: 'allow' },
        { pattern: 'git push *', effect: 'deny' },
      ],
    });
    expect(serializeRules(model)).toEqual(rules);
  });

  test('stored order is kept as is, even when it makes a pattern inert', () => {
    // The wildcard comes last and wins; the editor must not reorder the list,
    // because order is part of the policy OpenCode evaluates.
    const rules = [rule('shell', 'git push *', 'deny'), rule('shell', '*', 'allow')];
    expect(serializeRules(parseRules(rules))).toEqual(rules);
  });

  test('when a tool has two wildcard rules the last one counts', () => {
    const model = parseRules([rule('edit', '*', 'allow'), rule('edit', '*', 'deny')]);
    expect(model.keys.edit.effect).toBe('deny');
  });

  test('legacy v1 keys are dropped rather than written back', () => {
    const model = parseRules([rule('doom_loop', '*', 'ask'), rule('bash', '*', 'allow'), rule('shell', '*', 'allow')]);
    expect(Object.keys(model.keys)).toEqual(['shell']);
  });

  test('MCP and plugin tools survive as their own rows', () => {
    const model = parseRules([rule('playwright_click', '*', 'ask')]);
    expect(model.keys.playwright_click).toEqual({ effect: 'ask', patterns: [] });
  });

  test('blank patterns are not written', () => {
    const model = parseRules([rule('read', '*', 'allow')]);
    model.keys.read.patterns.push({ pattern: '   ', effect: 'deny' });
    expect(serializeRules(model)).toEqual([rule('read', '*', 'allow')]);
  });

  test('equality compares what would be written, not row objects', () => {
    const a = parseRules([rule('shell', '*', 'ask')]);
    const b = parseRules([rule('shell', '*', 'ask')]);
    b.keys.shell.patterns.push({ pattern: '', effect: 'allow' });
    expect(modelsEqual(a, b)).toBe(true);
  });
});

describe('editing keeps decisions for untouched operations', () => {
  // The review case: a permissive shell pattern before a catch-all `ask`.
  const stored = [
    rule('shell', 'git push *', 'allow'),
    rule('*', '*', 'ask'),
  ];

  test('an unchanged model writes the stored list back verbatim', () => {
    expect(serializeRules(parseRules(stored))).toEqual(stored);
  });

  test('editing only `read` leaves `git push` asking', () => {
    expect(decide(stored, 'shell', 'git push origin')).toBe('ask');
    const model = parseRules(stored);
    model.keys.read = { effect: 'allow', patterns: [] };
    const written = serializeRules(model);
    expect(decide(written, 'shell', 'git push origin')).toBe('ask');
    expect(decide(written, 'read', 'src/index.ts')).toBe('allow');
    expect(written).toEqual([...stored, rule('read', '*', 'allow')]);
  });

  test('changing an effect replaces the rule where it stands', () => {
    const model = parseRules(stored);
    model.global = 'deny';
    expect(serializeRules(model)).toEqual([rule('shell', 'git push *', 'allow'), rule('*', '*', 'deny')]);
  });

  test('rules the view cannot show survive a round trip untouched', () => {
    const rules = [
      rule('*', '*', 'allow'),
      rule('*', 'private/*', 'deny'),
      rule('read', '*', 'allow'),
    ];
    const model = parseRules(rules);
    expect(model.global).toBe('allow');
    expect(model.keys).toEqual({ read: { effect: 'allow', patterns: [] } });
    model.keys.read.effect = 'ask';
    const written = serializeRules(model);
    expect(written).toEqual([rule('*', '*', 'allow'), rule('*', 'private/*', 'deny'), rule('read', '*', 'ask')]);
    expect(decide(written, 'edit', 'private/keys.txt')).toBe('deny');
    expect(decide(written, 'shell', 'private/x')).toBe('deny');
  });

  test('a new agent wildcard goes first so existing tool rules still refine it', () => {
    const rules = [rule('shell', '*', 'deny')];
    const model = parseRules(rules);
    model.global = 'allow';
    const written = serializeRules(model);
    expect(written).toEqual([rule('*', '*', 'allow'), rule('shell', '*', 'deny')]);
    expect(decide(written, 'shell', 'rm -rf /')).toBe('deny');
    expect(decide(written, 'edit', 'a.ts')).toBe('allow');
  });

  test('a new tool wildcard goes before that tool\'s patterns so they keep overriding it', () => {
    const rules = [rule('*', '*', 'allow'), rule('shell', 'git push *', 'deny')];
    const model = parseRules(rules);
    model.keys.shell.effect = 'ask';
    const written = serializeRules(model);
    expect(written).toEqual([rule('*', '*', 'allow'), rule('shell', '*', 'ask'), rule('shell', 'git push *', 'deny')]);
    expect(decide(written, 'shell', 'git push origin')).toBe('deny');
    expect(decide(written, 'shell', 'ls')).toBe('ask');
    expect(decide(written, 'edit', 'a.ts')).toBe('allow');
  });

  test('a new pattern goes last so it wins for what it names', () => {
    const model = parseRules(stored);
    model.keys.shell.patterns.push({ pattern: 'rm *', effect: 'deny' });
    const written = serializeRules(model);
    expect(written).toEqual([...stored, rule('shell', 'rm *', 'deny')]);
    expect(decide(written, 'shell', 'rm -rf tmp')).toBe('deny');
    expect(decide(written, 'shell', 'git push origin')).toBe('ask');
  });

  test('removing a pattern drops only that rule', () => {
    const model = parseRules(stored);
    model.keys.shell.patterns.splice(0, 1);
    expect(serializeRules(model)).toEqual([rule('*', '*', 'ask')]);
  });

  test('duplicate rules for one resource all take the edited effect and stay in place', () => {
    const rules = [rule('edit', '*', 'allow'), rule('*', 'private/*', 'deny'), rule('edit', '*', 'deny')];
    const model = parseRules(rules);
    model.keys.edit.effect = 'ask';
    expect(serializeRules(model)).toEqual([rule('edit', '*', 'ask'), rule('*', 'private/*', 'deny'), rule('edit', '*', 'ask')]);
  });
});

describe('effectiveEffect', () => {
  test('OpenCode defaults allow everything except external directories', () => {
    expect(effectiveEffect('shell', { global: [], agentGlobal: null })).toBe('allow');
    expect(effectiveEffect('external_directory', { global: [], agentGlobal: null })).toBe('ask');
  });

  test('global config rules override the defaults', () => {
    expect(effectiveEffect('shell', { global: [rule('shell', '*', 'deny')], agentGlobal: null })).toBe('deny');
  });

  test("the agent's own wildcard overrides both", () => {
    expect(effectiveEffect('shell', { global: [rule('shell', '*', 'deny')], agentGlobal: 'ask' })).toBe('ask');
  });

  test('pattern rules do not decide the tool-wide answer', () => {
    expect(effectiveEffect('read', { global: [rule('read', '*.env', 'deny')], agentGlobal: null })).toBe('allow');
  });
});
