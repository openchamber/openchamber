/**
 * Regression guard for persisted context-panel terminal targets.
 *
 * The context panel keeps the singleton terminal pane mounted even when another
 * context tab is active. The mounted `TerminalView` must therefore receive its
 * directory from the stored terminal tab itself, not from whichever tab is
 * currently active.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// The keep-alive terminal pane lives in ContextSurfacePanes, portalled into its zone.
const contextPanelSource = readFileSync(join(__dirname, '..', 'ContextSurfacePanes.tsx'), 'utf-8');

describe('context panel terminal target wiring', () => {
  test('keeps a singleton terminal tab lookup independent of the active tab', () => {
    expect(contextPanelSource).toContain('const terminalTab = React.useMemo(');
    expect(contextPanelSource).toContain("tabs.find((tab) => tab.mode === 'terminal')");
    expect(contextPanelSource).not.toContain('const hasTerminalTab = React.useMemo(');
  });

  test('passes the stored terminal targetDirectory into the mounted TerminalView', () => {
    const renderStart = contextPanelSource.indexOf('{terminalTab ? (');
    expect(renderStart).toBeGreaterThan(-1);
    const renderEnd = contextPanelSource.indexOf('{hasWalkthroughTab ? (', renderStart);
    expect(renderEnd).toBeGreaterThan(renderStart);
    const renderBlock = contextPanelSource.slice(renderStart, renderEnd);

    expect(renderBlock).toContain("terminalZone.activeTab?.mode === 'terminal' ? 'block' : 'hidden'");
    expect(renderBlock).toContain('<TerminalView');
    expect(renderBlock).toContain("visible={terminalZone.isOpen && terminalZone.activeTab?.mode === 'terminal'}");
    expect(renderBlock).toContain('directory={terminalTab.targetDirectory}');
    expect(renderBlock).not.toContain('directory={activeTab?.targetDirectory}');
    expect(renderBlock).not.toContain('directory={effectiveDirectory}');
  });
});
