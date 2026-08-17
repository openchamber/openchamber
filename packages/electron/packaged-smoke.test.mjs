import assert from 'node:assert/strict';
import test from 'node:test';
import { isPackagedSmokeEnabled, writePackagedSmokeReady } from './packaged-smoke.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('packaged smoke requires packaged mode, argument, and both environment values', () => {
  const input = { argv: ['--openchamber-packaged-smoke'], env: { OPENCHAMBER_PACKAGED_SMOKE: '1', OPENCHAMBER_PACKAGED_SMOKE_DIR: '/tmp/smoke' }, packaged: true };
  assert.equal(isPackagedSmokeEnabled(input), true);
  assert.equal(isPackagedSmokeEnabled({ ...input, packaged: false }), false);
  assert.equal(isPackagedSmokeEnabled({ ...input, env: { ...input.env, OPENCHAMBER_PACKAGED_SMOKE: '0' } }), false);
});

test('smoke readiness is emitted only after both authoritative phases', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-smoke-test-'));
  const env = { OPENCHAMBER_PACKAGED_SMOKE_DIR: dir };
  assert.equal(writePackagedSmokeReady({ env, serverReady: true, rendererReady: false }), false);
  assert.equal(fs.existsSync(path.join(dir, 'ready.json')), false);
  assert.equal(writePackagedSmokeReady({ env, serverReady: true, rendererReady: true }), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'ready.json'), 'utf8')), { serverReady: true, rendererReady: true });
  assert.equal(writePackagedSmokeReady({ env, serverReady: true, rendererReady: true, requireWorkspace: true }), false);
  assert.equal(writePackagedSmokeReady({ env, serverReady: true, rendererReady: true, requireWorkspace: true, workspaceReady: true }), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'ready.json'), 'utf8')), { serverReady: true, rendererReady: true, workspaceReady: true, cleanupComplete: true });
});
