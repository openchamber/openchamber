import { describe, expect, test } from 'bun:test';

import { useUIStore } from './useUIStore';

// Snapshot the initial value so we can restore it after each test.
const initialSubagentPref = useUIStore.getState().showSubagentSessionsInSidebar;
const restore = () => {
  useUIStore.setState({ showSubagentSessionsInSidebar: initialSubagentPref });
};

describe('useUIStore.showSubagentSessionsInSidebar', () => {
  test('default is false (subagent sessions are hidden by default)', () => {
    restore();
    useUIStore.setState({ showSubagentSessionsInSidebar: false });
    expect(useUIStore.getState().showSubagentSessionsInSidebar).toBe(false);
    restore();
  });

  test('setShowSubagentSessionsInSidebar(true) enables subagent visibility', () => {
    restore();
    useUIStore.getState().setShowSubagentSessionsInSidebar(true);
    expect(useUIStore.getState().showSubagentSessionsInSidebar).toBe(true);
    restore();
  });

  test('setShowSubagentSessionsInSidebar(false) restores hidden default', () => {
    restore();
    useUIStore.getState().setShowSubagentSessionsInSidebar(true);
    useUIStore.getState().setShowSubagentSessionsInSidebar(false);
    expect(useUIStore.getState().showSubagentSessionsInSidebar).toBe(false);
    restore();
  });

  test('setter is a no-op when value is already the target', () => {
    restore();
    useUIStore.setState({ showSubagentSessionsInSidebar: false });
    const before = useUIStore.getState();
    useUIStore.getState().setShowSubagentSessionsInSidebar(false);
    const after = useUIStore.getState();
    expect(after.showSubagentSessionsInSidebar).toBe(before.showSubagentSessionsInSidebar);
    restore();
  });
});
