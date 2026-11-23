import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { compareHandoffVersions, consumeHandoffRequest, getHandoffRequestPath, resolveHandoffTarget, writeHandoffRequest } from './handoff-request.js';

const roots = [];
const tempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-handoff-'));
  roots.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const makeInstall = (root, version = '2.6.0') => {
  const packageDir = path.join(root, 'packages', 'web');
  const binDir = path.join(packageDir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ name: '@openchamber/web', version }));
  const entry = path.join(binDir, 'cli.js');
  fs.writeFileSync(entry, '');
  return entry;
};

describe('handoff request file', () => {
  it('atomically writes and consumes one fresh request from a live requester', () => {
    const dataDir = tempDir();
    const request = writeHandoffRequest({ dataDir, requesterPid: 77, entry: '/new/cli.js', execPath: '/node', version: '2.6.0', now: () => 1000 });
    expect(request.requestedAt).toBe(1000);
    expect(consumeHandoffRequest({ dataDir, now: () => 1001, kill: () => true })).toEqual({ ...request, allowDowngrade: false });
    expect(fs.existsSync(getHandoffRequestPath(dataDir))).toBe(false);
  });

  it('does not delete a newer request published between read and cleanup', () => {
    const dataDir = tempDir();
    const older = writeHandoffRequest({ dataDir, requesterPid: 77, entry: '/old/cli.js', execPath: '/node', version: '2.6.0', now: () => 1000 });
    const originalReadFileSync = fs.readFileSync;
    let republished = false;
    fs.readFileSync = (...args) => {
      const bytes = originalReadFileSync(...args);
      if (!republished && String(args[0]).includes('handoff-request')) {
        republished = true;
        // A newer CLI invocation atomically replaces the request path while
        // the consumer still holds the older request's bytes; the older
        // consume's cleanup must not unlink the newer request.
        writeHandoffRequest({ dataDir, requesterPid: 78, entry: '/new/cli.js', execPath: '/node', version: '2.6.0', now: () => 1002 });
      }
      return bytes;
    };
    try {
      expect(consumeHandoffRequest({ dataDir, now: () => 1003, kill: () => true })).toEqual({ ...older, allowDowngrade: false });
    } finally {
      fs.readFileSync = originalReadFileSync;
    }
    expect(republished).toBe(true);
    const next = consumeHandoffRequest({ dataDir, now: () => 1004, kill: () => true });
    expect(next?.entry).toBe('/new/cli.js');
    expect(fs.existsSync(getHandoffRequestPath(dataDir))).toBe(false);
  });

  it('discards stale, malformed, and dead-requester records', () => {
    const dataDir = tempDir();
    const writeRaw = (value) => {
      const filePath = getHandoffRequestPath(dataDir);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(value));
    };
    const base = { requesterPid: 77, entry: '/new/cli.js', execPath: '/node', version: '2.6.0', requestedAt: 1000 };
    writeRaw(base);
    expect(consumeHandoffRequest({ dataDir, now: () => 61_000, kill: () => true })).toBeNull();
    writeRaw(base);
    expect(consumeHandoffRequest({ dataDir, now: () => 1001, kill: () => { const error = new Error(); error.code = 'ESRCH'; throw error; } })).toBeNull();
    writeRaw({ ...base, requesterPid: '77' });
    expect(consumeHandoffRequest({ dataDir, now: () => 1001, kill: () => true })).toBeNull();
    expect(fs.existsSync(getHandoffRequestPath(dataDir))).toBe(false);
  });
});

describe('handoff target resolution', () => {
  it('validates the installed package and refuses downgrades unless explicitly allowed', () => {
    const root = tempDir();
    const entry = makeInstall(root, '2.6.0');
    const request = { entry, execPath: process.execPath, version: '2.6.0', allowDowngrade: false };
    expect(resolveHandoffTarget({ request, runningVersion: '2.5.0' })).toEqual({ ok: true, entry, execPath: process.execPath, version: '2.6.0' });
    expect(resolveHandoffTarget({ request: { ...request, version: '2.4.0' }, runningVersion: '2.5.0' })).toEqual({ ok: false, reason: 'entry-invalid' });
    expect(resolveHandoffTarget({ request, runningVersion: '2.7.0' })).toEqual({ ok: false, reason: 'downgrade-refused' });
    expect(resolveHandoffTarget({ request: { ...request, allowDowngrade: true }, runningVersion: '2.7.0' }).ok).toBe(true);
  });

  it('rejects non-OpenChamber packages and missing executables', () => {
    const root = tempDir();
    const entry = makeInstall(root);
    const request = { entry, execPath: path.join(root, 'missing-node'), version: '2.6.0' };
    expect(resolveHandoffTarget({ request, runningVersion: '2.5.0' })).toEqual({ ok: false, reason: 'entry-invalid' });
    fs.writeFileSync(path.join(root, 'packages', 'web', 'package.json'), JSON.stringify({ name: 'not-openchamber', version: '2.6.0' }));
    expect(resolveHandoffTarget({ request: { ...request, execPath: process.execPath }, runningVersion: '2.5.0' })).toEqual({ ok: false, reason: 'entry-invalid' });
  });

  it('compares valid semver including prereleases and rejects malformed versions', () => {
    expect(compareHandoffVersions('2.0.0-rc.2', '2.0.0-rc.10')).toBe(-1);
    expect(compareHandoffVersions('2.0.0', '2.0.0-rc.10')).toBe(1);
    expect(compareHandoffVersions('latest', '2.0.0')).toBeNull();
  });
});
