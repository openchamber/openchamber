import './opencodeConfigTestHome';
import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { OPENCODE_CONFIG_DIR } from './opencodeConfigPaths';
import { readWorktreeDirectoryConfig, resolveWorktreeRoot, setWorktreeDirectory } from './opencodeConfig';

const createdDirectories: string[] = [];
const previousCustomConfig = process.env.OPENCODE_CONFIG;

const createTempDir = () => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-worktree-')));
  createdDirectories.push(directory);
  return directory;
};

/** The config documents these tests write. `worktree.directory` stays loose
 *  because a value OpenCode rejects is part of what is under test. */
type ConfigDocument = { theme?: string; worktree?: { directory?: string | number | null } | string };

const writeConfigDoc = (filePath: string, document: ConfigDocument) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(document, null, 2), 'utf8');
};

const readConfigDoc = (filePath: string): ConfigDocument =>
  JSON.parse(fs.readFileSync(filePath, 'utf8'));

const writeGlobalConfig = (document: ConfigDocument | null) => {
  if (document) writeConfigDoc(path.join(OPENCODE_CONFIG_DIR, 'opencode.json'), document);
};

// `readConfigLayers` reads `OPENCODE_CONFIG` at call time, and a managed config
// outranks every project document under test. `opencodeConfigTestHome` clears it
// once at import, which a shell that exports it outlasts, so clear it per test.
beforeEach(() => {
  delete process.env.OPENCODE_CONFIG;
});

