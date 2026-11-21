import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { assertUpdaterCapability, enableMacosDirectContentsUpdates } from './updater-capability.mjs';

test('macOS direct-Contents updates leave other platforms untouched', () => {
  for (const platform of ['linux', 'win32']) {
    const calls = [];
    enableMacosDirectContentsUpdates({
      platform,
      app: { getPath: () => { calls.push('getPath'); return '/Applications/OpenChamber.app/Contents/MacOS/OpenChamber'; } },
      access: () => { calls.push('access'); },
      realpath: (target) => { calls.push('realpath'); return target; },
      list: () => { calls.push('list'); return ''; },
      systemPreferences: {
        getUserDefault: () => { calls.push('getUserDefault'); return ''; },
        setUserDefault: () => { calls.push('setUserDefault'); },
      },
    });
    assert.deepEqual(calls, [], platform);
  }
});

const BUNDLE = '/Applications/OpenChamber.app';
const CONTENTS = `${BUNDLE}/Contents`;

// writable: the set of paths that pass a W_OK probe. stored: the string read of
// the preference ('' when unset, '1' or '0' for a stored boolean).
const PLAIN_LISTING = (targets) => targets.map((target) => `drwxr-xr-x  3 501  80  - 96 Nov 21 01:00 ${target}`).join('\n') + '\n';

const runDirectContents = ({ writable = [BUNDLE, CONTENTS], stored = '', exe = `${CONTENTS}/MacOS/OpenChamber`, realpath = (target) => target, list = PLAIN_LISTING } = {}) => {
  const probes = [];
  const writes = [];
  enableMacosDirectContentsUpdates({
    platform: 'darwin',
    app: { getPath: (name) => {
      assert.equal(name, 'exe');
      return exe;
    } },
    access: (target, mode) => {
      probes.push([target, mode]);
      if (!writable.includes(target)) throw Object.assign(new Error('probe failed'), { code: 'EACCES' });
    },
    realpath,
    list,
    systemPreferences: {
      getUserDefault: (key, type) => {
        assert.deepEqual([key, type], ['SquirrelMacEnableDirectContentsWrite', 'string']);
        return stored;
      },
      setUserDefault: (...args) => writes.push(args),
    },
  });
  return { probes, writes };
};

test('macOS direct-Contents updates turn on when only the parent folder blocks the install', () => {
  const { probes, writes } = runDirectContents();
  assert.deepEqual(probes, [
    [BUNDLE, fs.constants.W_OK],
    [CONTENTS, fs.constants.W_OK],
    ['/Applications', fs.constants.W_OK],
  ]);
  assert.deepEqual(writes, [['SquirrelMacEnableDirectContentsWrite', 'boolean', true]]);
});

test('macOS direct-Contents updates follow the real bundle path behind a symlink', () => {
  const { writes } = runDirectContents({
    exe: '/Users/me/Apps/OpenChamber.app/Contents/MacOS/OpenChamber',
    realpath: (target) => target.replace('/Users/me/Apps', '/Applications'),
  });
  assert.equal(writes.length, 1);
});

test('a writable parent folder keeps the usual install path', () => {
  const { writes } = runDirectContents({ writable: [BUNDLE, CONTENTS, '/Applications'] });
  assert.deepEqual(writes, []);
});

test('a bundle that cannot take a Contents rename keeps the usual privileged path', () => {
  for (const writable of [[], [CONTENTS], [BUNDLE]]) {
    const { writes } = runDirectContents({ writable });
    assert.deepEqual(writes, [], `writable: ${writable.join(', ') || 'none'}`);
  }
});

test('ACL entries, file flags or a sticky bundle keep the usual privileged path', () => {
  const listings = {
    acl: (targets) => `${PLAIN_LISTING(targets)} 0: group:everyone deny delete\n`,
    flags: (targets) => PLAIN_LISTING(targets).replace(' - 96', ' uchg 96'),
    sticky: (targets) => PLAIN_LISTING(targets).replace('drwxr-xr-x ', 'drwxr-xr-t '),
    failed: () => { throw new Error('ls failed'); },
  };
  for (const [name, list] of Object.entries(listings)) {
    const { writes } = runDirectContents({ list });
    assert.deepEqual(writes, [], name);
  }
});

