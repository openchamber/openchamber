import { describe, expect, test } from 'bun:test';
import { rankSkillAutocompleteItems } from '../skillAutocompleteItems';

interface Item {
  id: string;
  name: string;
  scope: string;
}

describe('rankSkillAutocompleteItems', () => {
  test('places $apply name matches before fuzzy-only matches', () => {
    const skills: Item[] = [
      { id: 'apple-design', name: 'apple-design', scope: 'user' },
      { id: 'openspec-apply-change', name: 'openspec-apply-change', scope: 'user' },
      { id: 'opsx-apply', name: 'opsx-apply', scope: 'user' },
      { id: 'zebra', name: 'zebra', scope: 'user' },
    ];

    expect(rankSkillAutocompleteItems(skills, 'apply').map((skill) => skill.name)).toEqual([
      'opsx-apply',
      'openspec-apply-change',
      'apple-design',
    ]);
  });

  test('keeps project skills above user skills', () => {
    const skills: Item[] = [
      { id: 'apply', name: 'apply', scope: 'user' },
      { id: 'apple-design', name: 'apple-design', scope: 'project' },
    ];

    expect(rankSkillAutocompleteItems(skills, 'apply').map((skill) => skill.name)).toEqual([
      'apple-design',
      'apply',
    ]);
  });

  test('keeps project first, then alphabetical order, when the query is empty', () => {
    const skills: Item[] = [
      { id: 'zebra', name: 'zebra', scope: 'user' },
      { id: 'beta', name: 'beta', scope: 'project' },
      { id: 'alpha', name: 'alpha', scope: 'user' },
    ];

    expect(rankSkillAutocompleteItems(skills, '').map((skill) => skill.name)).toEqual([
      'beta',
      'alpha',
      'zebra',
    ]);
  });

  test('finds a skill by the id the picker shows, not only by its display name', () => {
    const skills: Item[] = [
      { id: 'beta-one', name: 'Same Name', scope: 'project' },
      { id: 'beta-two', name: 'Same Name', scope: 'project' },
      { id: 'alpha-skill', name: 'Alpha Display', scope: 'user' },
    ];

    // The id match ranks first; `beta-one` is a fuzzy-only hit.
    expect(rankSkillAutocompleteItems(skills, 'beta-t').map((skill) => skill.id)).toEqual(['beta-two', 'beta-one']);
    expect(rankSkillAutocompleteItems(skills, 'Alph').map((skill) => skill.id)).toEqual(['alpha-skill']);
  });
});
