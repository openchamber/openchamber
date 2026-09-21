import assert from 'node:assert/strict';
import test from 'node:test';

import { replaceFileWithRetry } from './windows-file-replace.mjs';

const fileError = (code = 'EPERM') => Object.assign(new Error(code), { code });

test('retries transient Windows rename failures until replacement succeeds', async () => {
  const delays = [];
  let attempts = 0;

  await replaceFileWithRetry('settings.tmp', 'settings.json', {
    platform: 'win32',
    rename: async () => {
      attempts += 1;
      if (attempts < 4) throw fileError();
    },
    wait: async (delay) => delays.push(delay),
  });

  assert.equal(attempts, 4);
  assert.deepEqual(delays, [50, 100, 200]);
});

test('does not retry rename errors that are not transient Windows locks', async () => {
  let attempts = 0;
  const error = fileError('ENOENT');

  await assert.rejects(
    replaceFileWithRetry('settings.tmp', 'settings.json', {
      platform: 'win32',
      rename: async () => {
        attempts += 1;
        throw error;
      },
      wait: async () => assert.fail('unexpected wait'),
    }),
    error,
  );

  assert.equal(attempts, 1);
});

test('does not retry transient error codes outside Windows', async () => {
  let attempts = 0;
  const error = fileError();

  await assert.rejects(
    replaceFileWithRetry('settings.tmp', 'settings.json', {
      platform: 'linux',
      rename: async () => {
        attempts += 1;
        throw error;
      },
      wait: async () => assert.fail('unexpected wait'),
    }),
    error,
  );

  assert.equal(attempts, 1);
});

test('returns the final Windows lock error after the retry window', async () => {
  const delays = [];
  let attempts = 0;

  await assert.rejects(
    replaceFileWithRetry('settings.tmp', 'settings.json', {
      platform: 'win32',
      rename: async () => {
        attempts += 1;
        throw fileError();
      },
      wait: async (delay) => delays.push(delay),
    }),
    { code: 'EPERM' },
  );

  assert.equal(attempts, 8);
  assert.deepEqual(delays, [50, 100, 200, 400, 800, 1_000, 1_000]);
});
