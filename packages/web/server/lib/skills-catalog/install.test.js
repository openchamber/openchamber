import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { copyDirectoryNoSymlinks, installSkillsFromRepository, SKILL_COPY_MAX_ENTRIES, SKILL_COPY_MAX_TOTAL_BYTES } from './install.js';

const WIN = process.platform === 'win32';

const tempDirs = [];
const makeTemp = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const writeSkill = (dir, name) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name}\n---\nbody\n`);
};

describe('copyDirectoryNoSymlinks containment', () => {
  it('copies a real skill directory inside the clone', async () => {
    const clone = makeTemp('oc-clone-');
    const src = path.join(clone, 'skills', 'good');
    writeSkill(src, 'good');
    fs.writeFileSync(path.join(src, 'extra.txt'), 'extra');
    const dst = path.join(makeTemp('oc-dst-'), 'good');

    await copyDirectoryNoSymlinks(src, dst, clone);

    expect(fs.readFileSync(path.join(dst, 'SKILL.md'), 'utf8')).toContain('name: good');
    expect(fs.readFileSync(path.join(dst, 'extra.txt'), 'utf8')).toBe('extra');
  });

  it.skipIf(WIN)('refuses a selected directory that is a symlink to outside the clone', async () => {
    const clone = makeTemp('oc-clone-');
    const outside = makeTemp('oc-outside-');
    writeSkill(outside, 'evil');
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
    fs.mkdirSync(path.join(clone, 'skills'), { recursive: true });
    fs.symlinkSync(outside, path.join(clone, 'skills', 'evil'));
    const dst = path.join(makeTemp('oc-dst-'), 'evil');

    await expect(copyDirectoryNoSymlinks(path.join(clone, 'skills', 'evil'), dst, clone))
      .rejects.toThrow('Symlinks are not supported in skills');

    expect(fs.existsSync(dst)).toBe(false);
  });

  it.skipIf(WIN)('refuses a selected directory behind a symlinked component', async () => {
    const clone = makeTemp('oc-clone-');
    const outside = makeTemp('oc-outside-');
    writeSkill(path.join(outside, 'pack'), 'evil');
    fs.mkdirSync(path.join(clone, 'skills'), { recursive: true });
    fs.symlinkSync(outside, path.join(clone, 'skills', 'evil'));
    const dst = path.join(makeTemp('oc-dst-'), 'pack');

    await expect(copyDirectoryNoSymlinks(path.join(clone, 'skills', 'evil', 'pack'), dst, clone))
      .rejects.toThrow('Symlinks are not supported in skills');

    expect(fs.existsSync(path.join(dst, 'SKILL.md'))).toBe(false);
  });

  it.skipIf(WIN)('keeps refusing a symlink below the selected directory', async () => {
    const clone = makeTemp('oc-clone-');
    const src = path.join(clone, 'skills', 'good');
    writeSkill(src, 'good');
    fs.symlinkSync(makeTemp('oc-outside-'), path.join(src, 'link'));
    const dst = path.join(makeTemp('oc-dst-'), 'good');

    await expect(copyDirectoryNoSymlinks(src, dst, clone)).rejects.toThrow('Symlinks are not supported in skills');
  });

  it('refuses a source outside the clone, even one sharing the clone prefix', async () => {
    const parent = makeTemp('oc-parent-');
    const clone = path.join(parent, 'clone');
    const sibling = path.join(parent, 'clone-evil');
    writeSkill(path.join(sibling, 'x'), 'evil');
    fs.mkdirSync(clone, { recursive: true });
    const dst = path.join(makeTemp('oc-dst-'), 'x');

    await expect(copyDirectoryNoSymlinks(path.join(sibling, 'x'), dst, clone))
      .rejects.toThrow('Invalid source path traversal detected');

    expect(fs.existsSync(path.join(dst, 'SKILL.md'))).toBe(false);
  });
});

describe('copyDirectoryNoSymlinks size caps', () => {
  const setupClone = () => {
    const clone = makeTemp('oc-clone-');
    const src = path.join(clone, 'skills', 'big');
    fs.mkdirSync(src, { recursive: true });
    return { clone, src, dst: path.join(makeTemp('oc-dst-'), 'big') };
  };

  it('aborts when the tree has more entries than the cap, directories included', async () => {
    const { clone, src, dst } = setupClone();
    // Empty directories count: a tree of them is the same unbounded copy as a
    // tree of files, and this is the shape the 20,000-directory probe took.
    for (let index = 0; index < SKILL_COPY_MAX_ENTRIES + 1; index += 1) {
      fs.mkdirSync(path.join(src, `d${index}`));
    }

    await expect(copyDirectoryNoSymlinks(src, dst, clone))
      .rejects.toThrow(`more than ${SKILL_COPY_MAX_ENTRIES} entries`);
  });

  it('aborts on a file above the per-file limit', async () => {
    const { clone, src, dst } = setupClone();
    writeSkill(src, 'big');
    fs.writeFileSync(path.join(src, 'huge.bin'), Buffer.alloc(1024 * 1024 + 1));

    await expect(copyDirectoryNoSymlinks(src, dst, clone))
      .rejects.toThrow('exceeds the 1048576 byte limit');
  });

  it('installs a SKILL.md up to the 4 MiB limit', async () => {
    const { clone, src, dst } = setupClone();
    writeSkill(src, 'big');
    // 2 MiB SKILL.md: above the 1 MiB supporting-file cap but within the
    // 4 MiB SKILL.md contract.
    fs.writeFileSync(path.join(src, 'SKILL.md'), Buffer.alloc(2 * 1024 * 1024));

    await copyDirectoryNoSymlinks(src, dst, clone);

    expect(fs.statSync(path.join(dst, 'SKILL.md')).size).toBe(2 * 1024 * 1024);
  });

  it('aborts on a SKILL.md above the 4 MiB limit', async () => {
    const { clone, src, dst } = setupClone();
    writeSkill(src, 'big');
    fs.writeFileSync(path.join(src, 'SKILL.md'), Buffer.alloc(4 * 1024 * 1024 + 1));

    await expect(copyDirectoryNoSymlinks(src, dst, clone))
      .rejects.toThrow('exceeds the 4194304 byte limit');
  });

  it('aborts when the tree passes the total-byte cap', async () => {
    const { clone, src, dst } = setupClone();
    writeSkill(src, 'big');
    // Each file is under the per-file limit, so only the running total stops it.
    const chunk = Buffer.alloc(1024 * 1024);
    const files = Math.ceil(SKILL_COPY_MAX_TOTAL_BYTES / chunk.length) + 1;
    for (let index = 0; index < files; index += 1) {
      fs.writeFileSync(path.join(src, `chunk-${index}.bin`), chunk);
    }

    await expect(copyDirectoryNoSymlinks(src, dst, clone))
      .rejects.toThrow(`more than ${SKILL_COPY_MAX_TOTAL_BYTES} bytes`);
  });

  it('copies a tree at the caps completely', async () => {
    const { clone, src, dst } = setupClone();
    writeSkill(src, 'big');
    fs.mkdirSync(path.join(src, 'assets'));
    fs.writeFileSync(path.join(src, 'assets', 'small.txt'), 'ok');

    await copyDirectoryNoSymlinks(src, dst, clone);

    expect(fs.readFileSync(path.join(dst, 'SKILL.md'), 'utf8')).toContain('name: big');
    expect(fs.readFileSync(path.join(dst, 'assets', 'small.txt'), 'utf8')).toBe('ok');
  });
});

describe('install selection path validation', () => {
  it.each([
    ['../outside', 'outside'],
    ['skills/../../outside', 'outside'],
    ['/etc/passwd', 'passwd'],
    ['skills/./evil', 'evil'],
  ])('refuses the unsafe selection %s before cloning', async (skillDir, skillName) => {
    const userSkillDir = path.join(makeTemp('oc-skills-'), 'installed');

    const result = await installSkillsFromRepository({
      source: 'acme/skills',
      scope: 'user',
      userSkillDir,
      selections: [{ skillDir }],
      conflictPolicy: 'overwriteAll',
    });

    expect(result.ok).toBe(true);
    expect(result.installed).toEqual([]);
    expect(result.skipped).toEqual([{ skillName, reason: 'Invalid skill directory path' }]);
    expect(fs.existsSync(userSkillDir)).toBe(false);
  });
});

describe.skipIf(WIN)('installSkillsFromRepository against a real clone', () => {
  // Clones the fixture repo by rewriting the https URL to the local path, the
  // way an ambient `insteadOf` would. No identity means runGit keeps this
  // environment, so the install exercises the real clone and checkout.
  const setup = () => {
    const root = makeTemp('oc-skill-install-');
    const outside = path.join(root, 'outside');
    writeSkill(outside, 'evil');
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');

    const repo = path.join(root, 'repo');
    writeSkill(path.join(repo, 'skills', 'good-skill'), 'good-skill');
    fs.symlinkSync(outside, path.join(repo, 'skills', 'evil-skill'));
    git(repo, ['init', '-q', '-b', 'main']);
    git(repo, ['config', 'user.email', 'test@example.com']);
    git(repo, ['config', 'user.name', 'Test']);
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-qm', 'initial']);

    const gitConfig = path.join(root, 'gitconfig');
    fs.writeFileSync(gitConfig, `[url "${repo}"]\n\tinsteadOf = https://github.com/acme/skills.git\n`);
    return { gitConfig, userSkillDir: path.join(root, 'installed') };
  };

  const withGitConfig = async (gitConfig, run) => {
    const previous = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = gitConfig;
    try {
      return await run();
    } finally {
      if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = previous;
    }
  };

  it('installs a real skill directory from the clone', async () => {
    const { gitConfig, userSkillDir } = setup();

    const result = await withGitConfig(gitConfig, () => installSkillsFromRepository({
      source: 'acme/skills',
      scope: 'user',
      userSkillDir,
      selections: [{ skillDir: 'skills/good-skill' }],
      conflictPolicy: 'overwriteAll',
    }));

    expect(result.ok).toBe(true);
    expect(result.installed.map((entry) => entry.skillName)).toEqual(['good-skill']);
    expect(fs.existsSync(path.join(userSkillDir, 'good-skill', 'SKILL.md'))).toBe(true);
  });

  it('installs nothing from a skill directory that is a symlink outside the clone', async () => {
    const { gitConfig, userSkillDir } = setup();

    const result = await withGitConfig(gitConfig, () => installSkillsFromRepository({
      source: 'acme/skills',
      scope: 'user',
      userSkillDir,
      selections: [{ skillDir: 'skills/evil-skill' }],
      conflictPolicy: 'overwriteAll',
    }));

    expect(result.ok).toBe(true);
    expect(result.installed).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toMatchObject({ skillName: 'evil-skill' });
    expect(result.skipped[0].reason).toMatch(/symlink/i);
    expect(fs.existsSync(path.join(userSkillDir, 'evil-skill'))).toBe(false);
  });
});