test('a real bundle whose Contents denies deletion keeps the usual privileged path', { skip: process.platform !== 'darwin' || process.getuid?.() === 0 }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-direct-contents-'));
  const parent = path.join(root, 'Applications');
  const contents = path.join(parent, 'OpenChamber.app', 'Contents');
  fs.mkdirSync(path.join(contents, 'MacOS'), { recursive: true });
  const run = () => {
    const writes = [];
    enableMacosDirectContentsUpdates({
      platform: 'darwin',
      app: { getPath: () => path.join(contents, 'MacOS', 'OpenChamber') },
      systemPreferences: { getUserDefault: () => '', setUserDefault: (...args) => writes.push(args) },
    });
    return writes;
  };
  try {
    fs.chmodSync(parent, 0o555);
    assert.equal(run().length, 1, 'a plain writable bundle under a protected folder opts in');
    execFileSync('/bin/chmod', ['+a', 'everyone deny delete', contents]);
    assert.deepEqual(run(), []);
  } finally {
    execFileSync('/bin/chmod', ['-N', contents]);
    fs.chmodSync(parent, 0o755);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a stored preference is never overwritten, including the explicit false opt-out', () => {
  for (const stored of ['0', '1']) {
    const { probes, writes } = runDirectContents({ stored });
    assert.deepEqual(probes, []);
    assert.deepEqual(writes, []);
  }
});

test('a path outside an app bundle is left alone', () => {
  const { writes } = runDirectContents({ exe: '/usr/local/lib/openchamber/bin/OpenChamber', writable: ['/usr/local/lib/openchamber'] });
  assert.deepEqual(writes, []);
});

test('failed probes and preference reads never interrupt startup', () => {
  const writes = [];
  const systemPreferences = (read) => ({ getUserDefault: read, setUserDefault: (...args) => writes.push(args) });
  assert.doesNotThrow(() => enableMacosDirectContentsUpdates({
    platform: 'darwin',
    app: { getPath: () => `${CONTENTS}/MacOS/OpenChamber` },
    systemPreferences: systemPreferences(() => { throw new Error('defaults unavailable'); }),
  }));
  assert.doesNotThrow(() => enableMacosDirectContentsUpdates({
    platform: 'darwin',
    app: { getPath: () => `${CONTENTS}/MacOS/OpenChamber` },
    realpath: () => { throw Object.assign(new Error('gone'), { code: 'ENOENT' }); },
    systemPreferences: systemPreferences(() => ''),
  }));
  assert.deepEqual(writes, []);
});

test('preserves updater behavior outside packaged Linux', () => {
  assert.doesNotThrow(() => assertUpdaterCapability({ platform: 'darwin', packaged: true }));
  assert.doesNotThrow(() => assertUpdaterCapability({ platform: 'win32', packaged: true }));
  assert.doesNotThrow(() => assertUpdaterCapability({ platform: 'linux', packaged: false }));
});

test('rejects packaged Linux execution outside an AppImage or an installed package', () => {
  assert.throws(
    () => assertUpdaterCapability({ platform: 'linux', packaged: true, appImagePath: '', packageType: '' }),
    /Start OpenChamber from its \.AppImage file or install a package/,
  );
  assert.throws(
    () => assertUpdaterCapability({ platform: 'linux', packaged: true, appImagePath: '', packageType: 'pacman' }),
    /install a package/,
  );
});

test('accepts installed .deb and .rpm packages', () => {
  for (const packageType of ['deb', 'rpm']) {
    assert.doesNotThrow(() => assertUpdaterCapability({ platform: 'linux', packaged: true, appImagePath: '', packageType }));
  }
});

test('rejects missing and non-writable AppImages with actionable errors', () => {
  assert.throws(
    () => assertUpdaterCapability({
      platform: 'linux',
      packaged: true,
      appImagePath: '/opt/OpenChamber.AppImage',
      stat: () => { throw new Error('missing'); },
    }),
    /cannot be found.*valid \.AppImage file/,
  );
  assert.throws(
    () => assertUpdaterCapability({
      platform: 'linux',
      packaged: true,
      appImagePath: '/opt/OpenChamber.AppImage',
      stat: () => ({ isFile: () => true }),
      access: () => { throw new Error('read-only'); },
    }),
    /not writable.*grant write permission/,
  );
});

test('accepts a writable packaged AppImage', () => {
  assert.doesNotThrow(() => assertUpdaterCapability({
    platform: 'linux',
    packaged: true,
    appImagePath: '/home/user/OpenChamber.AppImage',
    stat: () => ({ isFile: () => true }),
    access: () => {},
  }));
});