afterEach(() => {
  for (const directory of createdDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  if (previousCustomConfig === undefined) delete process.env.OPENCODE_CONFIG;
  else process.env.OPENCODE_CONFIG = previousCustomConfig;
});

describe('worktree.directory configuration (VS Code parity)', () => {
  test('reports no folder when nothing configures one', () => {
    writeGlobalConfig({ theme: 'opencode' });
    const repo = createTempDir();

    assert.equal(readWorktreeDirectoryConfig(repo).directory, null);
    assert.equal(readWorktreeDirectoryConfig(repo).source, null);
    assert.equal(resolveWorktreeRoot(repo), null);
  });

  test('resolves a relative folder against the primary checkout', () => {
    writeGlobalConfig({ worktree: { directory: '../worktrees' } });
    const repo = createTempDir();

    const config = readWorktreeDirectoryConfig(repo);
    assert.equal(config.directory, '../worktrees');
    assert.equal(config.source, 'global');
    assert.equal(config.locked, false);
    assert.equal(resolveWorktreeRoot(repo), path.resolve(repo, '../worktrees'));
  });

  test('finds the project document from a nested directory of the checkout', () => {
    writeGlobalConfig({ worktree: { directory: '../global' } });
    const outer = createTempDir();
    const repo = path.join(outer, 'my-app');
    fs.mkdirSync(path.join(repo, 'packages', 'web'), { recursive: true });
    writeConfigDoc(path.join(repo, 'opencode.json'), { worktree: { directory: '../project' } });

    assert.equal(readWorktreeDirectoryConfig(path.join(repo, 'packages', 'web')).source, 'project');
  });

  test('resolves a relative folder against the checkout it is given, not a nested one', () => {
    writeGlobalConfig({ worktree: { directory: '../worktrees' } });
    const outer = createTempDir();
    const repo = path.join(outer, 'my-app');
    fs.mkdirSync(repo, { recursive: true });

    // `gitService.ts` resolves the primary checkout with `git rev-parse
    // --git-common-dir` before calling this, which is what keeps `../worktrees`
    // in one place for a nested directory or a linked worktree of the project.
    assert.equal(resolveWorktreeRoot(repo), path.resolve(repo, '../worktrees'));
  });

  test('prefers a project document over the global one', () => {
    writeGlobalConfig({ worktree: { directory: '../global' } });
    const repo = createTempDir();
    writeConfigDoc(path.join(repo, 'opencode.json'), { worktree: { directory: '../project' } });

    assert.equal(readWorktreeDirectoryConfig(repo).source, 'project');
    assert.equal(resolveWorktreeRoot(repo), path.resolve(repo, '../project'));
  });

  test('prefers a nearer project document over a further one', () => {
    writeGlobalConfig(null);
    const outer = createTempDir();
    const repo = path.join(outer, 'my-app');
    fs.mkdirSync(repo, { recursive: true });
    writeConfigDoc(path.join(outer, 'opencode.json'), { worktree: { directory: '../further' } });
    writeConfigDoc(path.join(repo, 'opencode.json'), { worktree: { directory: '../nearer' } });

    assert.equal(readWorktreeDirectoryConfig(repo).directory, '../nearer');
  });

  test('prefers a custom document over every project document', () => {
    writeGlobalConfig({ worktree: { directory: '../global' } });
    const repo = createTempDir();
    writeConfigDoc(path.join(repo, 'opencode.json'), { worktree: { directory: '../project' } });
    const custom = path.join(createTempDir(), 'opencode.json');
    writeConfigDoc(custom, { worktree: { directory: '../custom' } });
    process.env.OPENCODE_CONFIG = custom;

    assert.equal(readWorktreeDirectoryConfig(repo).source, 'custom');
    assert.equal(resolveWorktreeRoot(repo), path.resolve(repo, '../custom'));
  });

  test('resolves ~/ against the home directory and absolute paths as given', () => {
    const repo = createTempDir();
    writeGlobalConfig({ worktree: { directory: '~/trees' } });
    assert.equal(resolveWorktreeRoot(repo), path.join(os.homedir(), 'trees'));

    const absolute = createTempDir();
    writeGlobalConfig({ worktree: { directory: absolute } });
    assert.equal(resolveWorktreeRoot(repo), absolute);
  });

  test('treats a malformed document as unset instead of failing', () => {
    writeGlobalConfig({ worktree: { directory: '../global' } });
    const repo = createTempDir();
    fs.writeFileSync(path.join(repo, 'opencode.json'), '{ "worktree": { ');

    assert.equal(resolveWorktreeRoot(repo), path.resolve(repo, '../global'));
    assert.equal(readWorktreeDirectoryConfig(repo).source, 'global');
  });

  test('reports a project document that cannot be read instead of using a default', () => {
    if (process.getuid && process.getuid() === 0) return;
    writeGlobalConfig({ worktree: { directory: '../global' } });
    const outer = createTempDir();
    const repo = path.join(outer, 'my-app');
    fs.mkdirSync(repo, { recursive: true });
    // An ancestor document is read outside `readConfigLayers`, which is the path
    // that has to decide between an error and the inherited default.
    const ancestorFile = path.join(outer, 'opencode.json');
    writeConfigDoc(ancestorFile, { worktree: { directory: '../trees' } });
    fs.chmodSync(ancestorFile, 0o000);

    assert.throws(() => resolveWorktreeRoot(repo), /Failed to read OpenCode configuration/);
  });

  test('writes into a project document the repository already has', () => {
    writeGlobalConfig(null);
    const repo = createTempDir();
    const projectFile = path.join(repo, 'opencode.json');
    writeConfigDoc(projectFile, { theme: 'opencode' });

    assert.deepEqual(setWorktreeDirectory('../trees', repo), { changed: true, path: projectFile });
    assert.deepEqual(readConfigDoc(projectFile), { theme: 'opencode', worktree: { directory: '../trees' } });
    assert.equal(readWorktreeDirectoryConfig(repo).locked, false);
  });

  test('never creates a project document for a repository that has none', () => {
    writeGlobalConfig(null);
    const repo = createTempDir();

    const { path: writePath } = setWorktreeDirectory('../trees', repo);
    assert.equal(path.dirname(writePath ?? ''), OPENCODE_CONFIG_DIR);
    assert.equal(fs.existsSync(path.join(repo, 'opencode.json')), false);
  });

  test('clears the key and reports no change when it is already absent', () => {
    writeGlobalConfig(null);
    const repo = createTempDir();
    writeConfigDoc(path.join(repo, 'opencode.json'), { worktree: { directory: '../trees' } });

    assert.equal(setWorktreeDirectory(null, repo).changed, true);
    assert.deepEqual(readConfigDoc(path.join(repo, 'opencode.json')), {});
    assert.equal(setWorktreeDirectory(null, repo).changed, false);
  });

  test('reports a value from a document Settings cannot write as locked', () => {
    writeGlobalConfig(null);
    const outer = createTempDir();
    const repo = path.join(outer, 'my-app');
    fs.mkdirSync(repo, { recursive: true });
    const ancestorFile = path.join(outer, 'opencode.json');
    writeConfigDoc(ancestorFile, { worktree: { directory: '../trees' } });

    const config = readWorktreeDirectoryConfig(repo);
    assert.equal(config.locked, true);
    assert.equal(config.path, ancestorFile);
    assert.equal(config.writePath?.startsWith(repo), false);
  });
});
