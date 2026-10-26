import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isSpaceId,
  spaceIdOfPreviewPartition,
  spacePreviewPartition,
  spacePreviewProxyConfig,
} from './space-preview.mjs';

test('a space gets a partition of its own, in memory, and the id reads back from it', () => {
  const partition = spacePreviewPartition('84369ed6edda');
  assert.equal(partition.startsWith('persist:'), false);
  assert.equal(spaceIdOfPreviewPartition(partition), '84369ed6edda');
  assert.equal(spaceIdOfPreviewPartition('persist:openchamber-browser'), null);
  assert.equal(spaceIdOfPreviewPartition('openchamber-space-preview:../etc'), null);
  assert.equal(spaceIdOfPreviewPartition(undefined), null);
});

test('only a twelve-hex id is a space id', () => {
  assert.equal(isSpaceId('84369ed6edda'), true);
  assert.equal(isSpaceId('84369ed6edd'), false);
  assert.equal(isSpaceId('84369ED6EDDA'), false);
  assert.throws(() => spacePreviewPartition('x'), /space id/);
});

test('the proxy rules send everything to the dead proxy and bypass only the space tunnel ports', () => {
  const config = spacePreviewProxyConfig({ deadProxyPort: 51000, localPorts: [51234, 51235] });
  assert.equal(config.proxyRules, '127.0.0.1:51000');
  const bypass = config.proxyBypassRules.split(';');
  // Without this Chromium bypasses the proxy for 127.0.0.1 and every *.localhost
  // name on its own, and the page reaches the local API and the user's servers.
  assert.equal(bypass[0], '<-loopback>');
  assert.deepEqual(bypass.slice(1), ['openchamber-preview.localhost:51234', 'openchamber-preview.localhost:51235']);
});

test('with no tunnel open the page reaches nothing at all', () => {
  const config = spacePreviewProxyConfig({ deadProxyPort: 51000, localPorts: [] });
  assert.equal(config.proxyBypassRules, '<-loopback>');
});

test('a port that is not a port is left out rather than written into the rules', () => {
  const config = spacePreviewProxyConfig({ deadProxyPort: 51000, localPorts: [0, 70000, 'abc', 4321] });
  assert.equal(config.proxyBypassRules, '<-loopback>;openchamber-preview.localhost:4321');
  assert.throws(() => spacePreviewProxyConfig({ deadProxyPort: 0, localPorts: [] }), /dead proxy port/);
});
