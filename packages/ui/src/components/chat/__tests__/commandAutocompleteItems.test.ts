import { describe, expect, test } from 'bun:test';
import { commandMatchesSearch, mergeCommandAutocompleteItems, rankCommandAutocompleteItems } from '../commandAutocompleteItems';

interface Item {
  name: string;
  source: 'openchamber' | 'opencode';
  description?: string;
  searchAliases?: string[];
  isBuiltIn?: boolean;
}

describe('mergeCommandAutocompleteItems', () => {
  test('built-ins win collisions with commands without losing search aliases', () => {
    const builtIn: Item = {
      name: 'summary',
      source: 'openchamber',
      description: 'Summarize this session',
      isBuiltIn: true,
    };
    const command: Item = {
      name: 'summary',
      source: 'opencode',
      description: 'Plugin session digest',
    };

    const merged = mergeCommandAutocompleteItems([builtIn], [command]);

    expect(merged).toEqual([{
      ...builtIn,
      searchAliases: ['Plugin session digest'],
    }]);
    expect(commandMatchesSearch(merged[0], 'plugin digest')).toBe(true);
  });

  test('OpenCode built-ins win collisions with custom commands', () => {
    const custom: Item = { name: 'review', source: 'opencode', description: 'Custom review' };
    const builtIn: Item = {
      name: 'review',
      source: 'opencode',
      description: 'Review workspace changes',
      isBuiltIn: true,
    };

    expect(mergeCommandAutocompleteItems([], [custom, builtIn])).toEqual([{
      ...builtIn,
      searchAliases: ['Custom review'],
    }]);
  });

  test('keeps a case-distinct command when the built-in is disabled', () => {
    const builtIn: Item = { name: 'init', source: 'openchamber', isBuiltIn: true };
    const command: Item = { name: 'Init', source: 'opencode', description: 'Custom init' };
    const merged = mergeCommandAutocompleteItems([builtIn], [command]);

    expect(merged).toEqual([builtIn, command]);
    expect(merged.filter((item) => item.name !== 'init')).toEqual([command]);
  });

  test('keeps first-seen ordering and unrelated commands', () => {
    const builtIns: Item[] = [{ name: 'undo', source: 'openchamber' }];
    const commands: Item[] = [
      { name: 'test', source: 'opencode' },
      { name: 'deploy', source: 'opencode' },
    ];

    const merged = mergeCommandAutocompleteItems(builtIns, commands);

    expect(merged.map((item) => item.name)).toEqual(['undo', 'test', 'deploy']);
    expect(merged[2]).toBe(commands[1]);
  });

  test('deduplicates repeated entries within each source without mutating inputs', () => {
    const first: Item = { name: 'test', source: 'opencode', description: 'First' };
    const duplicate: Item = { name: 'test', source: 'opencode', description: 'Second' };

    expect(mergeCommandAutocompleteItems([], [first, duplicate])).toEqual([{
      ...first,
      searchAliases: ['Second'],
    }]);
    expect(first.searchAliases).toBe(undefined);
  });

  test('handles empty inputs', () => {
    expect(mergeCommandAutocompleteItems([], [])).toEqual([]);
  });
});

describe('rankCommandAutocompleteItems', () => {
  test('places /apply name matches before fuzzy, description, and alias matches', () => {
    const commands: Item[] = [
      { name: 'apple-design', source: 'opencode', description: 'Apply a design' },
      { name: 'review', source: 'opencode', searchAliases: ['apply changes'] },
      { name: 'openspec-apply-change', source: 'opencode' },
      { name: 'opsx-apply', source: 'opencode' },
      { name: 'apply', source: 'opencode' },
      { name: 'draft-notes', source: 'opencode', description: 'Apply notes' },
      { name: 'zebra', source: 'opencode' },
    ];

    expect(rankCommandAutocompleteItems(commands, 'apply').map((command) => command.name)).toEqual([
      'apply',
      'opsx-apply',
      'openspec-apply-change',
      'apple-design',
      'draft-notes',
      'review',
    ]);
  });

  test('keeps alphabetical order when the query is empty', () => {
    const commands: Item[] = [
      { name: 'opsx-apply', source: 'opencode' },
      { name: 'apple-design', source: 'opencode' },
    ];

    expect(rankCommandAutocompleteItems(commands, '').map((command) => command.name)).toEqual([
      'apple-design', 'opsx-apply',
    ]);
  });
});
