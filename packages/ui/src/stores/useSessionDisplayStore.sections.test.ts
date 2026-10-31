import { describe, expect, test } from 'bun:test';
import { dropSectionsOfOtherInstance, useSessionDisplayStore } from './useSessionDisplayStore';

const custom = { kind: 'custom' as const, id: 's1', name: 'Mine', grouping: 'time' as const, filter: { states: ['running' as const], work: [], pins: [], kinds: [], links: [], projectIds: [], activity: 'any' as const }, claims: false, hideWhenEmpty: true };

describe('sidebar sections belong to their instance', () => {
  test('another instance drops them back to the built-in sections, the same one keeps them', () => {
    useSessionDisplayStore.setState({
      sections: [custom], pinLists: [{ id: 'l1', name: 'Release' }], hiddenSections: ['s1'], sectionsOwner: 'host:a',
    });
    dropSectionsOfOtherInstance('host:a');
    expect(useSessionDisplayStore.getState().sections).toEqual([custom]);

    dropSectionsOfOtherInstance('mobile-disconnected');
    expect(useSessionDisplayStore.getState().sections).toEqual([custom]);

    dropSectionsOfOtherInstance('host:b');
    const state = useSessionDisplayStore.getState();
    expect(state.sections.map((entry) => entry.id)).toEqual(['chats', 'pinned', 'work', 'projects']);
    expect(state.pinLists).toEqual([]);
    expect(state.hiddenSections).toEqual([]);
    expect(state.sectionsOwner).toBeNull();
  });
});
