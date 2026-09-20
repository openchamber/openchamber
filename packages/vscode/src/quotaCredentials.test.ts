import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// quotaCredentials.ts resolves the data directory from OPENCHAMBER_DATA_DIR on
// every call, so pointing it at a temp root keeps the real config untouched.
const withTempQuotaDirectory = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-vscode-quota-permissions-'));
  const previousDataDir = process.env.OPENCHAMBER_DATA_DIR;
  process.env.OPENCHAMBER_DATA_DIR = root;
  return {
    quotaDir: path.join(root, 'quota'),
    restore: () => {
      if (previousDataDir === undefined) {
        delete process.env.OPENCHAMBER_DATA_DIR;
      } else {
        process.env.OPENCHAMBER_DATA_DIR = previousDataDir;
      }
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
};

describe('VS Code writeCredential directory permissions', () => {
  it('applies 0700 only on directory creation', { skip: process.platform === 'win32' }, async () => {
    const quotaCredentialStore = await import('./quotaCredentials');
    const { quotaDir, restore } = withTempQuotaDirectory();
    try {
      quotaCredentialStore.writeCredential('exe-dev', { usageToken: 'secret' });

      assert.equal(fs.statSync(quotaDir).mode & 0o777, 0o700);
      assert.equal(fs.statSync(path.join(quotaDir, 'exe-dev.json')).mode & 0o777, 0o600);
    } finally {
      restore();
    }
  });

  it('preserves a pre-existing quota directory mode across writes', { skip: process.platform === 'win32' }, async () => {
    const quotaCredentialStore = await import('./quotaCredentials');
    const { quotaDir, restore } = withTempQuotaDirectory();
    try {
      fs.mkdirSync(quotaDir, { recursive: true });
      fs.chmodSync(quotaDir, 0o770);

      quotaCredentialStore.writeCredential('exe-dev', { usageToken: 'secret' });
      assert.equal(fs.statSync(quotaDir).mode & 0o777, 0o770);

      quotaCredentialStore.writeCredential('exe-dev', { usageToken: 'rotated' });
      assert.equal(fs.statSync(quotaDir).mode & 0o777, 0o770);
    } finally {
      restore();
    }
  });
});
