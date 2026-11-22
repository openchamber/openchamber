import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { readSpaceSettingFile } from './space-setting-file.js';

const schema = z.object({ mode: z.enum(['auto', 'manual']) });
const isWindows = process.platform === 'win32';

let dir;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'space-setting-file-'));
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const writeFile = (name, content) => {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, content);
  return filePath;
};

describe('readSpaceSettingFile (#1659)', () => {
  it('returns the schema-parsed value for a valid file under 1 KiB', async () => {
    const filePath = writeFile('valid.json', JSON.stringify({ mode: 'auto' }));
    await expect(readSpaceSettingFile(filePath, schema)).resolves.toEqual({ mode: 'auto' });
  });

  it('answers null for a missing file', async () => {
    await expect(readSpaceSettingFile(path.join(dir, 'absent.json'), schema)).resolves.toBeNull();
  });

  it('answers null for a file over the 1 KiB cap', async () => {
    const filePath = writeFile('big.json', JSON.stringify({ mode: 'auto', pad: 'x'.repeat(2048) }));
    await expect(readSpaceSettingFile(filePath, schema)).resolves.toBeNull();
  });

  it('answers null for unparseable and schema-rejecting files', async () => {
    await expect(readSpaceSettingFile(writeFile('junk.json', 'not json'), schema)).resolves.toBeNull();
    await expect(readSpaceSettingFile(writeFile('wrong.json', JSON.stringify({ mode: 'sideways' })), schema)).resolves.toBeNull();
  });

  it.skipIf(isWindows)('answers null promptly for a FIFO, with no writer', async () => {
    const fifoPath = path.join(dir, 'fifo.json');
    execFileSync('mkfifo', [fifoPath]);
    await expect(readSpaceSettingFile(fifoPath, schema)).resolves.toBeNull();
  });

  it.skipIf(isWindows)('answers null for a symlink, judged at open rather than followed', async () => {
    const target = writeFile('target.json', JSON.stringify({ mode: 'manual' }));
    const linkPath = path.join(dir, 'link.json');
    fs.symlinkSync(target, linkPath);
    await expect(readSpaceSettingFile(linkPath, schema)).resolves.toBeNull();
  });
});
