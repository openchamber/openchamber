import assert from 'node:assert/strict';
import test from 'node:test';

import { getInstalledAppsCacheResponse, refreshInstalledAppsCache } from './installed-apps-cache.mjs';

test('returns stale cached apps immediately and logs a rejected background refresh', async () => {
  const error = new Error('enumeration failed');
  const warnings = [];
  let rejectRefresh;
  const refresh = () => new Promise((resolve, reject) => {
    rejectRefresh = reject;
  });

  const response = getInstalledAppsCacheResponse({
    cache: { version: 1, updatedAt: 1, apps: ['cached app'] },
    now: 20,
    version: 1,
    ttlSecs: 10,
    refresh,
    log: { warn: (...args) => warnings.push(args) },
  });

  assert.deepEqual(response, { apps: ['cached app'], hasCache: true, isCacheStale: true });
  rejectRefresh(error);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(warnings, [['[electron] failed to refresh installed apps cache:', error]]);
});

test('refresh rejection leaves the cache unwritten and emits no update', async () => {
  const calls = [];

  await assert.rejects(refreshInstalledAppsCache({
    cachePath: '/cache/apps.json',
    now: 42,
    version: 1,
    apps: ['requested app'],
    buildApps: async () => { throw new Error('enumeration failed'); },
    mkdir: async () => calls.push('mkdir'),
    writeFile: async () => calls.push('writeFile'),
    emit: (...args) => calls.push(args),
  }), /enumeration failed/);

  assert.deepEqual(calls, []);
});

test('cache persistence rejection does not emit an update', async () => {
  const calls = [];

  await assert.rejects(refreshInstalledAppsCache({
    cachePath: '/cache/apps.json',
    now: 42,
    version: 1,
    apps: ['requested app'],
    buildApps: async (apps) => apps,
    mkdir: async () => calls.push('mkdir'),
    writeFile: async () => { throw new Error('disk full'); },
    emit: (...args) => calls.push(args),
  }), /disk full/);

  assert.deepEqual(calls, ['mkdir']);
});

test('successful refresh persists the cache before emitting the update', async () => {
  const calls = [];

  await refreshInstalledAppsCache({
    cachePath: '/cache/apps.json',
    now: 42,
    version: 1,
    apps: ['requested app'],
    buildApps: async (apps) => [...apps, 'discovered app'],
    mkdir: async () => calls.push('mkdir'),
    writeFile: async (...args) => calls.push(['writeFile', ...args]),
    emit: (...args) => calls.push(['emit', ...args]),
  });

  assert.deepEqual(calls, [
    'mkdir',
    ['writeFile', '/cache/apps.json', JSON.stringify({ version: 1, updatedAt: 42, apps: ['requested app', 'discovered app'] }, null, 2)],
    ['emit', 'openchamber:installed-apps-updated', ['requested app', 'discovered app']],
  ]);
});
