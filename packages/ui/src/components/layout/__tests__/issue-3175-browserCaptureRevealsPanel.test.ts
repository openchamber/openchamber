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

  // The capture used to open the panel on the tab for the screenshot, which
  // flashed the browser in front of the user. It now draws the page
  // transparently instead and leaves the panel alone.
  test('capture never opens the panel or switches its tab', () => {
    expect(browserPaneSource).toContain('revealStageForCapture(stageRef.current)');
    expect(browserPaneSource).not.toContain('setActiveContextPanelTab');
    expect(browserPaneSource).not.toContain('closeContextPanel');
  });
});
