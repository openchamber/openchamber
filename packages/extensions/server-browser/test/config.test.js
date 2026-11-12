import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig, networkGrants, originGrants, parseConfig } from '../src/config.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('defaults to no private origin grants', () => {
  const config = parseConfig({});

  assert.deepEqual(config, {
    chromePath: null,
    allowedOrigins: [],
    allowedNetworks: [],
    discoverDevServers: false,
    projectDevServers: true,
    allowPrivateNetwork: null,
    profileStore: null,
    profileKeyFile: null,
  });
  assert.deepEqual(originGrants(config.allowedOrigins), []);
});

test('takes protected origins only from the host and fails on malformed host policy', () => {
  // Given a local file trying to override host-owned origins.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-config-'));
  const configPath = path.join(directory, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ openchamberOrigins: [], allowedOrigins: ['https://front.example'] }));
  try {
    // When loading configuration with a dedicated host field.
    const config = loadConfig({ configPath, env: { OPENCHAMBER_BROWSER_ORIGINS: '["https://front.example"]' } });
    // Then local grants cannot erase the refusal.
    assert.deepEqual(config.openchamberOrigins, ['https://front.example']);
    for (const value of ['not json', 'null', '["https://front.example/path"]']) {
      assert.throws(() => loadConfig({ configPath, env: { OPENCHAMBER_BROWSER_ORIGINS: value } }));
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('normalizes explicit origins into exact host and port grants', () => {
  const config = parseConfig({
    chromePath: '/opt/chrome',
    allowedOrigins: ['http://localhost:3000', 'https://device.example'],
  });

  assert.equal(config.chromePath, '/opt/chrome');
  assert.deepEqual(originGrants(config.allowedOrigins), [
    { host: 'localhost', port: 3000, protocol: 'http:' },
    { host: 'device.example', port: 443, protocol: 'https:' },
  ]);
});

test('rejects allowlist entries that are not exact http origins', () => {
  assert.throws(
    () => parseConfig({ allowedOrigins: ['http://localhost:3000/private'] }),
    /must be an http\(s\) origin/,
  );
  assert.throws(
    () => parseConfig({ allowedOrigins: ['file:///tmp/page.html'] }),
    /must be an http\(s\) origin/,
  );
});

test('parses private network blocks with explicit ports and ranges', () => {
  const config = parseConfig({ allowedNetworks: [{ cidr: '192.168.1.0/24', ports: [3000, '5173-5199', '8080'] }] });
  const [grant] = networkGrants(config.allowedNetworks);

  assert.deepEqual(config.allowedNetworks[0].ports, [[3000, 3000], [5173, 5199], [8080, 8080]]);
  assert.equal(grant.block.check('192.168.1.20', 'ipv4'), true);
  assert.equal(grant.block.check('192.168.2.20', 'ipv4'), false);
});

test('rejects network blocks that are public, too broad, or missing explicit ports', () => {
  for (const network of [
    { cidr: '8.8.8.0/24', ports: [3000] },
    { cidr: '10.0.0.0/7', ports: [3000] },
    { cidr: '192.168.1.0/24' },
    { cidr: '192.168.1.0/24', ports: ['*'] },
    { cidr: '192.168.1.0/24', ports: ['3000-2000'] },
  ]) {
    assert.throws(() => parseConfig({ allowedNetworks: [network] }), /config\.allowedNetworks\[0\]/);
  }
});


test('turns development-server discovery on only with an explicit boolean', () => {
  assert.equal(parseConfig({ discoverDevServers: true }).discoverDevServers, true);
  assert.throws(() => parseConfig({ discoverDevServers: 'yes' }), /discoverDevServers must be true or false/);
});
test('keeps project development servers on unless turned off, and profile paths absolute', () => {
  assert.equal(parseConfig({ projectDevServers: false }).projectDevServers, false);
  assert.throws(() => parseConfig({ projectDevServers: 'no' }), /projectDevServers must be true or false/);
  const config = parseConfig({ profileStore: '/srv/profiles', profileKeyFile: '/run/credentials/openchamber/key' });
  assert.equal(config.profileStore, '/srv/profiles');
  assert.equal(config.profileKeyFile, '/run/credentials/openchamber/key');
  assert.throws(() => parseConfig({ profileKeyFile: 'profile.key' }), /profileKeyFile must be an absolute path/);
});
