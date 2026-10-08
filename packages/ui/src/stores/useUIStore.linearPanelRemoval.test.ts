import { afterEach, describe, expect, test } from 'bun:test';
import { useUIStore } from './useUIStore';

const originalOptions = useUIStore.persist.getOptions();
const originalState = useUIStore.getState();
afterEach(() => {
  useUIStore.persist.setOptions(originalOptions);
  useUIStore.setState(originalState, true);
});

describe('Linear rail panel removal', () => {
  test('drops the panel filters a v21 install stored, and a Linear panel tab', async () => {
    useUIStore.persist.setOptions({ storage: {
      getItem: () => ({
        version: 21,
        state: {
          ...useUIStore.getInitialState(),
          linearIssueListStatus: 'started',
          linearIssueListAssignee: 'me',
          linearIssueListTeamIdByRuntime: { 'url:https://a': 'team-1' },
          linearIssueListPriority: 'high',
          contextPanelByDirectory: {
            '/repo': { isOpen: true, expanded: false, activeTabId: 'linear', tabs: [{ id: 'linear', mode: 'linear' }, { id: 'diff', mode: 'diff' }] },
          },
        },
      }),
      setItem: () => undefined,
      removeItem: () => undefined,
    } });
    await useUIStore.persist.rehydrate();
    const state = Object.keys(useUIStore.getState());
    expect(state.filter((key) => key.startsWith('linearIssueList'))).toEqual([]);
    expect(useUIStore.getState().contextPanelByDirectory['/repo']?.tabs.map((tab) => tab.mode)).toEqual(['diff']);
  });
});
