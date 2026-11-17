import { afterAll, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deleteLegacyOpenCodeGoCredential, deleteQuotaCredential, readQuotaCredential, writeQuotaCredential } from './store.js';

const previousDataDir = process.env.OPENCHAMBER_DATA_DIR;
const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-quota-store-'));
process.env.OPENCHAMBER_DATA_DIR = temporaryDirectory;

describe('quota credential store', () => {
  it('uses owner-only permissions and rejects arbitrary provider paths', () => {
    writeQuotaCredential('exe-dev', { usageToken: 'secret' });
    writeQuotaCredential('zenmux', { platformApiKey: 'secret' });
    expect(fs.statSync(path.join(temporaryDirectory, 'quota')).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(temporaryDirectory, 'quota', 'exe-dev.json')).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(temporaryDirectory, 'quota', 'zenmux.json')).mode & 0o777).toBe(0o600);
    expect(readQuotaCredential('exe-dev', (value) => value)).toEqual({ usageToken: 'secret' });
    expect(readQuotaCredential('zenmux', (value) => value)).toEqual({ platformApiKey: 'secret' });
    expect(() => writeQuotaCredential('../escape', {})).toThrow('Unsupported credential provider');
    deleteQuotaCredential('exe-dev');
    deleteQuotaCredential('zenmux');
  });

  it.runIf(process.platform !== 'win32')('leaves an existing directory with the permissions it already has', () => {
    const directory = path.join(temporaryDirectory, 'quota');
    fs.mkdirSync(directory, { recursive: true });
    fs.chmodSync(directory, 0o750);
    writeQuotaCredential('exe-dev', { usageToken: 'secret' });
    expect(fs.statSync(directory).mode & 0o777).toBe(0o750);
    expect(fs.statSync(path.join(directory, 'exe-dev.json')).mode & 0o777).toBe(0o600);
    deleteQuotaCredential('exe-dev');
    fs.chmodSync(directory, 0o700);
  });

  it('reads a missing credential as null and a corrupt one as warned null', () => {
    expect(readQuotaCredential('cursor', (value) => value)).toBeNull();
    const corruptPath = path.join(temporaryDirectory, 'quota', 'cursor.json');
    fs.mkdirSync(path.dirname(corruptPath), { recursive: true });
    fs.writeFileSync(corruptPath, '{not valid json', { mode: 0o600 });
    expect(readQuotaCredential('cursor', (value) => value)).toBeNull();
    fs.rmSync(corruptPath);
  });

  it('refuses an over-cap credential file instead of buffering it whole (#1613)', () => {
    const bigPath = path.join(temporaryDirectory, 'quota', 'cursor.json');
    fs.mkdirSync(path.dirname(bigPath), { recursive: true });
    fs.writeFileSync(bigPath, JSON.stringify({ usageToken: 'x'.repeat(128 * 1024) }), { mode: 0o600 });
    expect(readQuotaCredential('cursor', (value) => value)).toBeNull();
    fs.rmSync(bigPath);
  });

  it.runIf(process.platform !== 'win32')('refuses a FIFO credential path promptly instead of blocking (#1613)', () => {
    const fifoPath = path.join(temporaryDirectory, 'quota', 'cursor.json');
    fs.mkdirSync(path.dirname(fifoPath), { recursive: true });
    execFileSync('mkfifo', [fifoPath]);
    expect(readQuotaCredential('cursor', (value) => value)).toBeNull();
    fs.rmSync(fifoPath);
  });

  it('removes the obsolete OpenCode Go credential without parsing it', () => {
    const legacyPath = path.join(temporaryDirectory, 'quota', 'opencode-go.json');
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(legacyPath, '{not valid json', { mode: 0o600 });
    deleteLegacyOpenCodeGoCredential();
    expect(fs.existsSync(legacyPath)).toBe(false);
  });
});

afterAll(() => {
  if (previousDataDir === undefined) delete process.env.OPENCHAMBER_DATA_DIR;
  else process.env.OPENCHAMBER_DATA_DIR = previousDataDir;
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});
