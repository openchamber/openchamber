import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldUseLinuxTransparency } from './linux-window-transparency.mjs';

test('Linux frameless windows require an explicit native transparency opt-in', () => {
  const window = { platform: 'linux', frameless: true };
  assert.equal(shouldUseLinuxTransparency({ ...window, requested: '1' }), true);
  for (const requested of [undefined, '', '0', 'true', 'invalid']) {
    assert.equal(shouldUseLinuxTransparency({ ...window, requested }), false);
  }
});

test('native frames and other platforms stay opaque with the opt-in', () => {
  assert.equal(shouldUseLinuxTransparency({ platform: 'linux', frameless: false, requested: '1' }), false);
  for (const platform of ['darwin', 'win32']) {
    assert.equal(shouldUseLinuxTransparency({ platform, frameless: true, requested: '1' }), false);
  }
});
