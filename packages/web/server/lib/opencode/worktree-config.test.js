import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const createdDirectories = [];
const createdEnvironment = [];

const createTempDir = () => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-worktree-config-')));
  createdDirectories.push(directory);
  return directory;
};

const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
};

/**
 * `shared.js` resolves the config directory at import time, so every case gets a
 * fresh module graph with its own global config file.
 */
const loadWorktreeConfig = async () => {
  vi.resetModules();
  return import('./worktree-config.js');
};

const withEnvironment = (values, run) => {
  const previous = {};
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    createdEnvironment.push({ key, value: process.env[key] });
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  return Promise.resolve()
    .then(run)
    .finally(() => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    });
};

const withGlobalConfig = (config, run) => {
  const configHome = createTempDir();
  if (config) {
    writeJson(path.join(configHome, 'opencode', 'opencode.json'), config);
  }
  return withEnvironment({ XDG_CONFIG_HOME: configHome, OPENCODE_CONFIG: undefined }, run);
};

afterEach(() => {
  for (const { key, value } of createdEnvironment.splice(0)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  for (const directory of createdDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('worktree.directory configuration', () => {
  it('reports no directory when nothing configures one', async () => {
    await withGlobalConfig({ theme: 'opencode' }, async () => {
      const { parent, repo } = { parent: createTempDir(), repo: createTempDir() };
      const { readWorktreeDirectoryConfig, resolveWorktreeRoot } = await loadWorktreeConfig();

      expect(readWorktreeDirectoryConfig(repo)).toMatchObject({ directory: null, source: null, path: null, locked: false });
      expect(resolveWorktreeRoot(repo)).toBeNull();
      expect(parent).toBeTruthy();
    });
  });

  it('reads a global directory and resolves it against the primary checkout', async () => {
    await withGlobalConfig({ worktree: { directory: '../worktrees' } }, async () => {
      const repo = createTempDir();
      const { readWorktreeDirectoryConfig, resolveWorktreeRoot } = await loadWorktreeConfig();

      const config = readWorktreeDirectoryConfig(repo);
      expect(config.directory).toBe('../worktrees');
      expect(config.source).toBe('global');
      expect(config.path).toContain('opencode.json');
      expect(config.locked).toBe(false);
      expect(resolveWorktreeRoot(repo)).toBe(path.resolve(repo, '../worktrees'));
    });
  });

  it('prefers a project document over the global one', async () => {
    await withGlobalConfig({ worktree: { directory: '../global' } }, async () => {
      const repo = createTempDir();
      writeJson(path.join(repo, 'opencode.json'), { worktree: { directory: '../project' } });
      const { readWorktreeDirectoryConfig, resolveWorktreeRoot } = await loadWorktreeConfig();

      expect(readWorktreeDirectoryConfig(repo)).toMatchObject({ directory: '../project', source: 'project' });
      expect(resolveWorktreeRoot(repo)).toBe(path.resolve(repo, '../project'));
    });
  });

  it('prefers a nearer project document over a further one', async () => {
    await withGlobalConfig(null, async () => {
      const outer = createTempDir();
      const repo = path.join(outer, 'my-app');
      fs.mkdirSync(repo, { recursive: true });
      writeJson(path.join(outer, 'opencode.json'), { worktree: { directory: '../further' } });
      writeJson(path.join(repo, 'opencode.json'), { worktree: { directory: '../nearer' } });
      const { readWorktreeDirectoryConfig } = await loadWorktreeConfig();

      expect(readWorktreeDirectoryConfig(repo)).toMatchObject({ directory: '../nearer', source: 'project' });
    });
  });

  it('prefers a custom document over every project document', async () => {
    await withGlobalConfig({ worktree: { directory: '../global' } }, async () => {
      const repo = createTempDir();
      writeJson(path.join(repo, 'opencode.json'), { worktree: { directory: '../project' } });
      const custom = path.join(createTempDir(), 'opencode.json');
      writeJson(custom, { worktree: { directory: '../custom' } });
      await withEnvironment({ OPENCODE_CONFIG: custom }, async () => {
        const { readWorktreeDirectoryConfig, resolveWorktreeRoot } = await loadWorktreeConfig();

        expect(readWorktreeDirectoryConfig(repo)).toMatchObject({ directory: '../custom', source: 'custom' });
        expect(resolveWorktreeRoot(repo)).toBe(path.resolve(repo, '../custom'));
      });
    });
  });

  it('resolves ~/ against the home directory and absolute paths as given', async () => {
    await withGlobalConfig({ worktree: { directory: '~/trees' } }, async () => {
      const repo = createTempDir();
      const { resolveWorktreeRoot } = await loadWorktreeConfig();
      expect(resolveWorktreeRoot(repo)).toBe(path.join(os.homedir(), 'trees'));
    });

    await withGlobalConfig(null, async () => {
      const repo = createTempDir();
      const absolute = createTempDir();
      writeJson(path.join(repo, 'opencode.json'), { worktree: { directory: absolute } });
      const { resolveWorktreeRoot } = await loadWorktreeConfig();
      expect(resolveWorktreeRoot(repo)).toBe(absolute);
    });
  });

  it('treats a malformed document as unset instead of failing', async () => {
    await withGlobalConfig({ worktree: { directory: '../global' } }, async () => {
      const repo = createTempDir();
      fs.writeFileSync(path.join(repo, 'opencode.json'), '{ "worktree": { ');
      const { readWorktreeDirectoryConfig, resolveWorktreeRoot } = await loadWorktreeConfig();

      expect(resolveWorktreeRoot(repo)).toBe(path.resolve(repo, '../global'));
      expect(readWorktreeDirectoryConfig(repo).source).toBe('global');
    });
  });

  it('reports a directory that cannot be read rather than resolving to a default', async () => {
    if (process.getuid && process.getuid() === 0) return;

    await withGlobalConfig(null, async () => {
      const repo = createTempDir();
      const configHome = createTempDir();
      const globalFile = path.join(configHome, 'opencode', 'opencode.json');
      fs.mkdirSync(path.dirname(globalFile), { recursive: true });
      fs.writeFileSync(globalFile, JSON.stringify({ worktree: { directory: '../global' } }));
      fs.chmodSync(globalFile, 0o000);
      await withEnvironment({ XDG_CONFIG_HOME: configHome, OPENCODE_CONFIG: undefined }, async () => {
        const { resolveWorktreeRoot } = await loadWorktreeConfig();
        // `readConfigLayers` rethrows an unreadable layer before any lookup
        // happens, which is the behavior that keeps the default out of it.
        expect(() => resolveWorktreeRoot(repo)).toThrow(/Failed to read OpenCode configuration/);
      });
    });
  });

  it('writes a project document when the repository already has one', async () => {
    await withGlobalConfig(null, async () => {
      const repo = createTempDir();
      const projectFile = path.join(repo, 'opencode.json');
      writeJson(projectFile, { theme: 'opencode' });
      const { readWorktreeDirectoryConfig, setWorktreeDirectory } = await loadWorktreeConfig();

      expect(readWorktreeDirectoryConfig(repo).writePath).toBe(projectFile);
      expect(setWorktreeDirectory('../trees', repo)).toEqual({ changed: true, path: projectFile });
      expect(JSON.parse(fs.readFileSync(projectFile, 'utf8'))).toEqual({ theme: 'opencode', worktree: { directory: '../trees' } });
      expect(readWorktreeDirectoryConfig(repo)).toMatchObject({ directory: '../trees', source: 'project', locked: false });
    });
  });

  it('never creates a project document for a repository that has none', async () => {
    await withGlobalConfig(null, async () => {
      const repo = createTempDir();
      const { readWorktreeDirectoryConfig, setWorktreeDirectory } = await loadWorktreeConfig();

      const writePath = readWorktreeDirectoryConfig(repo).writePath;
      expect(writePath).toContain(path.join('opencode', 'opencode.json'));
      expect(writePath.startsWith(repo)).toBe(false);
      expect(setWorktreeDirectory('../trees', repo)).toEqual({ changed: true, path: writePath });
      expect(fs.existsSync(path.join(repo, 'opencode.json'))).toBe(false);
    });
  });

  it('clears the key and reports no change when it is already absent', async () => {
    await withGlobalConfig(null, async () => {
      const repo = createTempDir();
      writeJson(path.join(repo, 'opencode.json'), { worktree: { directory: '../trees' } });
      const { setWorktreeDirectory } = await loadWorktreeConfig();

      expect(setWorktreeDirectory(null, repo).changed).toBe(true);
      expect(JSON.parse(fs.readFileSync(path.join(repo, 'opencode.json'), 'utf8'))).toEqual({});
      expect(setWorktreeDirectory(null, repo).changed).toBe(false);
    });
  });

  it('keeps sibling worktree settings when rewriting the directory', async () => {
    await withGlobalConfig(null, async () => {
      const repo = createTempDir();
      writeJson(path.join(repo, 'opencode.json'), { worktree: { keepMe: true } });
      const { setWorktreeDirectory } = await loadWorktreeConfig();

      setWorktreeDirectory('../trees', repo);
      expect(JSON.parse(fs.readFileSync(path.join(repo, 'opencode.json'), 'utf8'))).toEqual({
        worktree: { keepMe: true, directory: '../trees' },
      });
    });
  });

  it('reports a value from a document Settings cannot write as locked', async () => {
    await withGlobalConfig(null, async () => {
      const outer = createTempDir();
      const repo = path.join(outer, 'my-app');
      fs.mkdirSync(repo, { recursive: true });
      const ancestorFile = path.join(outer, 'opencode.json');
      writeJson(ancestorFile, { worktree: { directory: '../trees' } });
      const { readWorktreeDirectoryConfig } = await loadWorktreeConfig();

      const config = readWorktreeDirectoryConfig(repo);
      expect(config).toMatchObject({ directory: '../trees', source: 'project', path: ancestorFile, locked: true });
      expect(config.writePath.startsWith(repo)).toBe(false);
    });
  });

  it('refuses to write into a document that cannot be read', async () => {
    if (process.getuid && process.getuid() === 0) return;

    await withGlobalConfig(null, async () => {
      const repo = createTempDir();
      const projectFile = path.join(repo, 'opencode.json');
      writeJson(projectFile, { worktree: { directory: '../trees' } });
      fs.chmodSync(projectFile, 0o000);
      await withEnvironment({ XDG_CONFIG_HOME: createTempDir() }, async () => {
        const { setWorktreeDirectory } = await loadWorktreeConfig();
        expect(() => setWorktreeDirectory('../other', repo)).toThrow();
      });
    });
  });
});
