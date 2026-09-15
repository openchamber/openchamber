import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { normalizeContextPanelDirectoryKey, useUIStore } from '../../../stores/useUIStore';

describe('header context-panel toggle directory identity', () => {
  test('uses the canonical key for the header callback lookup', () => {
    const source = readFileSync(new URL('../Header.tsx', import.meta.url), 'utf8');
    expect(source).toContain("const handleOpenContextPanel = React.useCallback(() => {\n    const directory = normalizeContextPanelDirectoryKey(openDirectory || '');");
  });

  test('finds and closes an open context panel through a Windows path variant', () => {
    const originalState = useUIStore.getState();
    try {
      useUIStore.setState({ contextPanelByDirectory: {} });
      useUIStore.getState().openContextOverview('C:/repo/nested');
      const directory = normalizeContextPanelDirectoryKey(' c:\\repo//nested/ ');
      const panel = useUIStore.getState().contextPanelByDirectory[directory];
      expect(panel?.isOpen).toBe(true);
      expect(panel?.tabs.find((tab) => tab.id === panel.activeTabId)?.mode).toBe('context');
      useUIStore.getState().closeContextPanel(directory);
      expect(useUIStore.getState().contextPanelByDirectory['C:/repo/nested']?.isOpen).toBe(false);
    } finally {
      useUIStore.setState(originalState, true);
    }
  });
});
