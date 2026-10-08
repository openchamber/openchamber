import { describe, expect, test } from 'bun:test';

import { useSourceBoardStore } from './useSourceBoardStore';

// What localStorage may hold: the store's own shape, an older or broken one, or anything else.
type StoredValue = string | { choices: string | Record<string, Record<string, string | number>>; listWidth?: number | string };

const merge = (persisted: StoredValue, current: ReturnType<typeof useSourceBoardStore.getState>) => {
  const options = useSourceBoardStore.persist.getOptions();
  if (!options.merge) throw new Error('The board store reads its own persisted shape');
  return options.merge(persisted, current);
};

describe('source board choice', () => {
  test('remembers project, tab and team per runtime', () => {
    useSourceBoardStore.setState({ choices: {} });
    useSourceBoardStore.getState().update({ projectId: 'p1' });
    useSourceBoardStore.getState().update({ tab: 'linear', linearTeamId: 't1' });
    const choices = Object.values(useSourceBoardStore.getState().choices);
    expect(choices).toEqual([{ projectId: 'p1', tab: 'linear', linearTeamId: 't1' }]);
  });

  test('keeps the readable parts of stored data and drops the rest', () => {
    const current = useSourceBoardStore.getState();
    expect(merge({ choices: { local: { projectId: 'p1', tab: 'nonsense', linearTeamId: 5 } } }, current).choices)
      .toEqual({ local: { projectId: 'p1', tab: 'repository', linearTeamId: null } });
    expect(merge('garbage', current).choices).toEqual({});
    expect(merge({ choices: {}, listWidth: 360 }, current).listWidth).toBe(360);
    expect(merge({ choices: {}, listWidth: 'wide' }, current).listWidth).toBeNull();
    expect(merge({ choices: 'garbage' }, current).choices).toEqual({});
  });
});
