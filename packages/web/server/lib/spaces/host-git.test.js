import { describe, expect, it } from 'vitest';

import { createHostGit, hostGitEnvironment, isGitVersionAtLeast, parseGitVersion } from './host-git.js';

// Written out here rather than imported, so that a name dropped from the module's list turns this red.
const REMOVED = [
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_NAMESPACE', 'GIT_COMMON_DIR', 'GIT_PREFIX', 'GIT_SHALLOW_FILE', 'GIT_GRAFT_FILE', 'GIT_REPLACE_REF_BASE',
  'GIT_NO_REPLACE_OBJECTS', 'GIT_QUARANTINE_PATH', 'GIT_INTERNAL_SUPER_PREFIX', 'GIT_DEFAULT_HASH', 'GIT_DEFAULT_REF_FORMAT',
  'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT', 'GIT_ALLOW_PROTOCOL', 'GIT_PROTOCOL_FROM_USER',
  'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_AUTHOR_DATE', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'GIT_COMMITTER_DATE',
  'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GIT_CONFIG_KEY_12', 'GIT_CONFIG_VALUE_12',
  'GIT_TRACE', 'GIT_TRACE_PACKET', 'GIT_TRACE_PACK_ACCESS', 'GIT_TRACE_PERFORMANCE', 'GIT_TRACE_SETUP', 'GIT_TRACE_CURL',
  'GIT_TRACE_SHALLOW', 'GIT_TRACE2', 'GIT_TRACE2_EVENT', 'GIT_TRACE2_PERF', 'GIT_TRACE2_CONFIG_PARAMS',
  'GIT_LITERAL_PATHSPECS', 'GIT_GLOB_PATHSPECS', 'GIT_NOGLOB_PATHSPECS', 'GIT_ICASE_PATHSPECS', 'GIT_ATTR_SOURCE',
];
const ADDED = { GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };
const mixedCase = (name) => name.toLowerCase().replace(/^git/, 'Git');

describe('hostGitEnvironment, every removed variable', () => {
  it.each(REMOVED)('removes %s and keeps the rest', (name) => {
    expect(hostGitEnvironment({ PATH: '/usr/bin', [name]: 'x' }, 'linux')).toEqual({ PATH: '/usr/bin', ...ADDED });
  });

  it.each(REMOVED)('removes %s in any case on Windows', (name) => {
    for (const spelling of [name, name.toLowerCase(), mixedCase(name)]) {
      expect(hostGitEnvironment({ Path: 'C:\\Windows', [spelling]: 'x' }, 'win32')).toEqual({ Path: 'C:\\Windows', ...ADDED });
    }
  });

  it.each(REMOVED)('keeps a lowercase %s on POSIX, where git does not read it', (name) => {
    expect(hostGitEnvironment({ [name.toLowerCase()]: 'x' }, 'linux')).toEqual({ [name.toLowerCase()]: 'x', ...ADDED });
  });

  // A denylist: whatever it does not name passes, the user's own settings among them.
  // The docker CLI that git starts through `ext::` inherits this environment, so the Docker settings must pass.
  it.each(['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_TEMPLATE_DIR', 'GIT_SSH_COMMAND', 'GIT_EXEC_PATH', 'GIT_TRACING', 'HOME',
    'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH', 'SSH_AUTH_SOCK'])('passes %s through', (name) => {
    expect(hostGitEnvironment({ [name]: 'x' }, 'linux')).toEqual({ [name]: 'x', ...ADDED });
  });
});

