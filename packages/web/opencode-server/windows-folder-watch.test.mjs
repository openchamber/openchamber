import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs, { watch as importedWatch } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { createHeadGuard, fixWindowsFolderWatches } from './windows-folder-watch.mjs';

const withPatch = async (platform, run, original = fs.watch) => {
  const real = fs.watch;
  fs.watch = original;
  try {
    fixWindowsFolderWatches(platform);
    await run();
  } finally {
    fs.watch = real;
    delete globalThis.__openchamberHeadGuard;
    syncBuiltinESMExports();
  }
};

test('closes a Windows watch that reports its own deleted folder and keeps one that reports a file', async () => {
  let closed = 0;
  const fake = () => Object.assign(new EventEmitter(), { close: () => { closed += 1; } });
  await withPatch('win32', () => {
    const watcher = importedWatch('C:\\work\\project', () => {});
    watcher.emit('change', 'rename', 'HEAD');
    watcher.emit('change', 'change', null);
    assert.equal(closed, 0);
    watcher.emit('change', 'rename', '\\\\?\\C:\\work\\project');
    assert.equal(closed, 1);
    importedWatch('C:\\work\\project', { encoding: 'ascii' }).emit('change', 'rename', '\\file');
    assert.equal(closed, 1);
  }, fake);
});

test('leaves other platforms alone', async () => {
  const real = fs.watch;
  await withPatch('linux', () => assert.equal(fs.watch, real));
});

test('a deleted folder stops sending events', { skip: process.platform !== 'win32' && 'Windows only' }, async () => {
  await withPatch('win32', async () => {
    const folder = fs.mkdtempSync(path.join(tmpdir(), 'oc-deleted-watch-'));
    const names = [];
    let closed = false;
    const watcher = importedWatch(folder, { recursive: false }, (_event, name) => { names.push(name); });
    watcher.on('close', () => { closed = true; });
    try {
      await sleep(200);
      fs.writeFileSync(path.join(folder, 'HEAD'), 'x');
      await sleep(300);
      assert.ok(names.includes('HEAD'));
      assert.equal(closed, false);
      fs.rmSync(folder, { recursive: true });
      for (let waited = 0; !closed && waited < 5000; waited += 50) await sleep(50);
      assert.equal(closed, true);
    } finally {
      watcher.close();
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });
});

const withRepository = async (content, run, gitDirectory = '.git') => {
  const folder = fs.mkdtempSync(path.join(tmpdir(), 'oc-head-'));
  const target = path.join(folder, gitDirectory, 'HEAD');
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (content !== null) fs.writeFileSync(target, content);
    await run(target);
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
};

const replace = (target, content) => {
  fs.writeFileSync(`${target}.lock`, content);
  fs.renameSync(`${target}.lock`, target);
};

const moveAccessTime = (target) => fs.utimesSync(target, new Date(0), fs.statSync(target).mtime);

test('passes the first HEAD event, then tells a read from a branch switch', () => withRepository('ref: refs/heads/main\n', (target) => {
  moveAccessTime(target);
  const unchanged = createHeadGuard({ type: 'file', target }, 'win32');
  assert.equal(unchanged(), false);
  moveAccessTime(target);
  assert.equal(unchanged(), true);
  replace(target, 'ref: refs/heads/next\n');
  assert.equal(unchanged(), false);
  assert.equal(unchanged(), true);
  fs.rmSync(target);
  assert.equal(unchanged(), false);
  fs.writeFileSync(target, 'ref: refs/heads/main\n');
  assert.equal(unchanged(), false);
  assert.equal(unchanged(), true);
}));

test('starts guarding a HEAD created later and stops once the repository moves to reftable', () => withRepository(null, (target) => {
  const unchanged = createHeadGuard({ type: 'file', target }, 'win32');
  assert.equal(unchanged(), false);
  fs.writeFileSync(target, 'ref: refs/heads/main\n');
  assert.equal(unchanged(), false);
  assert.equal(unchanged(), true);
  replace(target, 'ref: refs/heads/.invalid\n');
  assert.equal(unchanged(), false);
  assert.equal(unchanged(), false);
}));

test('guards only a Git HEAD watched as a file on Windows', async () => {
  await withRepository('ref: refs/heads/main\n', (target) => {
    assert.equal(createHeadGuard({ type: 'file', target }, 'linux'), undefined);
    assert.equal(createHeadGuard({ type: 'entries', target }, 'win32'), undefined);
  });
  await withRepository('instructions\n', (target) => {
    assert.equal(createHeadGuard({ type: 'file', target }, 'win32'), undefined);
  }, 'docs');
});
