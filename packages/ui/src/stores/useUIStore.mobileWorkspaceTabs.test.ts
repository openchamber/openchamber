import { beforeEach, describe, expect, test } from 'bun:test';

import { useUIStore } from './useUIStore';

describe('useUIStore mobile workspace tabs', () => {
  beforeEach(() => {
    useUIStore.setState({ mobileWorkspaceTabOrder: [], mobileWorkspaceHiddenTabs: [] });
  });

  test('hides and shows tabs, but never the last one shown', () => {
    const { setMobileWorkspaceTabVisible } = useUIStore.getState();
    for (const tab of ['status', 'changes', 'files', 'terminal'] as const) setMobileWorkspaceTabVisible(tab, false);
    expect(useUIStore.getState().mobileWorkspaceHiddenTabs).toEqual(['status', 'changes', 'files', 'terminal']);

    setMobileWorkspaceTabVisible('notes', false);
    expect(useUIStore.getState().mobileWorkspaceHiddenTabs).toEqual(['status', 'changes', 'files', 'terminal']);

    setMobileWorkspaceTabVisible('files', true);
    expect(useUIStore.getState().mobileWorkspaceHiddenTabs).toEqual(['status', 'changes', 'terminal']);
  });

  test('stores a full order of known tabs', () => {
    useUIStore.getState().setMobileWorkspaceTabOrder(['notes', 'unknown', 'notes', 'mcp', 'files']);
    expect(useUIStore.getState().mobileWorkspaceTabOrder).toEqual(['status', 'changes', 'terminal', 'notes', 'files']);
  });
});
