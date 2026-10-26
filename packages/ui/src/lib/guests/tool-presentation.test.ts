import { describe, expect, test } from 'bun:test';
import type { GuestToolContribution } from '@openchamber/sdk';

import { useGuestsStore } from './store.ts';
import {
  compileGuestToolRules,
  guestToolTableRows,
  matchGuestToolRule,
  readPath,
  renderGuestToolHeader,
  renderTemplate,
  resolveGuestToolPresentation,
  stringifyTemplateValue,
} from './tool-presentation.ts';
import type { InstalledGuest } from './types.ts';

const guest = (id: string, tools: GuestToolContribution[], overrides: Partial<InstalledGuest> = {}): InstalledGuest => ({
  id,
  name: id,
  icon: 'window',
  entry: 'panel/index.html',
  capabilities: { requested: [], granted: [] },
  tools,
  ...overrides,
});

describe('matchGuestToolRule', () => {
  const rules = compileGuestToolRules([
    guest('jira', [{ match: 'mcp.jira.*', name: 'Jira' }, { match: 'mcp.jira.search', name: 'Jira search' }]),
    guest('tasks', [{ match: 'mcp.*', name: 'Any MCP' }, { match: 'mcp.jira.search', name: 'Tasks search' }]),
    guest('paused', [{ match: 'mcp.jira.create', name: 'Paused' }], { enabled: false }),
    guest('pending', [{ match: 'mcp.jira.create', name: 'Pending' }], { capabilities: { requested: ['prompt'], granted: [] } }),
  ]);

  test('an exact rule beats a wildcard, and the first extension wins among equals', () => {
    expect(matchGuestToolRule(rules, 'mcp.jira.search')?.name).toBe('Jira search');
    expect(matchGuestToolRule(rules, 'mcp.jira.create')?.name).toBe('Jira');
    expect(matchGuestToolRule(rules, 'mcp.linear.issues')?.name).toBe('Any MCP');
    expect(matchGuestToolRule(rules, 'bash')).toBeNull();
    expect(matchGuestToolRule(rules, 'mcpjira')).toBeNull();
  });

  test('a paused or not fully approved extension contributes nothing', () => {
    expect(rules.map((rule) => rule.guestId)).toEqual(['jira', 'jira', 'tasks', 'tasks']);
    expect(compileGuestToolRules([guest('empty', [])])).toEqual([]);
  });

  test('resolveGuestToolPresentation reads the store and follows a catalog replacement', () => {
    useGuestsStore.setState({ status: 'ready', guests: [], runtimeKey: 'test' });
    expect(resolveGuestToolPresentation('mcp.jira.search')).toBeNull();

    useGuestsStore.getState().replaceCatalog([guest('jira', [{ match: 'mcp.jira.*', icon: 'bug' }])], 'test');
    const first = resolveGuestToolPresentation('mcp.jira.search');
    expect(first?.icon).toBe('bug');
    expect(resolveGuestToolPresentation('mcp.jira.search')).toBe(first);
    expect(resolveGuestToolPresentation('')).toBeNull();

    useGuestsStore.getState().replaceCatalog([], 'test');
    expect(resolveGuestToolPresentation('mcp.jira.search')).toBeNull();
  });
});

describe('readPath', () => {
  const value = { input: { id: 'DEMO-2', items: [{ title: 'first' }], nested: { deep: 0 } }, empty: null };

  test('walks objects and array indexes', () => {
    expect(readPath(value, 'input.id')).toBe('DEMO-2');
    expect(readPath(value, 'input.items.0.title')).toBe('first');
    expect(readPath(value, 'input.nested.deep')).toBe(0);
    expect(readPath(value, '')).toBe(value);
  });

  test('is undefined for a missing step, a non-object step, or a prototype key', () => {
    expect(readPath(value, 'input.missing')).toBeUndefined();
    expect(readPath(value, 'input.id.length')).toBeUndefined();
    expect(readPath(value, 'input.items.x')).toBeUndefined();
    expect(readPath(value, 'input.items.5.title')).toBeUndefined();
    expect(readPath(value, 'empty.x')).toBeUndefined();
    expect(readPath(value, 'constructor')).toBeUndefined();
    expect(readPath(value, '__proto__.polluted')).toBeUndefined();
    expect(readPath('text', 'a')).toBeUndefined();
  });
});

describe('renderTemplate', () => {
  const context = {
    input: { id: 'DEMO-2', count: 3, done: false, tags: ['a', 'b'] },
    output: { total: 12 },
    metadata: undefined,
  };

  test('substitutes the three roots and leaves other braces alone', () => {
    expect(renderTemplate('{input.id} ({output.total})', context)).toBe('DEMO-2 (12)');
    expect(renderTemplate('{input.count}/{input.done}/{input.tags}', context)).toBe('3/false/["a","b"]');
    expect(renderTemplate('{output}', context)).toBe('{"total":12}');
    expect(renderTemplate('{foo.bar} {input.id', context)).toBe('{foo.bar} {input.id');
  });

  test('renders a missing path as an empty string and caps long values', () => {
    expect(renderTemplate('[{metadata.x}] [{input.nope.deeper}]', context)).toBe('[] []');
    const long = renderTemplate('{input.id}', { input: { id: 'x'.repeat(500) }, output: undefined, metadata: undefined });
    expect(long).toHaveLength(200);
    expect(long.endsWith('…')).toBe(true);
    expect(stringifyTemplateValue(null)).toBe('');
    expect(stringifyTemplateValue(1.5)).toBe('1.5');
  });
});

describe('renderGuestToolHeader', () => {
  const rule = compileGuestToolRules([guest('jira', [
    { match: 'x', name: 'Jira', title: '{input.id}', subtitle: '{output.total} results' },
  ])])[0]!;

  test('parses JSON output for the templates and falls back to name for an empty title', () => {
    expect(renderGuestToolHeader(rule, { input: { id: 'J-1' }, output: '{"total": 4}', metadata: undefined }))
      .toEqual({ title: 'J-1', subtitle: '4 results' });
    expect(renderGuestToolHeader(rule, { input: {}, output: 'not json', metadata: undefined }))
      .toEqual({ title: 'Jira', subtitle: 'results' });
    expect(renderGuestToolHeader({ ...rule, name: undefined, title: undefined, subtitle: undefined }, { input: {}, output: undefined, metadata: undefined }))
      .toEqual({ title: null, subtitle: null });
  });
});

describe('guestToolTableRows', () => {
  test('takes the array itself or its items', () => {
    expect(guestToolTableRows([{ id: 1 }])).toEqual([{ id: 1 }]);
    expect(guestToolTableRows({ items: [{ id: 1 }], total: 1 })).toEqual([{ id: 1 }]);
    expect(guestToolTableRows({ rows: [] })).toBeNull();
    expect(guestToolTableRows('text')).toBeNull();
  });
});
