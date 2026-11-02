/**
 * Regression coverage for https://github.com/openchamber/openchamber/issues/6087
 *
 * A docked extension panel flickers when switching tabs in and out because the
 * inactive plugin tab is hidden with `display: none`. Toggling `display` on a
 * sandboxed out-of-process iframe drops its compositing layer, so the first
 * frame after it is shown again is just the host surface — which reads as a
 * flicker. The browser tabs already hide with `invisible pointer-events-none`
 * (visibility: hidden), which keeps the layer alive; the plugin panes must
 * match that pattern.
 *
 * A full ContextSurfacePanes mount is not available in bun test because its
 * import graph includes a Vite worker URL, so this test follows the
 * source-level guard pattern used by the neighboring ContextPanel regression
 * tests.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const contextPanelSource = readFileSync(join(__dirname, '..', 'ContextSurfacePanes.tsx'), 'utf-8');

describe('issue #6087 extension panel flicker on tab switch', () => {
  test('the browser tab pane hides with invisible, not display:none', () => {
    // The browser tabs are the working reference: an inactive tab stays
    // composited so its snapshots read a real page.
    expect(contextPanelSource).toContain(
      "className={cn('absolute inset-0', !shown && 'invisible pointer-events-none')}",
    );
  });

  test('the plugin pane hides with invisible, not display:none', () => {
    // The plugin pane's ZonePane is the one keyed on pluginZone.zone. Its
    // inactive state must use `invisible pointer-events-none` (visibility
    // keeps the compositing layer) rather than `shown ? 'block' : 'hidden'`
    // (display:none drops it and flickers on the next show). Terminal and
    // walkthrough panes are plain React views, not sandboxed iframes, so
    // their display:none is not the bug this issue is about.
    const pluginZonePane = contextPanelSource.match(
      /<ZonePane\s+key=\{tab\.id\}\s+zone=\{pluginZone\.zone\}[\s\S]*?className=\{cn\('absolute inset-0',[^)]*\)\}/,
    );
    expect(pluginZonePane).not.toBeNull();
    expect(pluginZonePane?.[0]).toContain('invisible pointer-events-none');
    expect(pluginZonePane?.[0]).not.toContain("'block' : 'hidden'");
  });
});
