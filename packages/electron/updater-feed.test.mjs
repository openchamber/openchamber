import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CANARY_UPDATER_FEED,
  PRODUCTION_UPDATER_FEED,
  isCanaryVersion,
  isUpdateChannel,
  normalizeUpdateChannel,
  parseLoopbackUpdaterUrl,
  resolveUpdaterFeed,
} from './updater-feed.mjs';

const overrideEnvironment = {
  OPENCHAMBER_E2E: '1',
  OPENCHAMBER_UPDATER_E2E_URL: 'http://127.0.0.1:49152/updates/',
};

test('production updater feed is immutable GitHub configuration', () => {
  assert.equal(Object.isFrozen(PRODUCTION_UPDATER_FEED), true);
  assert.deepEqual(PRODUCTION_UPDATER_FEED, {
    provider: 'github',
    owner: 'openchamber',
    repo: 'openchamber',
  });
});

test('the Canary channel reads the canary pre-release; every other stored value is Stable', () => {
  assert.equal(resolveUpdaterFeed({ channel: 'canary' }), CANARY_UPDATER_FEED);
  assert.equal(CANARY_UPDATER_FEED.url, 'https://github.com/openchamber/openchamber/releases/download/canary/');
  assert.equal(resolveUpdaterFeed({ channel: 'stable' }), PRODUCTION_UPDATER_FEED);
  assert.equal(normalizeUpdateChannel('canary'), 'canary');
  for (const value of ['stable', undefined, null, 'beta', 'Canary', 1]) assert.equal(normalizeUpdateChannel(value), 'stable');
  assert.deepEqual(['stable', 'canary', 'beta', undefined].map(isUpdateChannel), [true, true, false, false]);
  // The loopback feed wins on either channel.
  assert.equal(resolveUpdaterFeed({ environment: overrideEnvironment, testBuild: true, channel: 'canary' }).url, overrideEnvironment.OPENCHAMBER_UPDATER_E2E_URL);
});

test('a Canary build is told by the canary pre-release part of its version', () => {
  assert.equal(isCanaryVersion('2.5.4-canary.20261030.123'), true);
  for (const version of ['2.5.4', '2.5.4-beta.1', 'canary', undefined]) assert.equal(isCanaryVersion(version), false);
});

test('requires the complete E2E environment and embedded build-marker conjunction', () => {
  const cases = [
    {},
    { environment: overrideEnvironment },
    { environment: { OPENCHAMBER_E2E: '1' }, testBuild: true },
    {
      environment: { OPENCHAMBER_UPDATER_E2E_URL: overrideEnvironment.OPENCHAMBER_UPDATER_E2E_URL },
      testBuild: true,
    },
    { environment: overrideEnvironment, testBuild: false },
  ];
  for (const input of cases) assert.equal(resolveUpdaterFeed(input), PRODUCTION_UPDATER_FEED);
});

test('accepts only credential-free loopback HTTP(S) URLs', () => {
  assert.equal(parseLoopbackUpdaterUrl('http://127.0.0.1:8080/feed'), 'http://127.0.0.1:8080/feed');
  assert.equal(parseLoopbackUpdaterUrl('https://127.255.0.1/feed/'), 'https://127.255.0.1/feed/');
  assert.equal(parseLoopbackUpdaterUrl('http://[::1]:8080/feed'), 'http://[::1]:8080/feed');

  for (const value of [
    'http://localhost:8080/feed',
    'http://0.0.0.0:8080/feed',
    'http://192.168.1.5:8080/feed',
    'https://example.com/feed',
    'file:///tmp/feed',
    'ftp://127.0.0.1/feed',
    'http://user:secret@127.0.0.1/feed',
    'http://127.0.0.1/feed?token=secret',
    'http://127.0.0.1/feed#fragment',
    'not-a-url',
  ]) assert.equal(parseLoopbackUpdaterUrl(value), null, value);
});

test('uses a generic feed only when every test-only gate is valid', () => {
  assert.deepEqual(resolveUpdaterFeed({
    environment: overrideEnvironment,
    testBuild: true,
  }), {
    provider: 'generic',
    url: 'http://127.0.0.1:49152/updates/',
  });
});

test('invalid URLs fall back to the production feed even with both test gates', () => {
  for (const url of ['https://example.com/feed', 'http://localhost/feed', '']) {
    assert.equal(resolveUpdaterFeed({
      environment: { ...overrideEnvironment, OPENCHAMBER_UPDATER_E2E_URL: url },
      testBuild: true,
    }), PRODUCTION_UPDATER_FEED);
  }
});
