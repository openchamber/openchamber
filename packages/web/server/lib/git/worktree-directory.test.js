import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// A project checkout whose OpenCode config may or may not set
// `worktree.directory`, driven through the real `git` binary and the real config
// reader. The precedence rules and the malformed-versus-unreadable split are
// unit-tested in `worktree-config.test.js`; this file only proves where the
// directory ends up on disk, and that every entry point agrees.

const tempDirs = [];

const originalEnv = {
  OPENCODE_CONFIG: process.env.OPENCODE_CONFIG,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  XDG_DATA_HOME: process.env.XDG_DATA_HOME,
};

const createTempDir = () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-worktree-dir-')));
  tempDirs.push(dir);
  return dir;
};

const runGit = (cwd, args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
};

/**
 * A repository inside a parent of its own. A configured relative folder like
 * `../worktrees` resolves against the repository, so the parent has to be part
 * of this case's temp tree; sharing the OS temp directory would leak worktrees
 * between cases and let a leftover directory change the name picked.
 */
const createCheckout = (name = 'my-app') => {
  const parent = createTempDir();
  const repo = path.join(parent, name);
  fs.mkdirSync(repo, { recursive: true });
  runGit(repo, ['init', '-b', 'main']);
  runGit(repo, ['config', 'user.email', 'test@example.com']);
  runGit(repo, ['config', 'user.name', 'Test User']);
  fs.writeFileSync(path.join(repo, 'README.md'), '# Test\n');
  runGit(repo, ['add', 'README.md']);
  runGit(repo, ['commit', '-m', 'Initial commit']);
  return { parent, repo };
};

/**
 * The git service reads the OpenCode config through a module graph that captures
 * the config directory at import time, so each case reloads it against its own
 * temporary global config rather than the developer's.
 */
const loadGitService = async () => {
  vi.resetModules();
  return import('./service.js');
};

