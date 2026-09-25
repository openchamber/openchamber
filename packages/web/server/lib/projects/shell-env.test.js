import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import fsPromises from 'node:fs/promises';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';

import { createProjectIdFromPath } from './project-id.js';
import {
  applyShellEnv,
  createProjectShellEnvResolver,
  parseShellEnvOutput,
  sanitizeShellEnv,
  sanitizeShellEnvVars,
  shellEnvToStored,
} from './shell-env.js';

const createFakeSpawn = ({ stdout = '', code = 0, neverClose = false } = {}) => {
  const calls = [];
  const spawn = (command, options) => {
    calls.push({ command, options: options ?? {} });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {
      child.emit('close', null);
      return true;
    };
    process.nextTick(() => {
      if (stdout) child.stdout.write(stdout);
      if (!neverClose) child.emit('close', code);
    });
    return child;
  };
  return { spawn, calls };
};

/**
 * A resolver over a real temp projects dir. The project config file exists so
 * the directory walk finds the owner; `readShellEnvForProject` is injected.
 */
const createFixture = async ({ shellEnv = null, stdout = '', code = 0, neverClose = false, ttlMs = 60_000, baseEnv = () => ({ PATH: '/usr/bin', HOME: '/home/test' }) } = {}) => {
  const projectsDir = await mkdtemp(path.join(os.tmpdir(), 'oc-shell-env-'));
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'oc-shell-project-'));
  const projectId = createProjectIdFromPath(projectRoot);
  await writeFile(path.join(projectsDir, `${projectId}.json`), '{}', 'utf8');

  const spawnFixture = createFakeSpawn({ stdout, code, neverClose });
  let reads = 0;
  const resolver = createProjectShellEnvResolver({
    fsPromises,
    path,
    projectsDirPath: projectsDir,
    readShellEnvForProject: async () => {
      reads += 1;
      return shellEnv;
    },
    createProjectIdFromPath,
    spawn: spawnFixture.spawn,
    baseEnv,
    timeoutMs: 25,
    ttlMs,
  });

  return {
    resolver,
    projectId,
    projectRoot,
    calls: spawnFixture.calls,
    getReads: () => reads,
    cleanup: async () => {
      await rm(projectsDir, { recursive: true, force: true });
      await rm(projectRoot, { recursive: true, force: true });
    },
  };
};

