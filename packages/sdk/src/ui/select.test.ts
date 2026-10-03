import { describe, expect, test } from 'bun:test';

import { filterSelectOptions } from './select.ts';

const options = [
  { id: 'todo', label: 'Todo' },
  { id: 'in-progress', label: 'In Progress', hint: '3' },
  { id: 'done', label: 'Done' },
];

describe('filterSelectOptions', () => {
  test('keeps every option for an empty or blank query', () => {
    expect(filterSelectOptions(options, '')).toEqual(options);
    expect(filterSelectOptions(options, '   ')).toEqual(options);
  });

  test('matches label case-insensitively', () => {
    expect(filterSelectOptions(options, 'PROG').map((option) => option.id)).toEqual(['in-progress']);
  });

  test('matches id as well as label', () => {
    expect(filterSelectOptions(options, 'in-pro').map((option) => option.id)).toEqual(['in-progress']);
  });

  test('returns nothing when nothing matches', () => {
    expect(filterSelectOptions(options, 'zzz')).toEqual([]);
  });
});