const withEnvironment = async (env, run) => {
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

/** A data dir and a config dir, so a case never reads the developer's real config. */
const withIsolatedRuntimes = async (run) => {
  const dataHome = createTempDir();
  const configHome = createTempDir();
  return withEnvironment(
    { XDG_DATA_HOME: dataHome, XDG_CONFIG_HOME: configHome, OPENCODE_CONFIG: undefined },
    () => run({ dataHome, configDir: path.join(configHome, 'opencode') }),
  );
};

const projectIdOf = (repo) => runGit(repo, ['rev-list', '--max-parents=0', '--all']).trim();

/**
 * Fast create returns before git attaches the worktree and populates it, so a
 * case waits for that background task rather than reading the directory itself.
 */
const settleWorktree = async (git, directory) => {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const status = await git.getWorktreeBootstrapStatus(directory);
    if (status.status !== 'pending') return status;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('worktree bootstrap never settled');
};

const canRunGit = () => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('worktree.directory destination', () => {
  if (!canRunGit()) {
    it.skip('git binary not available', () => {});
    return;
  }

  it('keeps the managed data-dir folder when the setting is absent', async () => {
    await withIsolatedRuntimes(async ({ dataHome, configDir }) => {
      const { repo } = createCheckout();
      const git = await loadGitService();

      expect(fs.existsSync(path.join(configDir, 'opencode.json'))).toBe(false);

      await expect(
        git.validateWorktreeCreate(repo, { mode: 'new', branchName: 'openchamber/feature', worktreeName: 'feature' }),
      ).resolves.toMatchObject({ ok: true });
      await expect(git.previewWorktreeCreate(repo, { mode: 'new', worktreeName: 'feature' })).resolves.toMatchObject({
        name: 'feature',
        path: path.join(dataHome, 'opencode', 'worktree', projectIdOf(repo), 'feature'),
      });

      const created = await git.createWorktree(repo, {
        mode: 'new',
        branchName: 'openchamber/feature',
        worktreeName: 'feature',
      });
      await settleWorktree(git, created.path);

      expect(created.path).toBe(path.join(dataHome, 'opencode', 'worktree', projectIdOf(repo), 'feature'));
      expect(fs.readFileSync(path.join(created.path, 'README.md'), 'utf8')).toBe('# Test\n');
    });
  });

  it('puts a relative folder straight under the parent of the primary checkout', async () => {
    await withIsolatedRuntimes(async () => {
      const { parent, repo } = createCheckout();
      writeJson(path.join(repo, 'opencode.json'), { worktree: { directory: '../worktrees' } });
      const git = await loadGitService();
      const expected = path.join(parent, 'worktrees', 'my-feature');

      await expect(
        git.validateWorktreeCreate(repo, { mode: 'new', branchName: 'openchamber/my-feature', worktreeName: 'my-feature' }),
      ).resolves.toMatchObject({ ok: true });
      await expect(git.previewWorktreeCreate(repo, { mode: 'new', worktreeName: 'my-feature' })).resolves.toEqual({
        name: 'my-feature',
        branch: 'openchamber/my-feature',
        path: expected,
      });

      const created = await git.createWorktree(repo, {
        mode: 'new',
        branchName: 'openchamber/my-feature',
        worktreeName: 'my-feature',
      });
      await settleWorktree(git, created.path);

      expect(created.path).toBe(expected);
      // Only the worktree name is appended: no project-id folder in between.
      expect(fs.readdirSync(path.join(parent, 'worktrees'))).toEqual(['my-feature']);
      expect(fs.readFileSync(path.join(created.path, 'README.md'), 'utf8')).toBe('# Test\n');
    });
  });

  it('resolves the same root from a nested directory and from a linked worktree', async () => {
    await withIsolatedRuntimes(async () => {
      const { parent, repo } = createCheckout();
      writeJson(path.join(repo, 'opencode.json'), { worktree: { directory: '../worktrees' } });
      const nested = path.join(repo, 'packages', 'app');
      fs.mkdirSync(nested, { recursive: true });
      const linked = createTempDir();
      fs.rmSync(linked, { recursive: true, force: true });
      runGit(repo, ['worktree', 'add', '-b', 'feature/linked', linked, 'HEAD']);
      const git = await loadGitService();
      const expected = path.join(parent, 'worktrees', 'my-feature');

      // Neither entry point may pick a different base for the same project.
      for (const entry of [nested, linked]) {
        await expect(git.previewWorktreeCreate(entry, { mode: 'new', worktreeName: 'my-feature' })).resolves.toEqual({
          name: 'my-feature',
          branch: 'openchamber/my-feature',
          path: expected,
        });
      }

      const created = await git.createWorktree(nested, {
        mode: 'new',
        branchName: 'openchamber/my-feature',
        worktreeName: 'my-feature',
        returnAfterDirectoryCreated: true,
      });

      expect(created.path).toBe(expected);
    });
  });

  it('uses an absolute folder verbatim and expands a ~ folder against the home directory', async () => {
    await withIsolatedRuntimes(async () => {
      const { repo: absoluteRepo } = createCheckout('absolute-repo');
      const absoluteRoot = createTempDir();
      writeJson(path.join(absoluteRepo, 'opencode.json'), { worktree: { directory: absoluteRoot } });
      const absoluteGit = await loadGitService();

      await expect(
        absoluteGit.previewWorktreeCreate(absoluteRepo, { mode: 'new', worktreeName: 'abs' }),
      ).resolves.toEqual({ name: 'abs', branch: 'openchamber/abs', path: path.join(absoluteRoot, 'abs') });
      const absoluteCreated = await absoluteGit.createWorktree(absoluteRepo, {
        mode: 'new',
        branchName: 'openchamber/abs',
        worktreeName: 'abs',
      });
      await settleWorktree(absoluteGit, absoluteCreated.path);
      expect(absoluteCreated.path).toBe(path.join(absoluteRoot, 'abs'));

      const { repo: homeRepo } = createCheckout('home-repo');
      writeJson(path.join(homeRepo, 'opencode.json'), { worktree: { directory: '~/opencode-worktrees-test' } });
      const homeGit = await loadGitService();
      const homeRoot = path.join(os.homedir(), 'opencode-worktrees-test');

      try {
        await expect(homeGit.previewWorktreeCreate(homeRepo, { mode: 'new', worktreeName: 'home' })).resolves.toEqual({
          name: 'home',
          branch: 'openchamber/home',
          path: path.join(homeRoot, 'home'),
        });

        const created = await homeGit.createWorktree(homeRepo, {
          mode: 'new',
          branchName: 'openchamber/home',
          worktreeName: 'home',
          returnAfterDirectoryCreated: true,
        });
        expect(created.path).toBe(path.join(homeRoot, 'home'));
      } finally {
        fs.rmSync(homeRoot, { recursive: true, force: true });
      }
    });
  });

  it('lets a project folder win over the global one', async () => {
    await withIsolatedRuntimes(async ({ configDir }) => {
      const globalRoot = createTempDir();
      writeJson(path.join(configDir, 'opencode.json'), { worktree: { directory: globalRoot } });

      const { parent, repo } = createCheckout();
      writeJson(path.join(repo, 'opencode.json'), { worktree: { directory: '../worktrees' } });
      const git = await loadGitService();

      const created = await git.createWorktree(repo, {
        mode: 'new',
        branchName: 'openchamber/feature',
        worktreeName: 'feature',
        returnAfterDirectoryCreated: true,
      });

      expect(created.path).toBe(path.join(parent, 'worktrees', 'feature'));
      expect(fs.readdirSync(globalRoot)).toEqual([]);
    });
  });

  it('never reuses a directory already sitting in the configured folder', async () => {
    await withIsolatedRuntimes(async () => {
      const { parent, repo } = createCheckout();
      writeJson(path.join(repo, 'opencode.json'), { worktree: { directory: '../worktrees' } });
      const git = await loadGitService();

      const taken = path.join(parent, 'worktrees', 'my-feature');
      fs.mkdirSync(taken, { recursive: true });

      const created = await git.createWorktree(repo, {
        mode: 'new',
        branchName: 'openchamber/my-feature',
        worktreeName: 'my-feature',
        returnAfterDirectoryCreated: true,
      });

      expect(created.path).not.toBe(taken);
      expect(path.dirname(created.path)).toBe(path.join(parent, 'worktrees'));
      expect(fs.existsSync(taken)).toBe(true);
    });
  });

  it('sanitizes the worktree name before joining it to the configured folder', async () => {
    await withIsolatedRuntimes(async () => {
      const { parent, repo } = createCheckout();
      writeJson(path.join(repo, 'opencode.json'), { worktree: { directory: '../worktrees' } });
      const git = await loadGitService();

      const created = await git.createWorktree(repo, {
        mode: 'new',
        branchName: 'openchamber/feature',
        worktreeName: 'feature/My Feature!!',
        returnAfterDirectoryCreated: true,
      });

      // The same slug the default folder uses, so no separator or case rule
      // changes just because the folder is configured.
      expect(created.path).toBe(path.join(parent, 'worktrees', 'feature-My-Feature'));
      expect(fs.readdirSync(path.join(parent, 'worktrees'))).toEqual(['feature-My-Feature']);
    });
  });

  it('checks out an existing branch into the configured folder', async () => {
    await withIsolatedRuntimes(async () => {
      const { parent, repo } = createCheckout();
      runGit(repo, ['branch', 'feature/existing']);
      writeJson(path.join(repo, 'opencode.json'), { worktree: { directory: '../worktrees' } });
      const git = await loadGitService();
      const input = { mode: 'existing', existingBranch: 'feature/existing', worktreeName: 'existing' };

      // `branch` echoes the requested branch in existing mode, so the folder is
      // what preview has to agree with creation about here.
      await expect(git.previewWorktreeCreate(repo, input)).resolves.toMatchObject({
        name: 'existing',
        path: path.join(parent, 'worktrees', 'existing'),
      });

      const created = await git.createWorktree(repo, { ...input, returnAfterDirectoryCreated: true });
      await settleWorktree(git, created.path);

      expect(created.path).toBe(path.join(parent, 'worktrees', 'existing'));
      expect(runGit(created.path, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('feature/existing');
    });
  });

  it('reports bootstrap progress for a worktree in a configured folder', async () => {
    await withIsolatedRuntimes(async () => {
      const { parent, repo } = createCheckout();
      writeJson(path.join(repo, 'opencode.json'), { worktree: { directory: '../worktrees' } });
      const git = await loadGitService();

      const created = await git.createWorktree(repo, {
        mode: 'new',
        branchName: 'openchamber/bootstrapped',
        worktreeName: 'bootstrapped',
        returnAfterDirectoryCreated: true,
      });

      expect(created.path).toBe(path.join(parent, 'worktrees', 'bootstrapped'));
      await expect(git.getWorktreeBootstrapStatus(created.path)).resolves.toMatchObject({
        status: 'pending',
        phase: 'directory-created',
      });

      await settleWorktree(git, created.path);

      expect(fs.readFileSync(path.join(created.path, 'README.md'), 'utf8')).toBe('# Test\n');
      await expect(git.getWorktreeBootstrapStatus(created.path)).resolves.toMatchObject({
        status: 'ready',
        phase: 'setup-ready',
      });
    });
  });

  it('removes the pre-created directory when the checkout fails under a configured folder', async () => {
    await withIsolatedRuntimes(async () => {
      const { repo } = createCheckout();
      const worktrees = createTempDir();
      writeJson(path.join(repo, 'opencode.json'), { worktree: { directory: worktrees } });
      const git = await loadGitService();

      const inUse = createTempDir();
      fs.rmSync(inUse, { recursive: true, force: true });
      runGit(repo, ['worktree', 'add', '-b', 'feature/in-use', inUse, 'HEAD']);

      await expect(
        git.createWorktree(repo, {
          mode: 'existing',
          existingBranch: 'feature/in-use',
          branchName: 'feature/in-use',
          worktreeName: 'feature-in-use',
          returnAfterDirectoryCreated: true,
        }),
      ).rejects.toThrow(/already checked out/);

      expect(fs.readdirSync(worktrees)).toEqual([]);
    });
  });

  it('keeps removing a managed-folder worktree after the setting moves', async () => {
    await withIsolatedRuntimes(async ({ dataHome }) => {
      const { parent, repo } = createCheckout();
      const withoutSetting = await loadGitService();

      const legacy = await withoutSetting.createWorktree(repo, {
        mode: 'new',
        branchName: 'openchamber/legacy',
        worktreeName: 'legacy',
        returnAfterDirectoryCreated: true,
      });
      expect(path.dirname(legacy.path)).toBe(path.join(dataHome, 'opencode', 'worktree', projectIdOf(repo)));

      writeJson(path.join(repo, 'opencode.json'), { worktree: { directory: '../worktrees' } });
      const withSetting = await loadGitService();
      const relocated = await withSetting.createWorktree(repo, {
        mode: 'new',
        branchName: 'openchamber/relocated',
        worktreeName: 'relocated',
        returnAfterDirectoryCreated: true,
      });
      expect(relocated.path).toBe(path.join(parent, 'worktrees', 'relocated'));

      // The old folder is no longer the configured one, and the worktree in it
      // must still be removable through the same repository.
      await withSetting.removeWorktree(repo, { directory: legacy.path, force: true });

      expect(fs.existsSync(legacy.path)).toBe(false);
      expect(runGit(repo, ['worktree', 'list']).includes(legacy.path)).toBe(false);
    });
  });

  it('never removes a directory outside the configured and managed roots', async () => {
    await withIsolatedRuntimes(async () => {
      const { repo } = createCheckout();
      const stranger = createTempDir();
      writeJson(path.join(repo, 'opencode.json'), { worktree: { directory: '../worktrees' } });
      const git = await loadGitService();
      const canary = path.join(stranger, 'keep.txt');
      fs.writeFileSync(canary, 'keep\n');

      await git.removeWorktree(repo, { directory: stranger, force: true });

      expect(fs.readFileSync(canary, 'utf8')).toBe('keep\n');
    });
  });

  it('refuses to remove the primary checkout when the setting points at its parent', async () => {
    await withIsolatedRuntimes(async () => {
      const { repo } = createCheckout();
      writeJson(path.join(repo, 'opencode.json'), { worktree: { directory: '..' } });
      const git = await loadGitService();

      await expect(git.removeWorktree(repo, { directory: repo, force: true })).rejects.toThrow(
        'Cannot remove the primary workspace',
      );

      expect(fs.existsSync(path.join(repo, 'README.md'))).toBe(true);
    });
  });

  it('treats a malformed config document as unset instead of failing creation', async () => {
    await withIsolatedRuntimes(async ({ dataHome }) => {
      const { repo } = createCheckout();
      fs.writeFileSync(path.join(repo, 'opencode.json'), '{ "worktree": { "directory": ');
      const git = await loadGitService();

      const created = await git.createWorktree(repo, {
        mode: 'new',
        branchName: 'openchamber/malformed',
        worktreeName: 'malformed',
        returnAfterDirectoryCreated: true,
      });

      expect(created.path).toBe(path.join(dataHome, 'opencode', 'worktree', projectIdOf(repo), 'malformed'));
    });
  });

  it('fails creation when a config file naming the destination cannot be read', async () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return;

    await withIsolatedRuntimes(async ({ dataHome }) => {
      const { repo } = createCheckout();
      const configFile = path.join(repo, 'opencode.json');
      fs.writeFileSync(configFile, '{ "worktree": { "directory": "../worktrees" } }\n');
      const git = await loadGitService();
      fs.chmodSync(configFile, 0o000);

      try {
        await expect(
          git.createWorktree(repo, {
            mode: 'new',
            branchName: 'openchamber/unreadable',
            worktreeName: 'unreadable',
            returnAfterDirectoryCreated: true,
          }),
        ).rejects.toThrow(/Failed to read OpenCode configuration/);

        // Neither the configured folder nor the default one may be created.
        expect(fs.existsSync(path.join(path.dirname(repo), 'worktrees'))).toBe(false);
        expect(fs.existsSync(path.join(dataHome, 'opencode', 'worktree'))).toBe(false);
      } finally {
        fs.chmodSync(configFile, 0o600);
      }
    });
  });

  it('reads a folder from an ancestor project config, resolved against the checkout', async () => {
    await withIsolatedRuntimes(async () => {
      const { parent, repo } = createCheckout();
      writeJson(path.join(parent, 'opencode.json'), { worktree: { directory: 'shared-worktrees' } });
      const git = await loadGitService();

      // OpenCode merges project config from the entry directory up to the
      // filesystem root, but still resolves a relative folder against the
      // repository, so the value lands under the checkout and not the file.
      const expected = path.join(repo, 'shared-worktrees', 'ancestor');
      await expect(git.previewWorktreeCreate(repo, { mode: 'new', worktreeName: 'ancestor' })).resolves.toMatchObject({
        path: expected,
      });

      const created = await git.createWorktree(repo, {
        mode: 'new',
        branchName: 'openchamber/ancestor',
        worktreeName: 'ancestor',
        returnAfterDirectoryCreated: true,
      });

      expect(created.path).toBe(expected);
    });
  });

  it('honors OPENCODE_CONFIG over a project folder, because OpenCode does', async () => {
    const dataHome = createTempDir();
    const configHome = createTempDir();
    const customConfig = path.join(createTempDir(), 'managed.json');

    await withEnvironment(
      { XDG_DATA_HOME: dataHome, XDG_CONFIG_HOME: configHome, OPENCODE_CONFIG: customConfig },
      async () => {
        const { repo } = createCheckout();
        const customRoot = createTempDir();
        writeJson(path.join(repo, 'opencode.json'), { worktree: { directory: '../worktrees' } });
        writeJson(customConfig, { worktree: { directory: customRoot } });
        const git = await loadGitService();

        await expect(git.previewWorktreeCreate(repo, { mode: 'new', worktreeName: 'managed' })).resolves.toMatchObject({
          path: path.join(customRoot, 'managed'),
        });
      },
    );
  });

  it('picks up a folder written into the project config while the server runs', async () => {
    await withIsolatedRuntimes(async ({ dataHome }) => {
      const { parent, repo } = createCheckout();
      const git = await loadGitService();

      await expect(git.previewWorktreeCreate(repo, { mode: 'new', worktreeName: 'later' })).resolves.toMatchObject({
        path: path.join(dataHome, 'opencode', 'worktree', projectIdOf(repo), 'later'),
      });

      writeJson(path.join(repo, 'opencode.json'), { worktree: { directory: '../worktrees' } });

      await expect(git.previewWorktreeCreate(repo, { mode: 'new', worktreeName: 'later' })).resolves.toMatchObject({
        path: path.join(parent, 'worktrees', 'later'),
      });
    });
  });
});
