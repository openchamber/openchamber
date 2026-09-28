/**
 * Regression coverage for https://github.com/openchamber/openchamber/issues/3175
 *
 * A full ContextPanel mount is not available in bun test because its import
 * graph includes a Vite worker URL. This test follows the source-level guard
 * pattern used by the neighboring ContextPanel regression tests and exercises
 * the real store behavior that the registered opener delegates to.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { useUIStore } from '@/stores/useUIStore';

const __dirname = dirname(fileURLToPath(import.meta.url));
const contextPanelSource = readFileSync(join(__dirname, '..', 'ContextPanel.tsx'), 'utf-8');
const browserPaneSource = readFileSync(join(__dirname, '..', '..', 'browser', 'BrowserPane.tsx'), 'utf-8');
const DIRECTORY = '/path/to/repository';

beforeEach(() => {
  useUIStore.setState({ contextPanelByDirectory: {}, contextRailOrder: [] });
});

describe('issue #3175 browser capture while the agent works in the background', () => {
  test('an agent browser.open creates the tab without revealing the panel', () => {
    expect(contextPanelSource).toContain('openAgentBrowserTab(effectiveDirectory, url)');

    useUIStore.getState().openAgentBrowserTab(DIRECTORY, 'https://example.com');

    const panel = useUIStore.getState().contextPanelByDirectory[DIRECTORY];
    expect(panel.isOpen).toBe(false);
    expect(panel.tabs).toHaveLength(1);
    expect(panel.tabs[0]?.mode).toBe('browser');
    expect(panel.tabs[0]?.targetPath).toBe('https://example.com');
  });

  test('capture shows the tab only for the screenshot and restores the panel after', () => {
    expect(browserPaneSource).toContain('ui.setActiveContextPanelTab(directory, tabID)');
    expect(browserPaneSource).toContain('restorePanel();');
  });

  test('restoring after capture puts a closed panel and the prior tab back', () => {
    const store = useUIStore.getState();
    store.openContextPanelTab(DIRECTORY, { mode: 'terminal', targetDirectory: null });
    const terminalTab = useUIStore.getState().contextPanelByDirectory[DIRECTORY].activeTabId;
    store.openContextBrowser(DIRECTORY, 'https://example.com', { reveal: false });
    store.closeContextPanel(DIRECTORY);
    const browserTab = useUIStore.getState().contextPanelByDirectory[DIRECTORY].tabs
      .find((tab) => tab.mode === 'browser')!.id;

    // What the capture does: show the tab, then restore the saved view.
    store.setActiveContextPanelTab(DIRECTORY, browserTab);
    expect(useUIStore.getState().contextPanelByDirectory[DIRECTORY].isOpen).toBe(true);
    store.setActiveContextPanelTab(DIRECTORY, terminalTab!);
    store.closeContextPanel(DIRECTORY);

    const panel = useUIStore.getState().contextPanelByDirectory[DIRECTORY];
    expect(panel.isOpen).toBe(false);
    expect(panel.activeTabId).toBe(terminalTab);
  });
});