describe('hostGitEnvironment', () => {
  it('drops what points git at another repository and keeps the user config', () => {
    const environment = hostGitEnvironment({
      PATH: '/usr/bin',
      HOME: '/home/me',
      GIT_CONFIG_GLOBAL: '/home/me/.gitconfig',
      GIT_DIR: '/elsewhere/.git',
      GIT_WORK_TREE: '/elsewhere',
      GIT_INDEX_FILE: '/elsewhere/index',
      GIT_OBJECT_DIRECTORY: '/elsewhere/objects',
      GIT_ALTERNATE_OBJECT_DIRECTORIES: '/elsewhere/more',
      GIT_NAMESPACE: 'other',
      GIT_COMMON_DIR: '/elsewhere/common',
      GIT_CONFIG_PARAMETERS: "'core.hookspath'='/tmp/hooks'",
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.hooksPath',
      GIT_CONFIG_VALUE_0: '/tmp/hooks',
      GIT_ALLOW_PROTOCOL: 'file',
      GIT_AUTHOR_NAME: 'Someone',
      GIT_OPTIONAL_LOCKS: '1',
    }, 'linux');
    expect(environment).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/me',
      GIT_CONFIG_GLOBAL: '/home/me/.gitconfig',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_TERMINAL_PROMPT: '0',
    });
  });

  it('compares names without case on Windows, where the system does too', () => {
    expect(hostGitEnvironment({ Git_Dir: 'C:\\elsewhere', Path: 'C:\\Windows' }, 'win32')).toEqual({ Path: 'C:\\Windows', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' });
    // On POSIX `git_dir` is another variable, and git does not read it.
    expect(hostGitEnvironment({ git_dir: '/elsewhere' }, 'linux')).toMatchObject({ git_dir: '/elsewhere' });
  });
});

describe('createHostGit', () => {
  const recordingRunner = (result) => {
    const calls = [];
    return { calls, runCommand: async (file, args, options) => { calls.push({ file, args, options }); return result; } };
  };

  it('runs git -C with an argv, the cleaned environment and the call options', async () => {
    const { calls, runCommand } = recordingRunner({ code: 0, stdout: 'out\n', stderr: '' });
    const git = createHostGit({ runCommand, gitPath: '/opt/git/bin/git', environment: { PATH: '/usr/bin', GIT_DIR: '/elsewhere' } });
    const { signal } = new AbortController();
    expect(await git.output('/repo with space', ['write-tree'], { env: { GIT_INDEX_FILE: '/tmp/index' }, keepTail: true, killTree: true, keepAtExit: true, signal })).toBe('out\n');
    expect(calls).toEqual([{
      file: '/opt/git/bin/git',
      args: ['-C', '/repo with space', 'write-tree'],
      options: {
        env: { PATH: '/usr/bin', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_INDEX_FILE: '/tmp/index' },
        stdin: undefined,
        timeoutMs: 120_000,
        maxOutputBytes: 4 * 1024 * 1024,
        keepTail: true,
        killTree: true,
        keepAtExit: true,
        signal,
      },
    }]);
  });

  it('names the subcommand when git fails, past its -c options', async () => {
    const { runCommand } = recordingRunner({ code: 128, stdout: '', stderr: 'fatal: bad object\n' });
    const git = createHostGit({ runCommand, environment: {} });
    await expect(git.output('/repo', ['-c', 'core.splitIndex=false', 'write-tree'])).rejects.toMatchObject({
      code: 'git_command_failed',
      message: 'git write-tree failed: fatal: bad object',
      details: { exitCode: 128 },
    });
  });
});

describe('parseGitVersion', () => {
  it.each([
    ['git version 2.50.1 (Apple Git-155)\n', { major: 2, minor: 50, patch: 1 }],
    ['git version 2.54.0.windows.1\n', { major: 2, minor: 54, patch: 0 }],
    ['git version 2.39.5\n', { major: 2, minor: 39, patch: 5 }],
    ['git version 2.27.0.rc2\n', { major: 2, minor: 27, patch: 0 }],
    ['git version 3.0\n', { major: 3, minor: 0, patch: 0 }],
  ])('reads %j', (text, version) => {
    expect(parseGitVersion(text)).toEqual(version);
  });

  it.each(['', 'version 2.50.1', 'git version two', 'hub version 2.14.2\ngit version 2.50.1'])('reads nothing from %j', (text) => {
    expect(parseGitVersion(text)).toBeNull();
  });

  it('compares versions number by number', () => {
    const floor = { major: 2, minor: 27, patch: 0 };
    expect(isGitVersionAtLeast({ major: 2, minor: 27, patch: 0 }, floor)).toBe(true);
    expect(isGitVersionAtLeast({ major: 2, minor: 100, patch: 0 }, floor)).toBe(true);
    expect(isGitVersionAtLeast({ major: 3, minor: 0, patch: 0 }, floor)).toBe(true);
    expect(isGitVersionAtLeast({ major: 2, minor: 26, patch: 9 }, floor)).toBe(false);
    expect(isGitVersionAtLeast({ major: 1, minor: 99, patch: 99 }, floor)).toBe(false);
  });
});
