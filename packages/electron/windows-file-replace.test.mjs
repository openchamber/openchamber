import assert from 'node:assert/strict';
import test from 'node:test';

import { readJsonObjectForUpdate, replaceFileWithRetry } from './windows-file-replace.mjs';

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

test('reads a missing settings file as an empty document', async () => {
  const root = await readJsonObjectForUpdate('settings.json', {
    readFile: async () => { throw fileError('ENOENT'); },
    wait: async () => assert.fail('unexpected wait'),
  });

  assert.deepEqual(root, {});
});

test('reads a settings file again while another program holds it or is mid-write', async () => {
  const contents = [fileError('EBUSY'), '{"projects":[{"id":"a"', '{"projects":[{"id":"a"}]}'];
  const delays = [];

  const root = await readJsonObjectForUpdate('settings.json', {
    readFile: async () => {
      const next = contents.shift();
      if (next instanceof Error) throw next;
      return next;
    },
    wait: async (delay) => delays.push(delay),
  });

  assert.deepEqual(root, { projects: [{ id: 'a' }] });
  assert.deepEqual(delays, [50, 100]);
});

test('refuses to hand out an empty document for a settings file it cannot read', async () => {
  const error = fileError('EBUSY');
  let attempts = 0;

  await assert.rejects(
    readJsonObjectForUpdate('settings.json', {
      readFile: async () => {
        attempts += 1;
        throw error;
      },
      wait: async () => {},
    }),
    error,
  );

  assert.equal(attempts, 8);
});

test('refuses a settings file that does not hold an object', async () => {
  await assert.rejects(
    readJsonObjectForUpdate('settings.json', { readFile: async () => '[]', wait: async () => {} }),
    /does not hold a JSON object/,
  );
});
