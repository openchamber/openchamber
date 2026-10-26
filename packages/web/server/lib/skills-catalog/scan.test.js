import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { scanSkillsRepository } from './scan.js';

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
      'other/delta',
      'plugins/bundle/skills/gamma',
      'skills/alpha',
      'skills/beta',
    ]);
  });
});
