import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { resolveRepositoryIdentity } from './repository-identity.js';

const ROUNDS = 500;
const root = () => fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-stress-'));
const git = (directory, args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
let base;

beforeEach(() => {
  base = root();
  const globalConfig = path.join(base, 'global.gitconfig');
  fs.writeFileSync(globalConfig, '');
  vi.stubEnv('GIT_CONFIG_GLOBAL', globalConfig);
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
  vi.stubEnv('OPENCHAMBER_DATA_DIR', path.join(base, 'data'));
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(base, { recursive: true, force: true });
});

it(`replaces a bare repository ${ROUNDS} times without an unverifiable identity`, async () => {
  const failures = [];
  const started = Date.now();
  for (let round = 0; round < ROUNDS; round += 1) {
    const repository = path.join(base, `repo-${round}`);
    fs.mkdirSync(repository);
    try {
      git(repository, ['init', '--bare']);
      const bare = await resolveRepositoryIdentity(repository);
      fs.renameSync(repository, path.join(base, `old-${round}`));
      fs.mkdirSync(repository);
      git(repository, ['init', '--bare']);
      const replacement = await resolveRepositoryIdentity(repository);
      if (replacement.repositoryId === bare.repositoryId) failures.push(`${round}: same id`);
    } catch (error) {
      failures.push(`${round}: ${error.code ?? ''} ${error.message}`);
    }
  }
  process.stderr.write(`STRESS rounds=${ROUNDS} failures=${failures.length} elapsedMs=${Date.now() - started}\n`);
  if (failures.length) process.stderr.write(`STRESS failed rounds:\n${failures.join("\n")}\n`);
  expect(failures).toEqual([]);
}, 600_000);
