import { describe, expect, test } from 'bun:test';
import { computeGitHunks, computeGitLineChanges } from './gitChangeGutter';

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

describe('computeGitHunks', () => {
  // Reverting every hunk, last first so earlier offsets stay valid, must
  // give back the baseline exactly: that is what the Revert button relies on.
  const revertAll = (baseline: string, current: string) => computeGitHunks(baseline, current)
    .reverse()
    .reduce((text, hunk) => text.slice(0, hunk.from) + hunk.original + text.slice(hunk.to), current);

  test('each hunk covers its range of the current file and carries the baseline lines', () => {
    const baseline = lines('one', 'two', 'three', 'four', 'five');
    const current = lines('one', 'TWO', 'three', 'five', 'six');
    expect(computeGitHunks(baseline, current)).toEqual([
      { kind: 'modified', from: 4, to: 8, original: 'two\n' },
      { kind: 'deleted', from: 14, to: 14, original: 'four\n' },
      { kind: 'added', from: 19, to: 23, original: '' },
    ]);
  });

  test('reverting every hunk restores the baseline', () => {
    const cases: Array<[string, string]> = [
      [lines('a', 'b', 'c'), lines('a', 'c')],
      [lines('a', 'b', 'c'), lines('b', 'c')],
      [lines('a', 'b'), ''],
      ['', lines('x', 'y')],
      ['x\ny', 'x\nz'],
      [lines('l1', 'l2', 'l3', 'l4', 'l5', 'l6'), lines('l1', 'NEW', 'l2', 'l3x', 'l5', 'l6', 'end')],
    ];
    for (const [baseline, current] of cases) expect(revertAll(baseline, current)).toBe(baseline);
  });
});
