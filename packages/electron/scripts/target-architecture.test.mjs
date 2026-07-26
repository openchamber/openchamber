import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeTargetArchitecture,
  readElectronBuilderArchitecture,
  resolveTargetArchitecture,
} from './target-architecture.mjs';

test('normalizes host and release architecture aliases', () => {
  assert.equal(normalizeTargetArchitecture('amd64').node, 'x64');
  assert.equal(normalizeTargetArchitecture('x86_64').electronBuilder, 'x64');
  assert.equal(normalizeTargetArchitecture('aarch64').opencode, 'arm64');
});

test('reads a single electron-builder target architecture', () => {
  assert.equal(readElectronBuilderArchitecture(['--linux', '--arch=aarch64']), 'arm64');
  assert.equal(readElectronBuilderArchitecture(['--linux', '--x64']), 'x64');
});

test('rejects unsupported architectures', () => {
  assert.throws(() => normalizeTargetArchitecture('ia32'), /Supported architectures: x64, arm64/);
});

test('rejects conflicting architecture inputs', () => {
  assert.throws(
    () => resolveTargetArchitecture({
      platform: 'linux',
      hostArchitecture: 'x64',
      environment: { OPENCHAMBER_TARGET_ARCH: 'x64', ELECTRON_BUILDER_ARCH: 'arm64' },
    }),
    /Conflicting target architectures/,
  );
});

test('rejects cross-architecture Linux packaging', () => {
  assert.throws(
    () => resolveTargetArchitecture({
      platform: 'linux',
      hostArchitecture: 'x86_64',
      environment: { OPENCHAMBER_TARGET_ARCH: 'aarch64' },
    }),
    /must be built natively.*host is x64, target is arm64/,
  );
});

test('accepts matching native Linux architecture aliases', () => {
  assert.equal(resolveTargetArchitecture({
    platform: 'linux',
    hostArchitecture: 'x64',
    environment: { OPENCHAMBER_TARGET_ARCH: 'amd64' },
  }).node, 'x64');
});
