import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { isGitOutputTooLarge, readSkillMdFile, SKILL_MD_MAX_BYTES } from './scan.js';

const tempDirs = [];

async function writeTempSkillMd(content) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'openchamber-scan-test-'));
  tempDirs.push(dir);
  const filePath = path.join(dir, 'SKILL.md');
  await fs.promises.writeFile(filePath, content);
  return filePath;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.promises.rm(dir, { recursive: true, force: true })));
});

describe('readSkillMdFile', () => {
  it('reads a normal SKILL.md from disk', async () => {
    const filePath = await writeTempSkillMd('---\nname: demo\n---\nbody');
    const result = await readSkillMdFile(filePath);
    expect(result.tooLarge).toBe(false);
    expect(result.content).toContain('name: demo');
  });

  it('reads a SKILL.md exactly at the cap', async () => {
    const filePath = await writeTempSkillMd('a'.repeat(SKILL_MD_MAX_BYTES));
    const result = await readSkillMdFile(filePath);
    expect(result.tooLarge).toBe(false);
    expect(result.content.length).toBe(SKILL_MD_MAX_BYTES);
  });

  it('never buffers a SKILL.md over the cap', async () => {
    const filePath = await writeTempSkillMd('a'.repeat(SKILL_MD_MAX_BYTES + 1));
    const result = await readSkillMdFile(filePath);
    expect(result.tooLarge).toBe(true);
    expect(result.content).toBe('');
  });

  it('rejects a SKILL.md that is not a regular file (symlink to a device)', async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'openchamber-scan-test-'));
    tempDirs.push(dir);
    const filePath = path.join(dir, 'SKILL.md');
    await fs.promises.symlink('/dev/null', filePath);
    await expect(readSkillMdFile(filePath)).rejects.toThrow('not a regular file');
  });

  it('reads a SKILL.md through a symlink to a regular file', async () => {
    const target = await writeTempSkillMd('---\nname: linked\n---\nbody');
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'openchamber-scan-test-'));
    tempDirs.push(dir);
    const filePath = path.join(dir, 'SKILL.md');
    await fs.promises.symlink(target, filePath);
    const result = await readSkillMdFile(filePath);
    expect(result.tooLarge).toBe(false);
    expect(result.content).toContain('name: linked');
  });

  it('rejects a SKILL.md that is a FIFO without blocking on open', async () => {
    if (process.platform === 'win32') return;
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'openchamber-scan-test-'));
    tempDirs.push(dir);
    const filePath = path.join(dir, 'SKILL.md');
    await promisify(execFile)('mkfifo', [filePath]);
    await expect(readSkillMdFile(filePath)).rejects.toThrow('not a regular file');
  });

  it('classifies a git-show maxBuffer failure as too large, not a read failure', () => {
    expect(isGitOutputTooLarge({ message: 'stdout maxBuffer length exceeded' })).toBe(true);
    expect(isGitOutputTooLarge({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', message: '' })).toBe(true);
    expect(isGitOutputTooLarge({ message: 'fatal: path does not exist' })).toBe(false);
    expect(isGitOutputTooLarge(null)).toBe(false);
  });

  it('throws for a missing file so the caller can fall back to git show', async () => {
    await expect(readSkillMdFile(path.join(os.tmpdir(), 'openchamber-scan-test-missing', 'SKILL.md'))).rejects.toThrow();
  });
});
