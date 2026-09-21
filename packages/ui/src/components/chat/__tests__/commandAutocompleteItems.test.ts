import { describe, expect, test } from 'bun:test';
import { commandMatchesSearch, mergeCommandAutocompleteItems } from '../commandAutocompleteItems';

interface Item {
  name: string;
  source: 'openchamber' | 'opencode' | 'skill';
  description?: string;
  searchAliases?: string[];
  isBuiltIn?: boolean;
  isSkill?: boolean;
}

describe('mergeCommandAutocompleteItems', () => {
  test('retains the discovered skill and command search metadata for #1550', () => {
    const commands: Item[] = [{
      name: 'grill-with-docs',
      source: 'opencode',
      description: 'Plugin command description',
      isSkill: true,
    }];
    const skills: Item[] = [{
      name: 'grill-with-docs',
      source: 'skill',
      description: 'Canonical skill description',
      isSkill: true,
    }];

    const merged = mergeCommandAutocompleteItems([], commands, skills);

    expect(merged).toEqual([{
      ...skills[0],
      searchAliases: ['Plugin command description'],
    }]);
    expect(commandMatchesSearch(merged[0], 'plugin command')).toBe(true);
  });

  test('built-ins win collisions with commands and skills without losing search aliases', () => {
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
    const skill: Item = {
      name: 'summary',
      source: 'skill',
      description: 'Skill session recap',
      isSkill: true,
    };

    expect(mergeCommandAutocompleteItems([builtIn], [command], [skill])).toEqual([{
      ...builtIn,
      searchAliases: ['Plugin session digest', 'Skill session recap'],
    }]);
  });

  test('OpenCode built-ins also win collisions with discovered skills', () => {
    const builtIn: Item = {
      name: 'review',
      source: 'opencode',
      description: 'Review workspace changes',
      isBuiltIn: true,
    };
    const skill: Item = {
      name: 'review',
      source: 'skill',
      description: 'Review skill',
      isSkill: true,
    };

    expect(mergeCommandAutocompleteItems([], [builtIn], [skill])).toEqual([{
      ...builtIn,
      searchAliases: ['Review skill'],
    }]);
  });

  test('deduplicates every pairwise source collision by executable precedence', () => {
    const builtIn: Item = { name: 'compact', source: 'openchamber', isBuiltIn: true };
    const command: Item = { name: 'compact', source: 'opencode' };
    const skill: Item = { name: 'compact', source: 'skill', isSkill: true };

    expect(mergeCommandAutocompleteItems([builtIn], [command], [])[0]).toBe(builtIn);
    expect(mergeCommandAutocompleteItems([builtIn], [], [skill])[0]).toBe(builtIn);
    expect(mergeCommandAutocompleteItems([], [command], [skill])[0]).toBe(skill);
  });

  test('OpenCode skill-commands win custom commands and yield to discovered skills', () => {
    const command: Item = { name: 'deploy', source: 'opencode', description: 'Custom deploy' };
    const skillCommand: Item = {
      name: 'deploy',
      source: 'opencode',
      description: 'OpenCode skill command',
      isSkill: true,
    };
    const skill: Item = {
      name: 'deploy',
      source: 'skill',
      description: 'Discovered deploy skill',
      isSkill: true,
    };

    expect(mergeCommandAutocompleteItems([], [command, skillCommand], [])).toEqual([{
      ...skillCommand,
      searchAliases: ['Custom deploy'],
    }]);
    expect(mergeCommandAutocompleteItems([], [command, skillCommand], [skill])).toEqual([{
      ...skill,
      searchAliases: ['OpenCode skill command', 'Custom deploy'],
    }]);
  });

  test('keeps a case-distinct command when the built-in is disabled', () => {
    const builtIn: Item = { name: 'init', source: 'openchamber', isBuiltIn: true };
    const command: Item = { name: 'Init', source: 'opencode', description: 'Custom init' };
    const merged = mergeCommandAutocompleteItems([builtIn], [command], []);

    expect(merged).toEqual([builtIn, command]);
    expect(merged.filter((item) => item.name !== 'init')).toEqual([command]);
  });

  test('keeps first-seen ordering and unrelated commands', () => {
    const builtIns: Item[] = [{ name: 'undo', source: 'openchamber' }];
    const commands: Item[] = [
      { name: 'test', source: 'opencode' },
      { name: 'deploy', source: 'opencode' },
    ];
    const skills: Item[] = [
      { name: 'deploy', source: 'skill', isSkill: true },
      { name: 'explain', source: 'skill', isSkill: true },
    ];

    const merged = mergeCommandAutocompleteItems(builtIns, commands, skills);

    expect(merged.map((item) => item.name)).toEqual(['undo', 'test', 'deploy', 'explain']);
    expect(merged[2]).toBe(skills[0]);
  });

  test('deduplicates repeated entries within each source without mutating inputs', () => {
    const first: Item = { name: 'test', source: 'opencode', description: 'First' };
    const duplicate: Item = { name: 'test', source: 'opencode', description: 'Second' };

    expect(mergeCommandAutocompleteItems([], [first, duplicate], [])).toEqual([{
      ...first,
      searchAliases: ['Second'],
    }]);
    expect(first.searchAliases).toBe(undefined);
  });

  test('handles empty inputs', () => {
    expect(mergeCommandAutocompleteItems([], [], [])).toEqual([]);
  });
});
