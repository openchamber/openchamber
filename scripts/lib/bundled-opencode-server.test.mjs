import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { devOpenCodeEnv, ensureBundledOpenCodeServer } from './bundled-opencode-server.mjs';

test('a CLI the caller names wins and nothing is prepared', () => {
  let prepared = 0;
  const env = devOpenCodeEnv({ OPENCODE_BINARY: '/opt/opencode' }, () => { prepared += 1; return {}; });
  assert.deepEqual(env, { OPENCODE_BINARY: '/opt/opencode' });
  assert.equal(prepared, 0);
});

test('without one, the bundled server is prepared and used', () => {
  const env = devOpenCodeEnv({}, () => ({ OPENCHAMBER_BUNDLED_OPENCODE_SERVER_DIR: '/checkout/opencode-server' }));
  assert.deepEqual(env, { OPENCHAMBER_BUNDLED_OPENCODE_SERVER_DIR: '/checkout/opencode-server' });
});

test('a failed preparation stops at once and says what to run', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-bundled-opencode-'));
  try {
    const electron = path.join(root, 'packages', 'electron');
    fs.mkdirSync(path.join(electron, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(electron, 'package.json'), JSON.stringify({ devDependencies: { '@opencode/server': '2.3.0' } }));
    fs.writeFileSync(path.join(electron, 'scripts', 'prepare-opencode-server.mjs'), 'console.error("getaddrinfo ENOTFOUND registry.npmjs.org"); process.exit(1)\n');
    assert.throws(
      () => ensureBundledOpenCodeServer(root),
      /Could not prepare the bundled OpenCode server 2\.3\.0 \(.*ENOTFOUND registry\.npmjs\.org.*\).*prepare:opencode-server.*OPENCODE_BINARY/s,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
