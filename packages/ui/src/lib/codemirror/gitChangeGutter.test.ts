import { describe, expect, test } from 'bun:test';
import { computeGitLineChanges } from './gitChangeGutter';

const lines = (...values: string[]) => `${values.join('\n')}\n`;

describe('computeGitLineChanges', () => {
  test('an unchanged file has no markers', () => {
    const text = lines('a', 'b', 'c');
    expect([...computeGitLineChanges(text, text)]).toEqual([]);
  });

  test('marks inserted, rewritten and trailing lines by their line in the current file', () => {
    const baseline = lines('l1', 'l2', 'l3', 'l4', 'l5', 'l6');
    const current = lines('l1', 'NEW', 'l2', 'l3x', 'l5', 'l6', 'end');

    expect([...computeGitLineChanges(baseline, current)]).toEqual([
      [2, 'added'],
      [4, 'modified'],
      [7, 'added'],
    ]);
  });

  test('marks a removal on the line above the gap, or line 1 when the top was removed', () => {
    expect([...computeGitLineChanges(lines('a', 'b', 'c'), lines('a', 'c'))]).toEqual([[1, 'deleted']]);
    expect([...computeGitLineChanges(lines('a', 'b', 'c'), lines('b', 'c'))]).toEqual([[1, 'deletedAbove']]);
  });

  test('an emptied file marks the removal above line 1', () => {
    expect([...computeGitLineChanges(lines('a', 'b'), '')]).toEqual([[1, 'deletedAbove']]);
  });

  test('a new file is all added', () => {
    expect([...computeGitLineChanges('', lines('x', 'y'))]).toEqual([[1, 'added'], [2, 'added']]);
  });
});
