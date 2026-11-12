import { describe, expect, test } from 'bun:test';
import { computeSessionTreeGuides } from './sessionTreeGeometry';

const draw = (levels: readonly (number | null)[]): string[] => computeSessionTreeGuides(levels).map((guides) => (
  (guides ?? []).map(({ level, end }) => `${level}${end ? '└' : '│'}`).join(' ')
));

describe('computeSessionTreeGuides', () => {
  test('frames a worktree\'s sessions and ends at the last one', () => {
    // worktree header, three sessions
    expect(draw([0, 1, 1, 1])).toEqual(['', '1│', '1│', '1└']);
  });

  test('keeps the outer line through an open session\'s subsessions', () => {
    // worktree, session with two subsessions, another session
    expect(draw([0, 1, 2, 2, 1])).toEqual(['', '1│', '1│ 2│', '1│ 2└', '1└']);
  });

  test('stops the outer line at the last session, above its subsessions', () => {
    expect(draw([0, 1, 1, 2])).toEqual(['', '1│', '1└', '2└']);
  });

  test('a row outside the tree closes every line', () => {
    // a session, Show more, then the next worktree's session
    expect(draw([0, 1, null, 0, 1])).toEqual(['', '1└', '', '', '1└']);
  });

  test('root rows draw nothing', () => {
    expect(draw([0, 0, 0])).toEqual(['', '', '']);
  });
});
