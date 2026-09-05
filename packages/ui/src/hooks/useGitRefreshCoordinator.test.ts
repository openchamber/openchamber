import { describe, expect, test } from 'bun:test';
import { createGitRefreshCoordinator } from './useGitRefreshCoordinator';

type AppliedHint = { directory: string; paths?: string[] };

const setup = (initiallyHidden: boolean) => {
  const applied: AppliedHint[] = [];
  let hidden = initiallyHidden;
  const coordinator = createGitRefreshCoordinator({
    isHidden: () => hidden,
    applyHint: (hint: AppliedHint) => applied.push(hint),
  });
  return {
    applied,
    coordinator,
    setHidden: (value: boolean) => {
      hidden = value;
    },
  };
};

describe('createGitRefreshCoordinator', () => {
  test('applies hints immediately while visible', () => {
    const { applied, coordinator } = setup(false);
    coordinator.onHint({ directory: '/repo', paths: ['a.ts'] });
    expect(applied).toEqual([{ directory: '/repo', paths: ['a.ts'] }]);
  });

  test('defers while hidden and flushes one merged hint per directory', () => {
    const { applied, coordinator, setHidden } = setup(true);
    coordinator.onHint({ directory: '/repo', paths: ['a.ts'] });
    coordinator.onHint({ directory: '/repo', paths: ['b.ts'] });
    coordinator.onHint({ directory: '/other' });
    expect(applied).toEqual([]);
    setHidden(false);
    coordinator.flush();
    expect(applied).toHaveLength(2);
    expect(applied.find((h) => h.directory === '/repo')?.paths?.sort()).toEqual(['a.ts', 'b.ts']);
    expect(applied.find((h) => h.directory === '/other')?.paths).toBe(undefined);
  });

  test('a pathless hint absorbs queued path hints for the same directory', () => {
    const { applied, coordinator, setHidden } = setup(true);
    coordinator.onHint({ directory: '/repo', paths: ['a.ts'] });
    coordinator.onHint({ directory: '/repo' });
    setHidden(false);
    coordinator.flush();
    expect(applied).toEqual([{ directory: '/repo' }]);
  });

  test('trailing-slash variants coalesce to one flush entry', () => {
    const { applied, coordinator, setHidden } = setup(true);
    coordinator.onHint({ directory: '/repo/' });
    coordinator.onHint({ directory: '/repo' });
    setHidden(false);
    coordinator.flush();
    expect(applied).toHaveLength(1);
  });
});
