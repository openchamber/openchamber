import { afterAll, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deleteQuotaCredential, readQuotaCredential, writeQuotaCredential } from './store.js';

const previousDataDir = process.env.OPENCHAMBER_DATA_DIR;
const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-quota-store-'));
process.env.OPENCHAMBER_DATA_DIR = temporaryDirectory;

describe('quota credential store', () => {
  it('uses owner-only permissions and rejects arbitrary provider paths', () => {
    writeQuotaCredential('ollama-cloud', { cookie: 'secret' });
    expect(fs.statSync(path.join(temporaryDirectory, 'quota')).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(temporaryDirectory, 'quota', 'ollama-cloud.json')).mode & 0o777).toBe(0o600);
    expect(readQuotaCredential('ollama-cloud', (value) => value)).toEqual({ cookie: 'secret' });
    expect(() => writeQuotaCredential('../escape', {})).toThrow('Unsupported credential provider');
    deleteQuotaCredential('ollama-cloud');
  });
});

afterAll(() => {
  if (previousDataDir === undefined) delete process.env.OPENCHAMBER_DATA_DIR;
  else process.env.OPENCHAMBER_DATA_DIR = previousDataDir;
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});
