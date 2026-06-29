import { describe, expect, it } from 'vitest';

import { shouldUsePackagedUi } from './packaged-ui-policy.mjs';

describe('shouldUsePackagedUi', () => {
  it('uses packaged UI for packaged non-Windows builds', () => {
    expect(shouldUsePackagedUi({ env: {}, isPackaged: true, platform: 'darwin' })).toBe(true);
  });

  it('serves packaged Windows builds through the local server by default', () => {
    expect(shouldUsePackagedUi({ env: {}, isPackaged: true, platform: 'win32' })).toBe(false);
  });

  it('keeps development builds on the local server by default', () => {
    expect(shouldUsePackagedUi({ env: {}, isPackaged: false, platform: 'darwin' })).toBe(false);
  });

  it('allows explicitly opting into bundled UI on Windows', () => {
    expect(shouldUsePackagedUi({
      env: { OPENCHAMBER_ELECTRON_USE_BUNDLED_UI: '1' },
      isPackaged: true,
      platform: 'win32',
    })).toBe(true);
  });

  it('lets the server UI override win over bundled UI', () => {
    expect(shouldUsePackagedUi({
      env: {
        OPENCHAMBER_ELECTRON_LOAD_SERVER_UI: '1',
        OPENCHAMBER_ELECTRON_USE_BUNDLED_UI: '1',
      },
      isPackaged: true,
      platform: 'darwin',
    })).toBe(false);
  });
});
