import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { removeDirectory, removeStaleCatalogFolders } from './remove-directory.js';

const busy = () => Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
const noWait = async () => {};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('removeDirectory', () => {
  it('removes the folder and its files', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-remove-test-'));
    fs.mkdirSync(path.join(dir, '.git', 'objects', 'pack'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.git', 'objects', 'pack', 'a.pack'), 'x', { mode: 0o444 });

    await removeDirectory(dir);

    expect(fs.existsSync(dir)).toBe(false);
  });

  it('tries again while a file is held for a moment', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const waits = [];
    let calls = 0;
    const rm = async () => {
      calls += 1;
      if (calls < 3) throw busy();
    };

    await removeDirectory('/tmp/held', { rm, sleep: async (ms) => { waits.push(ms); } });

    expect(calls).toBe(3);
    expect(waits).toEqual([250, 500]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('gives up after five attempts and logs the folder it left', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let calls = 0;
    const rm = async () => {
      calls += 1;
      throw busy();
    };

    await removeDirectory('/tmp/held-for-good', { rm, sleep: noWait });

    expect(calls).toBe(5);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('/tmp/held-for-good');
  });

  it('names the folder it left through the given warn', async () => {
    const lines = [];
    const rm = async () => {
      throw busy();
    };

    await removeDirectory('/tmp/held-for-good', { rm, sleep: noWait, warn: (line) => lines.push(line) });

    expect(lines).toEqual(['[skills-catalog] Failed to remove /tmp/held-for-good: EBUSY: resource busy or locked']);
  });
});

describe('removeStaleCatalogFolders', () => {
  const minutesAgo = (now, minutes) => new Date(now - minutes * 60_000);
  let tmpDir;

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const makeFolder = (name, ageMinutes, now) => {
    const dir = path.join(tmpDir, name);
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref');
    const time = minutesAgo(now, ageMinutes);
    fs.utimesSync(dir, time, time);
    return dir;
  };

  it('removes catalog clones older than an hour and keeps everything else', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-sweep-test-'));
    const now = Date.now();
    makeFolder('openchamber-skills-scan-old1', 90, now);
    makeFolder('openchamber-skills-install-old2', 61, now);
    makeFolder('openchamber-vscode-skills-scan-old3', 200, now);
    makeFolder('openchamber-vscode-skills-install-old4', 120, now);
    makeFolder('openchamber-vscode-skills-scan-fresh', 50, now);
    makeFolder('openchamber-vscode-bridge-config-old', 60, now);
    makeFolder('someone-elses-folder', 60, now);
    fs.writeFileSync(path.join(tmpDir, 'openchamber-skills-scan-file'), 'x');
    fs.utimesSync(path.join(tmpDir, 'openchamber-skills-scan-file'), minutesAgo(now, 60), minutesAgo(now, 60));

    await removeStaleCatalogFolders({ tmpDir, now });

    expect(fs.readdirSync(tmpDir).sort()).toEqual([
      'openchamber-skills-scan-file',
      'openchamber-vscode-bridge-config-old',
      'openchamber-vscode-skills-scan-fresh',
      'someone-elses-folder',
    ]);
  });

  it('never follows a link with a catalog name', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-sweep-test-'));
    const now = Date.now();
    const target = makeFolder('kept-target', 60, now);
    fs.symlinkSync(target, path.join(tmpDir, 'openchamber-skills-scan-link'), 'dir');

    await removeStaleCatalogFolders({ tmpDir, now: now + 120 * 60_000 });

    expect(fs.existsSync(path.join(target, '.git', 'HEAD'))).toBe(true);
    expect(fs.lstatSync(path.join(tmpDir, 'openchamber-skills-scan-link')).isSymbolicLink()).toBe(true);
  });

  it('leaves folders another user owns', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-sweep-test-'));
    const now = Date.now();
    makeFolder('openchamber-skills-scan-theirs', 90, now);
    const ownUid = fs.lstatSync(tmpDir).uid;

    await removeStaleCatalogFolders({ tmpDir, now, uid: ownUid + 1 });

    expect(fs.readdirSync(tmpDir)).toEqual(['openchamber-skills-scan-theirs']);
  });

  it('keeps going past a folder that is still held', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-sweep-test-'));
    const now = Date.now();
    const held = makeFolder('openchamber-vscode-skills-scan-held', 90, now);
    makeFolder('openchamber-vscode-skills-scan-free', 90, now);
    const rm = async (dir, options) => {
      if (dir === held) throw busy();
      await fs.promises.rm(dir, options);
    };

    await removeStaleCatalogFolders({ tmpDir, now, rm });

    expect(fs.readdirSync(tmpDir)).toEqual(['openchamber-vscode-skills-scan-held']);
  });
});
