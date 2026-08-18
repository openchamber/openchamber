import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PRODUCTION_UPDATER_FEED,
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
