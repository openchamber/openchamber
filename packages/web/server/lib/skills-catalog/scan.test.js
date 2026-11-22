import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, afterAll, beforeAll } from 'vitest';
import { isGitOutputTooLarge, readSkillMdFile, SKILL_MD_MAX_BYTES, scanSkillsRepository } from './scan.js';
import { execFileSync } from 'node:child_process';


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

// ---- upstream tests ----

const GIT_ENV_KEYS = ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0'];
const savedEnv = {};
let root;

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=lab', '-c', 'user.email=lab@example.com', ...args], { cwd, stdio: 'pipe' });

const writeSkill = (repoDir, skillDir) => {
  const dir = path.join(repoDir, ...skillDir.split('/'));
  fs.mkdirSync(dir, { recursive: true });
  const name = path.posix.basename(skillDir);
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} skill\n---\nBody\n`);
};

// A local bare repository stands in for github.com/acme/skills: Git rewrites
// the clone URL through the environment, and the partial clone fetches its
// blobs from it the way it would from GitHub.
beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-scan-fixture-'));
  const work = path.join(root, 'work');
  fs.mkdirSync(work);
  git(work, 'init', '-q');
  for (const skillDir of ['skills/alpha', 'skills/beta', 'plugins/bundle/skills/gamma', 'other/delta']) {
    writeSkill(work, skillDir);
  }
  for (const [name, metadata] of [['scalar', 'plain text'], ['loose', 'name: 42\ndescription: [unchecked]']]) {
    const dir = path.join(work, 'metadata', name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\n${metadata}\n---\nBody\n`);
  }
  git(work, 'add', '.');
  git(work, 'commit', '-qm', 'skills');
  const bare = path.join(root, 'remote', 'acme', 'skills.git');
  git(root, 'clone', '-q', '--bare', work, bare);
  git(bare, 'config', 'uploadpack.allowFilter', 'true');

  for (const key of GIT_ENV_KEYS) savedEnv[key] = process.env[key];
  process.env.GIT_CONFIG_COUNT = '1';
  process.env.GIT_CONFIG_KEY_0 = `url.${new URL(`file://${path.join(root, 'remote')}/`).href}.insteadOf`;
  process.env.GIT_CONFIG_VALUE_0 = 'https://github.com/';
});

afterAll(() => {
  for (const key of GIT_ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  fs.rmSync(root, { recursive: true, force: true });
});

describe('scanSkillsRepository', () => {
  it('leaves scalar and non-string YAML metadata unset without adding warnings', async () => {
    const result = await scanSkillsRepository({ source: 'acme/skills', subpath: 'metadata' });

    expect(result.ok).toBe(true);
    expect(result.items).toHaveLength(2);
    for (const item of result.items) {
      expect(item.frontmatterName).toBeUndefined();
      expect(item.description).toBeUndefined();
      expect(item.warnings).toBeUndefined();
    }
  });

  it('lists only the skills under the source subpath', async () => {
    const result = await scanSkillsRepository({ source: 'acme/skills', defaultSubpath: 'skills' });

    expect(result.ok).toBe(true);
    expect(result.items.map((item) => item.skillDir)).toEqual(['skills/alpha', 'skills/beta']);
    expect(result.items.map((item) => item.description)).toEqual(['alpha skill', 'beta skill']);
    expect(result.items.every((item) => item.warnings === undefined)).toBe(true);
  });

  it('lists every skill of the repository without a subpath', async () => {
    const result = await scanSkillsRepository({ source: 'acme/skills' });

    expect(result.ok).toBe(true);
    expect(result.items.map((item) => item.skillDir).sort()).toEqual([
      'metadata/loose',
      'metadata/scalar',
      'other/delta',
      'plugins/bundle/skills/gamma',
      'skills/alpha',
      'skills/beta',
    ]);
  });
});
