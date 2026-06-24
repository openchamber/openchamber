import { describe, expect, test } from 'bun:test';
import { mergeCommandsWithSkills } from '../commandAutocompleteItems';

describe('mergeCommandsWithSkills', () => {
  test('drops a command that shares a name with a skill (#1550)', () => {
    const commands = [{ name: 'grill-with-docs', source: 'opencode' }];
    const skills = [{ name: 'grill-with-docs', source: 'skill' }];

    const merged = mergeCommandsWithSkills(commands, skills);

    expect(merged).toHaveLength(1);
    // The surviving entry is the skill, which carries the correct badge/metadata.
    expect(merged[0].source).toBe('skill');
  });

  test('keeps commands that have no matching skill', () => {
    const commands = [{ name: 'review' }, { name: 'grill-with-docs' }];
    const skills = [{ name: 'grill-with-docs' }];

    const merged = mergeCommandsWithSkills(commands, skills);

    expect(merged.map((item) => item.name)).toEqual(['review', 'grill-with-docs']);
  });

  test('preserves order: surviving commands first, then skills', () => {
    const commands = [{ name: 'a' }];
    const skills = [{ name: 'b' }];

    expect(mergeCommandsWithSkills(commands, skills).map((item) => item.name)).toEqual(['a', 'b']);
  });

  test('handles empty inputs', () => {
    expect(mergeCommandsWithSkills([], [])).toEqual([]);
    expect(mergeCommandsWithSkills([{ name: 'a' }], [])).toHaveLength(1);
    expect(mergeCommandsWithSkills([], [{ name: 'b' }])).toHaveLength(1);
  });
});
