import { describe, expect, test } from 'bun:test';
import { checkOpencodePins, readOpencodePins } from './check-opencode-pins.mjs';

describe('bundled OpenCode pins', () => {
  test('the client and both bundled servers pin the same version', () => {
    const pins = readOpencodePins();
    const result = checkOpencodePins(pins);
    if (!result.ok) {
      throw new Error(
        `OpenCode pins disagree: ${JSON.stringify(pins)}. Update package.json, packages/electron/package.json and packages/web/package.json together.`,
      );
    }
  });

  test('reports a version that drifted', () => {
    expect(checkOpencodePins({ workspaceClient: '2.3.0', desktopServer: '2.3.2', webServer: '2.3.0' }))
      .toMatchObject({ ok: false, reason: 'mismatch' });
  });

  test('reports a pin it could not read', () => {
    expect(checkOpencodePins({ workspaceClient: '2.3.0', desktopServer: '2.3.0', webServer: null }))
      .toMatchObject({ ok: false, reason: 'missing', missing: ['webServer'] });
  });
});
