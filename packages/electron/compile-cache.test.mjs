import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { COMPILE_CACHE_DIR_NAME, enableMainProcessCompileCache, settleMainProcessCompileCache } from './compile-cache.mjs';

const recordingEnable = (calls, result = { status: 1, directory: '/cache' }) => (dir) => {
  calls.push(dir);
  return result;
};

describe('main process compile cache', () => {
  it('enables the cache under userData for packaged builds', () => {
    const calls = [];
    const dir = enableMainProcessCompileCache({
      packaged: true,
      userDataDir: '/profile',
      env: {},
      enableCompileCache: recordingEnable(calls),
    });
    assert.deepEqual(calls, [path.join('/profile', COMPILE_CACHE_DIR_NAME)]);
    assert.equal(dir, '/cache');
  });

  it('stays off in development and under AppImage', () => {
    const calls = [];
    const enableCompileCache = recordingEnable(calls);
    assert.equal(enableMainProcessCompileCache({ packaged: false, userDataDir: '/p', env: {}, enableCompileCache }), null);
    assert.equal(enableMainProcessCompileCache({ packaged: true, userDataDir: '/p', env: { APPIMAGE: '/x.AppImage' }, enableCompileCache }), null);
    assert.deepEqual(calls, []);
  });

  it('keeps NODE_COMPILE_CACHE out of the environment children inherit', () => {
    const env = {};
    enableMainProcessCompileCache({
      packaged: true,
      userDataDir: '/p',
      env,
      enableCompileCache: (dir) => {
        env.NODE_COMPILE_CACHE = dir;
        return { status: 1, directory: dir };
      },
    });
    assert.equal('NODE_COMPILE_CACHE' in env, false);
  });

  it('restores a NODE_COMPILE_CACHE the user set', () => {
    const env = { NODE_COMPILE_CACHE: '/users-own' };
    enableMainProcessCompileCache({
      packaged: true,
      userDataDir: '/p',
      env,
      enableCompileCache: (dir) => {
        env.NODE_COMPILE_CACHE = dir;
        return { status: 1, directory: dir };
      },
    });
    assert.equal(env.NODE_COMPILE_CACHE, '/users-own');
  });

  it('never throws into startup', () => {
    const result = enableMainProcessCompileCache({
      packaged: true,
      userDataDir: '/p',
      env: {},
      enableCompileCache: () => { throw new Error('EACCES'); },
    });
    assert.equal(result, null);
  });

  it('reports a failed enable as off', () => {
    const result = enableMainProcessCompileCache({
      packaged: true,
      userDataDir: '/p',
      env: {},
      enableCompileCache: () => ({ status: 0, message: 'denied' }),
    });
    assert.equal(result, null);
  });

  it('flushes and removes caches of other Node versions after startup', async () => {
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-compile-cache-'));
    try {
      const root = path.join(userData, COMPILE_CACHE_DIR_NAME);
      const active = path.join(root, 'v24.21.0-arm64-aaaa-501');
      const stale = path.join(root, 'v22.20.0-arm64-bbbb-501');
      const sibling = path.join(userData, 'Local Storage');
      fs.mkdirSync(active, { recursive: true });
      fs.mkdirSync(stale);
      fs.mkdirSync(sibling);
      fs.writeFileSync(path.join(stale, 'entry'), 'x');
      let flushed = 0;
      await settleMainProcessCompileCache({
        userDataDir: userData,
        getCompileCacheDir: () => active,
        flushCompileCache: () => { flushed += 1; },
      });
      assert.equal(flushed, 1);
      assert.equal(fs.existsSync(active), true);
      assert.equal(fs.existsSync(stale), false);
      assert.equal(fs.existsSync(sibling), true);
    } finally {
      fs.rmSync(userData, { recursive: true, force: true });
    }
  });

  it('deletes nothing when Node reports the cache root itself', async () => {
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-compile-cache-'));
    try {
      const root = path.join(userData, COMPILE_CACHE_DIR_NAME);
      const versionDir = path.join(root, 'v24.21.0-arm64-aaaa-501');
      const localStorage = path.join(userData, 'Local Storage');
      const indexedDb = path.join(userData, 'IndexedDB');
      fs.mkdirSync(versionDir, { recursive: true });
      fs.mkdirSync(localStorage);
      fs.mkdirSync(indexedDb);
      let flushed = 0;
      await settleMainProcessCompileCache({
        userDataDir: userData,
        getCompileCacheDir: () => root,
        flushCompileCache: () => { flushed += 1; },
      });
      assert.equal(flushed, 1);
      assert.equal(fs.existsSync(versionDir), true);
      assert.equal(fs.existsSync(localStorage), true);
      assert.equal(fs.existsSync(indexedDb), true);
    } finally {
      fs.rmSync(userData, { recursive: true, force: true });
    }
  });

  it('deletes nothing when the active directory is outside the known root', async () => {
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-compile-cache-'));
    try {
      const root = path.join(userData, COMPILE_CACHE_DIR_NAME);
      const stale = path.join(root, 'v22.20.0-arm64-bbbb-501');
      const elsewhere = path.join(userData, 'other', 'v24.21.0-arm64-aaaa-501');
      fs.mkdirSync(stale, { recursive: true });
      fs.mkdirSync(elsewhere, { recursive: true });
      await settleMainProcessCompileCache({
        userDataDir: userData,
        getCompileCacheDir: () => elsewhere,
        flushCompileCache: () => {},
      });
      assert.equal(fs.existsSync(stale), true);
      assert.equal(fs.existsSync(elsewhere), true);
    } finally {
      fs.rmSync(userData, { recursive: true, force: true });
    }
  });

  it('does nothing when the cache is off', async () => {
    let flushed = 0;
    await settleMainProcessCompileCache({
      getCompileCacheDir: () => undefined,
      flushCompileCache: () => { flushed += 1; },
    });
    assert.equal(flushed, 0);
  });
});