describe('parseShellEnvOutput', () => {
  it('parses devenv print-dev-env --json, keeping only exported variables', () => {
    const output = JSON.stringify({
      variables: {
        PATH: { type: 'exported', value: '/nix/store/a/bin:/usr/bin' },
        GOFLAGS: { type: 'exported', value: '-mod=vendor' },
        IFS: { type: 'var', value: ' \t\n' },
        outputs: { type: 'internal', value: '' },
        hookList: { type: 'array', value: '[]' },
        unknowable: { type: 'unknown', value: 'x' },
      },
      bashFunctions: { hello: 'echo hi' },
    });
    expect(parseShellEnvOutput(output)).toEqual({
      PATH: '/nix/store/a/bin:/usr/bin',
      GOFLAGS: '-mod=vendor',
    });
  });

  it('drops the Nix build sandbox home and temp directories from devenv output', () => {
    const output = JSON.stringify({
      variables: {
        PATH: { type: 'exported', value: '/dev/bin' },
        HOME: { type: 'exported', value: '/homeless-shelter' },
        NIX_BUILD_TOP: { type: 'exported', value: '/build' },
        TMPDIR: { type: 'exported', value: '/build' },
        TMP: { type: 'exported', value: '/build' },
        TEMP: { type: 'exported', value: '/build' },
        TEMPDIR: { type: 'exported', value: '/build' },
      },
    });
    expect(parseShellEnvOutput(output)).toEqual({ PATH: '/dev/bin' });
  });

  it('keeps a real home and a project temp directory', () => {
    const output = JSON.stringify({
      variables: {
        HOME: { type: 'exported', value: '/home/dev' },
        TMPDIR: { type: 'exported', value: '/home/dev/scratch' },
        NIX_BUILD_TOP: { type: 'exported', value: '/build' },
        TMP: { type: 'exported', value: '/build' },
      },
    });
    expect(parseShellEnvOutput(output)).toEqual({
      HOME: '/home/dev',
      TMPDIR: '/home/dev/scratch',
    });
  });

  it('drops a sandbox temp directory from flat JSON output too', () => {
    expect(parseShellEnvOutput('{"NIX_BUILD_TOP":"/build","TMPDIR":"/build","FOO":"bar"}'))
      .toEqual({ FOO: 'bar' });
  });

  it('parses a flat direnv export json object', () => {
    expect(parseShellEnvOutput('{"FOO":"bar","PATH":"/x:/y"}')).toEqual({ FOO: 'bar', PATH: '/x:/y' });
  });

  it('parses export lines and dotenv lines, unquoting values', () => {
    const output = [
      'export FOO="a b"',
      'BAR=baz',
      "QUOTED='single value'",
      '# a comment',
      'not an assignment',
      '1INVALID=no',
    ].join('\n');
    expect(parseShellEnvOutput(output)).toEqual({ FOO: 'a b', BAR: 'baz', QUOTED: 'single value' });
  });

  it('parses NUL-separated env output', () => {
    expect(parseShellEnvOutput('A=1\0B=two\0')).toEqual({ A: '1', B: 'two' });
  });

  it('expands variable references from earlier lines and the base environment', () => {
    expect(parseShellEnvOutput('A=/one\nB=$A/two\nexport PATH="$PATH:/dev/bin"', { PATH: '/usr/bin' }))
      .toEqual({ A: '/one', B: '/one/two', PATH: '/usr/bin:/dev/bin' });
  });

  it('leaves unresolvable references literal and honors escapes', () => {
    expect(parseShellEnvOutput('A=$UNKNOWN\nB=\\$literal\n')).toEqual({ A: '$UNKNOWN', B: '$literal' });
  });

  it('keeps backslashes in Windows-style values', () => {
    expect(parseShellEnvOutput('PATH=C:\\Tools;C:\\Windows')).toEqual({ PATH: 'C:\\Tools;C:\\Windows' });
  });

  it('returns an empty object for unrecognized or empty output', () => {
    expect(parseShellEnvOutput('')).toEqual({});
    expect(parseShellEnvOutput('   ')).toEqual({});
    expect(parseShellEnvOutput('{not json')).toEqual({});
    expect(parseShellEnvOutput(undefined)).toEqual({});
  });
});

describe('sanitizeShellEnv', () => {
  it('returns null for non-objects and empty records', () => {
    expect(sanitizeShellEnv(undefined)).toBeNull();
    expect(sanitizeShellEnv('x')).toBeNull();
    expect(sanitizeShellEnv({})).toBeNull();
    expect(sanitizeShellEnv({ enabled: false })).toBeNull();
  });

  it('normalizes enabled, command, vars and mode', () => {
    expect(sanitizeShellEnv({ enabled: true, command: '  devenv print-dev-env --json  ', vars: { A: '1' }, mode: 'replace' }))
      .toEqual({ enabled: true, command: 'devenv print-dev-env --json', vars: { A: '1' }, mode: 'replace' });
    expect(sanitizeShellEnv({ command: 'direnv export json' }).mode).toBe('overlay');
    expect(sanitizeShellEnv({ command: 'x' }).enabled).toBe(false);
  });

  it('drops invalid variable names, non-string values, and caps counts', () => {
    expect(sanitizeShellEnvVars({ GOOD: 'yes', 'bad key': 'no', '1BAD': 'no', NUM: 3, EMPTY: '' }))
      .toEqual({ GOOD: 'yes', EMPTY: '' });
    expect(sanitizeShellEnvVars('nope')).toEqual({});
  });

  it('stores only the keys that carry something', () => {
    expect(shellEnvToStored({ enabled: true, command: 'cmd', vars: { A: '1' }, mode: 'replace' }))
      .toEqual({ enabled: true, command: 'cmd', vars: { A: '1' }, mode: 'replace' });
    expect(shellEnvToStored({ enabled: true })).toEqual({ enabled: true });
    expect(shellEnvToStored({ enabled: false })).toBeUndefined();
  });
});

