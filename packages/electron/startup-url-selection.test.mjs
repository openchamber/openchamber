import assert from 'node:assert/strict';
import test from 'node:test';

import {
  describeStartupEnvironmentOverrides,
  resolveStartupUrlProbePlan,
  shouldIgnoreLoopbackConnectionLimit,
} from './startup-url-selection.mjs';

test('bundled development never probes HMR endpoints', () => {
  assert.deepEqual(resolveStartupUrlProbePlan({
    development: true,
    packagedUi: true,
    skipLocalServer: false,
  }), {
    probeHmrApi: false,
    probeHmrUi: false,
  });
});

test('HMR development probes both API and UI endpoints', () => {
  assert.deepEqual(resolveStartupUrlProbePlan({
    development: true,
    packagedUi: false,
    skipLocalServer: false,
  }), {
    probeHmrApi: true,
    probeHmrUi: true,
  });
});

test('serverless HMR development skips only the local API probe', () => {
  assert.deepEqual(resolveStartupUrlProbePlan({
    development: true,
    packagedUi: false,
    skipLocalServer: true,
  }), {
    probeHmrApi: false,
    probeHmrUi: true,
  });
});

test('production does not probe HMR endpoints', () => {
  assert.deepEqual(resolveStartupUrlProbePlan({
    development: false,
    packagedUi: false,
    skipLocalServer: false,
  }), {
    probeHmrApi: false,
    probeHmrUi: false,
  });
});

test('keeps Chromium connection limits for the Vite HMR module graph', () => {
  assert.equal(shouldIgnoreLoopbackConnectionLimit({ development: true, packagedUi: false }), false);
  assert.equal(shouldIgnoreLoopbackConnectionLimit({ development: true, packagedUi: true }), true);
  assert.equal(shouldIgnoreLoopbackConnectionLimit({ development: false, packagedUi: false }), true);
});

// #5240: these two variables stopped the built-in server and opened another
// address, and main.log said nothing about either.
test('a launch that skips the built-in server and opens another address says so', () => {
  assert.deepEqual(describeStartupEnvironmentOverrides({
    skipLocalServer: true,
    serverUrl: 'http://127.0.0.1:3000',
  }), [
    'OPENCHAMBER_SKIP_LOCAL_SERVER=1 is set: not starting the built-in server',
    'OPENCHAMBER_SERVER_URL is set: opening http://127.0.0.1:3000',
  ]);
});

test('the logged address keeps only its origin', () => {
  assert.deepEqual(describeStartupEnvironmentOverrides({
    skipLocalServer: false,
    serverUrl: 'https://user:secret@example.test:8443/base?token=abc',
  }), ['OPENCHAMBER_SERVER_URL is set: opening https://example.test:8443']);
});

test('an address startup cannot use is named as ignored, without its text', () => {
  for (const serverUrl of ['127.0.0.1:3000', 'ftp://example.test', 'not a url']) {
    assert.deepEqual(describeStartupEnvironmentOverrides({ skipLocalServer: false, serverUrl }), [
      'OPENCHAMBER_SERVER_URL is set but is not an http(s) address: ignoring it',
    ]);
  }
});

test('a plain launch logs nothing', () => {
  for (const serverUrl of [undefined, '', '   ']) {
    assert.deepEqual(describeStartupEnvironmentOverrides({ skipLocalServer: false, serverUrl }), []);
  }
});
