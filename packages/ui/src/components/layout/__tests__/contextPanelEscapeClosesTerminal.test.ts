/**
 * Regression guard for https://github.com/openchamber/openchamber/issues/2644
 *
 * Escape while focus is inside the terminal must reach the PTY (e.g. Vim
 * Normal mode). The desktop context zones no longer close on Escape at all;
 * the mobile drawer still does, except from its terminal tab.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const mobileWorkspaceDrawerSource = readFileSync(
  join(__dirname, '..', '..', '..', 'apps', 'MobileWorkspaceDrawer.tsx'),
  'utf-8',
);

describe('issue #2644: Escape in terminal must not close the panel around it', () => {
  test('mobile drawer keeps its terminal Escape exception', () => {
    const handlerStart = mobileWorkspaceDrawerSource.indexOf("if (event.key !== 'Escape'");
    expect(handlerStart).toBeGreaterThan(-1);
    const handler = mobileWorkspaceDrawerSource.slice(handlerStart, handlerStart + 300);
    // The terminal tab returns before the drawer closes on Escape.
    expect(handler).toContain("tabRef.current === 'terminal') return");
    expect(handler).toContain('onCloseRef.current()');
  });
});