describe('applyShellEnv', () => {
  const base = { PATH: '/usr/bin:/bin', HOME: '/home/test', CDPATH: '/old' };

  it('overlays non-PATH variables', () => {
    const result = applyShellEnv(base, { vars: { FOO: 'bar', PATH: '/dev/bin' }, mode: 'overlay' }, ':');
    expect(result.FOO).toBe('bar');
    expect(result.PATH).toBe('/dev/bin:/usr/bin:/bin');
    expect(result.HOME).toBe('/home/test');
  });

  it('prepends and deduplicates PATH-like keys, including *_PATH and CDPATH', () => {
    const result = applyShellEnv(base, { vars: { PATH: '/dev/bin:/usr/bin', CDPATH: '/new', GOROOT_PATH: '/go' }, mode: 'overlay' }, ':');
    expect(result.PATH).toBe('/dev/bin:/usr/bin:/bin');
    expect(result.CDPATH).toBe('/new:/old');
    expect(result.GOROOT_PATH).toBe('/go');
  });

  it('replaces PATH-like keys verbatim in replace mode', () => {
    const result = applyShellEnv(base, { vars: { PATH: '/dev/bin' }, mode: 'replace' }, ':');
    expect(result.PATH).toBe('/dev/bin');
  });

  it('writes to the base PATH spelling instead of adding a second key (Windows)', () => {
    const windowsBase = { Path: 'C:\\Windows;C:\\Tools', HOME: 'C:\\Users\\test' };
    const result = applyShellEnv(windowsBase, { vars: { PATH: 'C:\\Dev' }, mode: 'overlay' }, ';');
    expect(result.PATH).toBeUndefined();
    expect(result.Path).toBe('C:\\Dev;C:\\Windows;C:\\Tools');
  });

  it('returns the base environment unchanged when there is nothing to apply', () => {
    expect(applyShellEnv(base, null, ':')).toBe(base);
    expect(applyShellEnv(base, { vars: {}, mode: 'overlay' }, ':')).toEqual(base);
  });
});

