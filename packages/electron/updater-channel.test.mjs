import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveUpdaterChannel } from './updater-channel.mjs';

test('uses an architecture-specific Windows ARM64 update channel', () => {
  assert.equal(resolveUpdaterChannel({ platform: 'win32', architecture: 'arm64' }), 'latest-arm64');
});

test('keeps the default channel for other desktop targets', () => {
  assert.equal(resolveUpdaterChannel({ platform: 'win32', architecture: 'x64' }), null);
  assert.equal(resolveUpdaterChannel({ platform: 'darwin', architecture: 'arm64' }), null);
  assert.equal(resolveUpdaterChannel({ platform: 'linux', architecture: 'arm64' }), null);
});
