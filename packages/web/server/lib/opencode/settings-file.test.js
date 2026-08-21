import { describe, expect, it, vi } from 'vitest';

import { readJsonFileWithBackup, readJsonFileWithBackupSync } from './settings-file.js';

describe('settings backup reads', () => {
  it('uses the backup when the canonical file is unavailable', async () => {
    const readFile = vi.fn(async (filePath) => {
      if (filePath.endsWith('.backup')) return '{"theme":"old"}';
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    });

    await expect(readJsonFileWithBackup({ readFile }, 'settings.json')).resolves.toEqual({ theme: 'old' });
  });

  it('uses the backup when the canonical file is missing', () => {
    const readFileSync = vi.fn((filePath) => {
      if (filePath.endsWith('.backup')) return '{"theme":"old"}';
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    });

    expect(readJsonFileWithBackupSync({ readFileSync }, 'settings.json')).toEqual({ theme: 'old' });
  });

  it('does not hide a malformed recovery backup as a missing canonical file', async () => {
    const readFile = vi.fn(async (filePath) => {
      if (filePath.endsWith('.backup')) return '{';
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    });

    await expect(readJsonFileWithBackup({ readFile }, 'settings.json')).rejects.toBeInstanceOf(SyntaxError);
  });
});