describe('createProjectShellEnvResolver', () => {
  it('resolves from a subdirectory of the project', async () => {
    const fixture = await createFixture({ shellEnv: { enabled: true, command: '', vars: { FOO: 'bar' }, mode: 'overlay' } });
    try {
      const nested = path.join(fixture.projectRoot, 'a', 'b');
      expect(await fixture.resolver.resolveForDirectory(nested)).toEqual({ vars: { FOO: 'bar' }, mode: 'overlay' });
    } finally {
      await fixture.cleanup();
    }
  });

  it('parses the command output and lets static vars win', async () => {
    const fixture = await createFixture({
      shellEnv: { enabled: true, command: 'fake', vars: { GOFLAGS: 'static-wins' }, mode: 'overlay' },
      stdout: 'export GOFLAGS=-mod=vendor\nPATH=/dev/bin\n',
    });
    try {
      expect(await fixture.resolver.resolveForDirectory(fixture.projectRoot)).toEqual({
        vars: { GOFLAGS: 'static-wins', PATH: '/dev/bin' },
        mode: 'overlay',
      });
      expect(fixture.calls).toHaveLength(1);
      expect(fixture.calls[0].command).toBe('fake');
    } finally {
      await fixture.cleanup();
    }
  });

  it('reads baseEnv lazily from a getter at spawn time', async () => {
    let reads = 0;
    const fixture = await createFixture({
      shellEnv: { enabled: true, command: 'fake', vars: {}, mode: 'overlay' },
      stdout: 'FOO=bar\n',
      baseEnv: () => {
        reads += 1;
        return { PATH: '/from-getter' };
      },
    });
    try {
      expect(reads).toBe(0);
      await fixture.resolver.resolveForDirectory(fixture.projectRoot);
      expect(reads).toBe(1);
      expect(fixture.calls[0].options.env.PATH).toBe('/from-getter');
    } finally {
      await fixture.cleanup();
    }
  });

  it('returns null when no ancestor project config exists', async () => {
    const fixture = await createFixture({ shellEnv: { enabled: true, command: '', vars: { FOO: 'bar' }, mode: 'overlay' } });
    const orphan = await mkdtemp(path.join(os.tmpdir(), 'oc-orphan-'));
    try {
      expect(await fixture.resolver.resolveForDirectory(orphan)).toBeNull();
    } finally {
      await rm(orphan, { recursive: true, force: true });
      await fixture.cleanup();
    }
  });

  it('runs the command in the project root for a plain subdirectory', async () => {
    const fixture = await createFixture({
      shellEnv: { enabled: true, command: 'fake', vars: {}, mode: 'overlay' },
      stdout: 'FOO=bar\n',
    });
    try {
      await fixture.resolver.resolveForDirectory(path.join(fixture.projectRoot, 'a', 'b'));
      expect(fixture.calls[0].options.cwd).toBe(fixture.projectRoot);
    } finally {
      await fixture.cleanup();
    }
  });

  it('inherits the primary project env for a linked worktree and runs the command in the worktree', async () => {
    const projectsDir = await mkdtemp(path.join(os.tmpdir(), 'oc-shell-env-'));
    const primaryRoot = await mkdtemp(path.join(os.tmpdir(), 'oc-primary-'));
    const worktreeRoot = await mkdtemp(path.join(os.tmpdir(), 'oc-worktree-'));
    const primaryId = createProjectIdFromPath(primaryRoot);
    await writeFile(path.join(projectsDir, `${primaryId}.json`), '{}', 'utf8');
    await writeFile(path.join(worktreeRoot, '.git'), `gitdir: ${path.join(primaryRoot, '.git', 'worktrees', 'wt')}\n`, 'utf8');
    const spawnFixture = createFakeSpawn({ stdout: 'FOO=bar\n', code: 0 });
    const resolver = createProjectShellEnvResolver({
      fsPromises,
      path,
      projectsDirPath: projectsDir,
      readShellEnvForProject: async (id) => (id === primaryId ? { enabled: true, command: 'fake', vars: {}, mode: 'overlay' } : null),
      createProjectIdFromPath,
      spawn: spawnFixture.spawn,
      baseEnv: () => ({ PATH: '/usr/bin' }),
      timeoutMs: 100,
    });
    try {
      expect(await resolver.resolveForDirectory(path.join(worktreeRoot, 'sub'))).toEqual({ vars: { FOO: 'bar' }, mode: 'overlay' });
      expect(spawnFixture.calls).toHaveLength(1);
      expect(spawnFixture.calls[0].options.cwd).toBe(worktreeRoot);
    } finally {
      await rm(projectsDir, { recursive: true, force: true });
      await rm(primaryRoot, { recursive: true, force: true });
      await rm(worktreeRoot, { recursive: true, force: true });
    }
  });

  it('uses an enabled worktree config when the primary has none enabled', async () => {
    const projectsDir = await mkdtemp(path.join(os.tmpdir(), 'oc-shell-env-'));
    const primaryRoot = await mkdtemp(path.join(os.tmpdir(), 'oc-primary-'));
    const worktreeRoot = await mkdtemp(path.join(os.tmpdir(), 'oc-worktree-'));
    const primaryId = createProjectIdFromPath(primaryRoot);
    const worktreeId = createProjectIdFromPath(worktreeRoot);
    await writeFile(path.join(projectsDir, `${primaryId}.json`), '{}', 'utf8');
    await writeFile(path.join(projectsDir, `${worktreeId}.json`), '{}', 'utf8');
    await writeFile(path.join(worktreeRoot, '.git'), `gitdir: ${path.join(primaryRoot, '.git', 'worktrees', 'wt')}\n`, 'utf8');
    const spawnFixture = createFakeSpawn({ stdout: 'FOO=worktree\n', code: 0 });
    const resolver = createProjectShellEnvResolver({
      fsPromises,
      path,
      projectsDirPath: projectsDir,
      readShellEnvForProject: async (id) => {
        if (id === primaryId) return { enabled: false, command: 'primary', vars: {}, mode: 'overlay' };
        if (id === worktreeId) return { enabled: true, command: 'worktree', vars: {}, mode: 'overlay' };
        return null;
      },
      createProjectIdFromPath,
      spawn: spawnFixture.spawn,
      baseEnv: () => ({ PATH: '/usr/bin' }),
      timeoutMs: 100,
    });
    try {
      expect(await resolver.resolveForDirectory(worktreeRoot)).toEqual({ vars: { FOO: 'worktree' }, mode: 'overlay' });
      expect(spawnFixture.calls[0].command).toBe('worktree');
      expect(spawnFixture.calls[0].options.cwd).toBe(worktreeRoot);
    } finally {
      await rm(projectsDir, { recursive: true, force: true });
      await rm(primaryRoot, { recursive: true, force: true });
      await rm(worktreeRoot, { recursive: true, force: true });
    }
  });

  it('returns null when shellEnv is absent or disabled', async () => {
    const absent = await createFixture({ shellEnv: null });
    const disabled = await createFixture({ shellEnv: { enabled: false, command: 'boom', vars: { FOO: 'bar' }, mode: 'overlay' } });
    try {
      expect(await absent.resolver.resolveForDirectory(absent.projectRoot)).toBeNull();
      expect(await disabled.resolver.resolveForDirectory(disabled.projectRoot)).toBeNull();
      expect(disabled.calls).toHaveLength(0);
    } finally {
      await absent.cleanup();
      await disabled.cleanup();
    }
  });

  it('runs the command once per TTL and dedupes concurrent resolutions', async () => {
    const fixture = await createFixture({
      shellEnv: { enabled: true, command: 'fake', vars: {}, mode: 'overlay' },
      stdout: 'FOO=bar\n',
    });
    try {
      const [first, second] = await Promise.all([
        fixture.resolver.resolveForDirectory(fixture.projectRoot),
        fixture.resolver.resolveForDirectory(fixture.projectRoot),
      ]);
      expect(first).toEqual({ vars: { FOO: 'bar' }, mode: 'overlay' });
      expect(second).toEqual(first);
      expect(fixture.calls).toHaveLength(1);
      await fixture.resolver.resolveForDirectory(fixture.projectRoot);
      expect(fixture.calls).toHaveLength(1);
      expect(fixture.getReads()).toBe(1);
    } finally {
      await fixture.cleanup();
    }
  });

  it('re-runs the command after the TTL expires', async () => {
    const fixture = await createFixture({
      shellEnv: { enabled: true, command: 'fake', vars: {}, mode: 'overlay' },
      stdout: 'FOO=bar\n',
      ttlMs: 0,
    });
    try {
      await fixture.resolver.resolveForDirectory(fixture.projectRoot);
      await fixture.resolver.resolveForDirectory(fixture.projectRoot);
      expect(fixture.calls).toHaveLength(2);
    } finally {
      await fixture.cleanup();
    }
  });

  it('falls back to null when the command fails or times out', async () => {
    const failing = await createFixture({
      shellEnv: { enabled: true, command: 'boom', vars: {}, mode: 'overlay' },
      stdout: 'FOO=bar',
      code: 1,
    });
    const hanging = await createFixture({
      shellEnv: { enabled: true, command: 'hang', vars: {}, mode: 'overlay' },
      neverClose: true,
    });
    try {
      expect(await failing.resolver.resolveForDirectory(failing.projectRoot)).toBeNull();
      expect(await hanging.resolver.resolveForDirectory(hanging.projectRoot)).toBeNull();
    } finally {
      await failing.cleanup();
      await hanging.cleanup();
    }
  });

  it('does not run the command when only static vars are configured', async () => {
    const fixture = await createFixture({ shellEnv: { enabled: true, command: '', vars: { FOO: 'bar' }, mode: 'overlay' } });
    try {
      expect(await fixture.resolver.resolveForDirectory(fixture.projectRoot)).toEqual({ vars: { FOO: 'bar' }, mode: 'overlay' });
      expect(fixture.calls).toHaveLength(0);
    } finally {
      await fixture.cleanup();
    }
  });

  it('re-resolves after invalidateProject', async () => {
    const fixture = await createFixture({
      shellEnv: { enabled: true, command: 'fake', vars: {}, mode: 'overlay' },
      stdout: 'FOO=bar\n',
    });
    try {
      await fixture.resolver.resolveForDirectory(fixture.projectRoot);
      expect(fixture.calls).toHaveLength(1);
      fixture.resolver.invalidateProject(fixture.projectId);
      await fixture.resolver.resolveForDirectory(fixture.projectRoot);
      expect(fixture.calls).toHaveLength(2);
    } finally {
      await fixture.cleanup();
    }
  });
});
