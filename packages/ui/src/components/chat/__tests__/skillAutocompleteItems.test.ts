import { describe, expect, test } from 'bun:test';
import { rankSkillAutocompleteItems } from '../skillAutocompleteItems';

interface Item {
  name: string;
  scope: string;
}

describe('rankSkillAutocompleteItems', () => {
  test('places $apply name matches before fuzzy-only matches', () => {
    const skills: Item[] = [
      { name: 'apple-design', scope: 'user' },
      { name: 'openspec-apply-change', scope: 'user' },
      { name: 'opsx-apply', scope: 'user' },
      { name: 'zebra', scope: 'user' },
    ];

    expect(rankSkillAutocompleteItems(skills, 'apply').map((skill) => skill.name)).toEqual([
      'opsx-apply',
      'openspec-apply-change',
      'apple-design',
    ]);
  });

  test('keeps project skills above user skills', () => {
    const skills: Item[] = [
      { name: 'apply', scope: 'user' },
      { name: 'apple-design', scope: 'project' },
    ];

    expect(rankSkillAutocompleteItems(skills, 'apply').map((skill) => skill.name)).toEqual([
      'apple-design',
      'apply',
    ]);
  });

  test('keeps project first, then alphabetical order, when the query is empty', () => {
    const skills: Item[] = [
      { name: 'zebra', scope: 'user' },
      { name: 'beta', scope: 'project' },
      { name: 'alpha', scope: 'user' },
    ];

    expect(rankSkillAutocompleteItems(skills, '').map((skill) => skill.name)).toEqual([
      'beta',
      'alpha',
      'zebra',
    ]);
  });
});
