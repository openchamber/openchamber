import { describe, expect, test } from 'bun:test';

import { useSourceBoardStore } from './useSourceBoardStore';

// What localStorage may hold: the store's own shape, an older or broken one, or anything else.
type StoredValue = string | { choices: string | Record<string, Record<string, string | number | Record<string, string | boolean>>>; listWidth?: number | string };

const merge = (persisted: StoredValue, current: ReturnType<typeof useSourceBoardStore.getState>) => {
  const options = useSourceBoardStore.persist.getOptions();
  if (!options.merge) throw new Error('The board store reads its own persisted shape');
  return options.merge(persisted, current);
};

describe('source board choice', () => {
  test('remembers a nested repository per project and still reads data stored without it', () => {
    const current = useSourceBoardStore.getState();
    useSourceBoardStore.setState({ choices: {} });
    useSourceBoardStore.getState().update({ repositoryByProject: { p1: '/work/app' } });
    useSourceBoardStore.getState().update({ repositoryByProject: { p2: '/other/api' } });
    useSourceBoardStore.getState().update({ tab: 'linear' });
    useSourceBoardStore.getState().update({ repositoryByProject: { p1: '/work/web' } });
    expect(Object.values(useSourceBoardStore.getState().choices)[0]?.repositoryByProject).toEqual({ p1: '/work/web', p2: '/other/api' });
    expect(merge({ choices: { local: { projectId: 'p1', tab: 'linear', linearTeamId: 't1' } } }, current).choices)
      .toEqual({ local: { projectId: 'p1', tab: 'linear', linearTeamId: 't1', repositoryByProject: {}, allRepositoriesByProject: {} } });
    expect(merge({ choices: { local: { repositoryPath: '/work/app' } } }, current).choices.local?.repositoryByProject).toEqual({});
    expect(merge({ choices: { local: { repositoryByProject: 'garbage' } } }, current).choices.local?.repositoryByProject).toEqual({});
  });

  test('remembers whether each project lists all its repositories, merging per project', () => {
    const current = useSourceBoardStore.getState();
    useSourceBoardStore.setState({ choices: {} });
    useSourceBoardStore.getState().update({ allRepositoriesByProject: { p1: true } });
    useSourceBoardStore.getState().update({ allRepositoriesByProject: { p2: false }, repositoryByProject: { p2: '/other/api' } });
    useSourceBoardStore.getState().update({ allRepositoriesByProject: { p1: false } });
    const choice = Object.values(useSourceBoardStore.getState().choices)[0];
    expect(choice?.allRepositoriesByProject).toEqual({ p1: false, p2: false });
    expect(choice?.repositoryByProject).toEqual({ p2: '/other/api' });
    // Data stored before the option existed reads as nothing chosen; a malformed map is dropped.
    expect(merge({ choices: { local: { repositoryByProject: { p1: '/work/app' } } } }, current).choices.local?.allRepositoriesByProject).toEqual({});
    expect(merge({ choices: { local: { allRepositoriesByProject: { p1: true } } } }, current).choices.local?.allRepositoriesByProject).toEqual({ p1: true });
    expect(merge({ choices: { local: { allRepositoriesByProject: { p1: 'yes' } } } }, current).choices.local?.allRepositoriesByProject).toEqual({});
  });

  test('remembers project, tab and team per runtime', () => {
    useSourceBoardStore.setState({ choices: {} });
    useSourceBoardStore.getState().update({ projectId: 'p1' });
    useSourceBoardStore.getState().update({ tab: 'linear', linearTeamId: 't1' });
    const choices = Object.values(useSourceBoardStore.getState().choices);
    expect(choices).toEqual([{ projectId: 'p1', tab: 'linear', linearTeamId: 't1', repositoryByProject: {}, allRepositoriesByProject: {} }]);
  });

  test('keeps the readable parts of stored data and drops the rest', () => {
    const current = useSourceBoardStore.getState();
    expect(merge({ choices: { local: { projectId: 'p1', tab: 'nonsense', linearTeamId: 5 } } }, current).choices)
      .toEqual({ local: { projectId: 'p1', tab: 'repository', linearTeamId: null, repositoryByProject: {}, allRepositoriesByProject: {} } });
    expect(merge('garbage', current).choices).toEqual({});
    expect(merge({ choices: {}, listWidth: 360 }, current).listWidth).toBe(360);
    expect(merge({ choices: {}, listWidth: 'wide' }, current).listWidth).toBeNull();
    expect(merge({ choices: 'garbage' }, current).choices).toEqual({});
  });
});
