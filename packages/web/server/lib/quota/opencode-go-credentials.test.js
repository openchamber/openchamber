import { afterAll, afterEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deleteOpenCodeGoCredential, getOpenCodeGoCredentialStatus, readOpenCodeGoCredential, writeOpenCodeGoCredential } from './opencode-go-credentials.js';

const previousDataDir = process.env.OPENCHAMBER_DATA_DIR;
const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-go-'));
process.env.OPENCHAMBER_DATA_DIR = temporaryDirectory;

afterEach(() => deleteOpenCodeGoCredential());

describe('OpenCode Go credential store', () => {
  it('normalizes, masks, and stores credentials with owner-only permissions', () => {
    const status = writeOpenCodeGoCredential({ workspaceId: ' wrk_test ', authCookie: ' auth=secret ' });
    expect(status).toEqual({ configured: true, workspaceId: 'wrk_test', secretMasked: '••••••••' });
    expect(readOpenCodeGoCredential()).toEqual({ workspaceId: 'wrk_test', authCookie: 'secret' });
    expect(fs.statSync(path.join(temporaryDirectory, 'quota', 'opencode-go.json')).mode & 0o777).toBe(0o600);
  });

  it('removes credentials without exposing prior values', () => {
    writeOpenCodeGoCredential({ workspaceId: 'wrk_test', authCookie: 'secret' });
    deleteOpenCodeGoCredential();
    expect(getOpenCodeGoCredentialStatus()).toEqual({ configured: false });
  });
});

afterAll(() => {
  if (previousDataDir === undefined) delete process.env.OPENCHAMBER_DATA_DIR;
  else process.env.OPENCHAMBER_DATA_DIR = previousDataDir;
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});
