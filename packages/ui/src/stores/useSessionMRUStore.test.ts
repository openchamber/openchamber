import { beforeEach, describe, expect, test } from 'bun:test';
import { buildGlobalSessionStructure } from './globalSessionStructure';
import { MAX_MRU_SIZE, useSessionMRUStore } from './useSessionMRUStore';
import { useGlobalSessionsStore } from './useGlobalSessionsStore';
import { useUIStore } from './useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';

describe('useSessionMRUStore', () => {
  beforeEach(() => {
    useSessionMRUStore.getState().reset();
    useUIStore.getState().setRecentSessionCyclingEnabled(true);
    useSessionUIStore.setState({ currentSessionId: null });
    useGlobalSessionsStore.setState({
      structure: buildGlobalSessionStructure([]),
    });
  });

  test('records current-session changes from oldest to newest', () => {
    useSessionUIStore.setState({ currentSessionId: 'a' });
    useSessionUIStore.setState({ currentSessionId: 'b' });
    useSessionUIStore.setState({ currentSessionId: 'c' });
    useSessionUIStore.setState({ currentSessionId: 'b' });

    expect(useSessionMRUStore.getState().sessionIds).toEqual(['a', 'c', 'b']);
  });

  test('keeps recording visits while keyboard cycling is disabled', () => {
    useUIStore.getState().setRecentSessionCyclingEnabled(false);

    useSessionUIStore.setState({ currentSessionId: 'a' });
    useSessionUIStore.setState({ currentSessionId: 'b' });

    expect(useSessionMRUStore.getState().sessionIds).toEqual(['a', 'b']);
  });

  test('keeps a newly selected unresolved session until active membership changes', () => {
    useSessionMRUStore.setState({ sessionIds: ['a', 'b'] });

    useSessionUIStore.setState({ currentSessionId: 'new' });

    expect(useSessionMRUStore.getState().sessionIds).toEqual(['a', 'b', 'new']);
  });

  test('removes sessions proven to have left active membership', () => {
    useGlobalSessionsStore.setState((state) => ({
      structure: {
        ...state.structure,
        activeSessionIds: ['removed', 'a', 'b'],
      },
    }));
    useSessionMRUStore.setState({ sessionIds: ['removed', 'a', 'b', 'unresolved'] });

    useGlobalSessionsStore.setState((state) => ({
      structure: {
        ...state.structure,
        activeSessionIds: ['a', 'b'],
      },
    }));

    expect(useSessionMRUStore.getState().sessionIds).toEqual(['a', 'b', 'unresolved']);
  });

  test('caps history without duplicating revisited sessions', () => {
    for (let index = 0; index <= MAX_MRU_SIZE; index += 1) {
      useSessionMRUStore.getState().recordVisit(`session-${index}`);
    }

    useSessionMRUStore.getState().recordVisit('session-10');

    const sessionIds = useSessionMRUStore.getState().sessionIds;
    expect(sessionIds).toHaveLength(MAX_MRU_SIZE);
    expect(sessionIds[0]).toBe('session-1');
    expect(sessionIds.at(-1)).toBe('session-10');
    expect(sessionIds.filter((id) => id === 'session-10')).toHaveLength(1);
  });
});
