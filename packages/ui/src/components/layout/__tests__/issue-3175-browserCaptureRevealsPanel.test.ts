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

describe('issue #3175 browser capture while the context panel is closed', () => {
  test('registers the agent browser opener without suppressing panel reveal', () => {
    expect(contextPanelSource).toContain(
      'registerBrowserOpener((url) => openContextBrowser(effectiveDirectory, url))',
    );
    expect(contextPanelSource).not.toContain(
      'openContextBrowser(effectiveDirectory, url, { reveal: false })',
    );
  });

  test('opening the agent browser gives its webview a visible panel surface', () => {
    useUIStore.getState().openContextBrowser(DIRECTORY, 'https://example.com');

    const panel = useUIStore.getState().contextPanelByDirectory[DIRECTORY];
    expect(panel.isOpen).toBe(true);
    expect(panel.tabs).toHaveLength(1);
    expect(panel.tabs[0]?.mode).toBe('browser');
    expect(panel.tabs[0]?.targetPath).toBe('https://example.com');
  });

  test('reveals the browser again if it was closed before capture', () => {
    expect(browserPaneSource).toContain(
      'openContextBrowser(directory, webview.getURL())',
    );
  });
});
