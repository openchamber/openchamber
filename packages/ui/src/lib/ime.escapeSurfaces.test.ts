import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Escape during an IME composition dismisses the candidate window; only a
 * clean Escape afterwards may close a surface. Surfaces that listen for
 * Escape at the document or window level — or in a capture phase above the
 * field being typed into — must let the composed Escape pass, or dismissing
 * a candidate while writing a comment collapses the panel instead. This is
 * the same contract `ime.commentInputs.test.ts` holds the comment fields to.
 */
const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..');

const ESCAPE_SURFACES: Array<{ name: string; file: string; handler: string; close: RegExp }> = [
  {
    // The context zone frame and every keep-alive pane (changes, notes, ...)
    // close the zone from a capture handler that runs before the field's own.
    name: 'context zone',
    file: 'components/layout/zoneEscape.ts',
    handler: 'export const closeZoneOnEscape',
    close: /close\(\);/,
  },
  {
    name: 'sidebar peek',
    file: 'components/layout/useSidebarPeek.ts',
    handler: 'const handleKeyDown',
    close: /hide\(\);/,
  },
  {
    name: 'mobile overlay panel',
    file: 'components/ui/MobileOverlayPanel.tsx',
    handler: 'const handleKeyDown',
    close: /onClose\(\);/,
  },
  {
    name: 'mobile fullscreen surface',
    file: 'apps/MobileFullscreenSurface.tsx',
    handler: 'const handleKeyDown',
    close: /onCloseRef\.current\(\);/,
  },
  {
    name: 'mobile sessions sheet',
    file: 'apps/MobileSessionsSheet.tsx',
    handler: 'const handleKeyDown',
    close: /onCloseRef\.current\(\);/,
  },
  {
    name: 'mobile workspace drawer',
    file: 'apps/MobileWorkspaceDrawer.tsx',
    handler: 'const handleKeyDown',
    close: /onCloseRef\.current\(\);/,
  },
];

describe('escape surfaces ignore IME composition keystrokes', () => {
  for (const surface of ESCAPE_SURFACES) {
    test(surface.name, () => {
      const source = readFileSync(join(srcDir, surface.file), 'utf-8');
      const start = source.indexOf(surface.handler);
      expect(start).toBeGreaterThan(-1);

      // From the handler to the end of its close action; the peek sidebar's
      // handler sits inside an effect that also wires pointer listeners.
      const handler = source.slice(start, start + 2000);
      const guardIndex = handler.indexOf('isIMECompositionEvent');
      const closeIndex = handler.search(surface.close);

      expect(guardIndex).toBeGreaterThan(-1);
      expect(closeIndex).toBeGreaterThan(guardIndex);
    });
  }
});
