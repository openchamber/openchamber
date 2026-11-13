import { beforeEach, describe, expect, test } from 'bun:test';

import { useUIStore } from './useUIStore';

describe('useUIStore mobile workspace tabs', () => {
  beforeEach(() => {
    useUIStore.setState({ mobileWorkspaceTabOrder: [], mobileWorkspaceHiddenTabs: [] });
  });

  test('hides and shows tabs, but never the last one shown', () => {
    const { setMobileWorkspaceTabVisible } = useUIStore.getState();
    for (const tab of ['status', 'changes', 'files', 'terminal', 'preview'] as const) setMobileWorkspaceTabVisible(tab, false);
    expect(useUIStore.getState().mobileWorkspaceHiddenTabs).toEqual(['status', 'changes', 'files', 'terminal', 'preview']);

    setMobileWorkspaceTabVisible('notes', false);
    expect(useUIStore.getState().mobileWorkspaceHiddenTabs).toEqual(['status', 'changes', 'files', 'terminal', 'preview']);

    setMobileWorkspaceTabVisible('files', true);
    expect(useUIStore.getState().mobileWorkspaceHiddenTabs).toEqual(['status', 'changes', 'terminal', 'preview']);
  });

  test('stores a full order of known tabs', () => {
    useUIStore.getState().setMobileWorkspaceTabOrder(['notes', 'unknown', 'notes', 'mcp', 'files']);
    expect(useUIStore.getState().mobileWorkspaceTabOrder).toEqual(['status', 'changes', 'terminal', 'preview', 'notes', 'files']);
  });

  test('counts the extension tabs shown, and keeps a saved extension tab across a reorder without it', () => {
    const { setMobileWorkspaceTabVisible, setMobileWorkspaceTabOrder } = useUIStore.getState();
    for (const tab of ['status', 'changes', 'files', 'terminal', 'preview'] as const) setMobileWorkspaceTabVisible(tab, false, ['plugin:tasks']);
    setMobileWorkspaceTabVisible('notes', false, ['plugin:tasks']);
    expect(useUIStore.getState().mobileWorkspaceHiddenTabs).toEqual(['status', 'changes', 'files', 'terminal', 'preview', 'notes']);

    setMobileWorkspaceTabOrder(['status', 'plugin:tasks', 'changes', 'files', 'terminal', 'notes']);
    // Another server has no such extension: the drawer reorders what it shows,
    // and the extension's tab keeps its place after Status.
    setMobileWorkspaceTabOrder(['notes', 'status', 'changes', 'files', 'terminal']);
    expect(useUIStore.getState().mobileWorkspaceTabOrder).toEqual(['preview', 'notes', 'status', 'plugin:tasks', 'changes', 'files', 'terminal']);
  });
});
