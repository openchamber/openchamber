import { afterEach, describe, expect, mock, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A host can hold several gh logins; only GitHub says which account each login
// is. `gh auth token --user <login>` is how one login's token is asked for, and
// that token's answer is what names the account. The mock plays gh so the test
// needs no real gh binary and can fail one login while the others answer.

// The real `execFile` is callback-based, so the mock invokes its callback.
const ghRuns = [];
const tokensByLogin = new Map([
  ['octocat', 'token-octocat'],
  ['work-user', 'token-work'],
  ['gh-only', null],
  ['refused', 'token-refused'],
]);
const execFileMock = mock((_cmd, args, _options, callback) => {
  ghRuns.push(args);
  const userAt = args.indexOf('--user');
  const login = userAt === -1 ? 'octocat' : args[userAt + 1];
  const token = tokensByLogin.get(login);
  if (!token) {
    callback(Object.assign(new Error('no oauth token'), { code: 1 }));
    return;
  }
  callback(null, { stdout: `${token}\n` });
});

mock.module('child_process', () => ({
  execFile: execFileMock,
}));

const { readGhCliLogins, findGhCliLogin } = await import('./gh-cli-logins.js');

// What GitHub answers for each token: the login's own account, or a refusal.
const accountsByToken = {
  'token-octocat': { id: 1, login: 'octocat', avatar_url: 'https://avatars/octocat', name: 'Octo Cat' },
  'token-work': { id: 2, login: 'work-user', name: 'Work User' },
  'token-refused': null,
};
const createOctokit = async (token) => ({
  rest: {
    users: {
      getAuthenticated: async () => {
        const data = accountsByToken[token];
        if (!data) throw Object.assign(new Error('Bad credentials'), { status: 401 });
        return { data };
      },
    },
  },
});

const createdDirs = [];
const setHostsYaml = (content) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-gh-logins-'));
  createdDirs.push(dir);
  process.env.GH_CONFIG_DIR = dir;
  fs.writeFileSync(path.join(dir, 'hosts.yml'), content);
  return dir;
};

const previousGhConfigDir = process.env.GH_CONFIG_DIR;
afterEach(() => {
  if (previousGhConfigDir === undefined) delete process.env.GH_CONFIG_DIR;
  else process.env.GH_CONFIG_DIR = previousGhConfigDir;
  for (const dir of createdDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  ghRuns.length = 0;
});

describe('readGhCliLogins', () => {
  test('lists every login gh holds for the host, the active one first', async () => {
    setHostsYaml([
      'github.com:',
      '  user: octocat',
      '  users:',
      '    octocat: {}',
      '    work-user: {}',
      '',
    ].join('\n'));
    const logins = await readGhCliLogins('github.com', { createOctokit });
    expect(logins.map((entry) => entry.login)).toEqual(['octocat', 'work-user']);
    expect(logins.map((entry) => entry.id)).toEqual([1, 2]);
    // The active login answers without `--user`, exactly as a host with one gh
    // account always has; another login is asked for by name.
    expect([...ghRuns].sort()).toEqual([
      ['auth', 'token'],
      ['auth', 'token', '--user', 'work-user'],
    ].sort());
  });

  test('leaves out a login gh has no token for and one GitHub refuses', async () => {
    setHostsYaml([
      'ghe.example.com:',
      '  user: octocat',
      '  users:',
      '    octocat: {}',
      '    gh-only: {}',
      '    refused: {}',
      '    work-user: {}',
      '',
    ].join('\n'));
    const logins = await readGhCliLogins('ghe.example.com', { createOctokit });
    expect(logins.map((entry) => entry.login)).toEqual(['octocat', 'work-user']);
  });

  test('falls back to gh\'s own token account when hosts.yml names no login', async () => {
    // gh can be signed in through GH_TOKEN in the environment without a
    // hosts.yml entry. gh then still answers a token, and the account behind it
    // is the host's only login — the answer earlier releases gave for every
    // host.
    setHostsYaml('other.example.com:\n  user: octocat\n  oauth_token: gho_other\n');
    const logins = await readGhCliLogins('github.com', { createOctokit });
    expect(logins.map((entry) => entry.login)).toEqual(['octocat']);
    expect(logins.map((entry) => entry.id)).toEqual([1]);
    expect(ghRuns).toEqual([['auth', 'token']]);
    // That login is a real account id, so an exact `#cli:` id resolves to it.
    await expect(findGhCliLogin('github.com', 'github.com#cli:1', { createOctokit }))
      .resolves.toMatchObject({ login: 'octocat' });
  });

  test('answers an empty list when gh has neither a stored login nor a token', async () => {
    setHostsYaml('other.example.com:\n  user: octocat\n');
    tokensByLogin.set('octocat', null);
    try {
      await expect(readGhCliLogins('github.com', { createOctokit })).resolves.toEqual([]);
    } finally {
      tokensByLogin.set('octocat', 'token-octocat');
    }
  });

  test('resolves the logins again once hosts.yml changes', async () => {
    const dir = setHostsYaml('github.com:\n  user: octocat\n');
    const first = await readGhCliLogins('github.com', { createOctokit });
    expect(first.map((entry) => entry.login)).toEqual(['octocat']);
    expect(ghRuns).toHaveLength(1);

    // Reused while hosts.yml is untouched: the identity read is not repeated.
    await readGhCliLogins('github.com', { createOctokit });
    expect(ghRuns).toHaveLength(1);

    // A gh login (here a new entry in the users map) rewrites hosts.yml, so the
    // next read sees the new account instead of the cached list.
    fs.writeFileSync(
      path.join(dir, 'hosts.yml'),
      'github.com:\n  user: octocat\n  users:\n    octocat: {}\n    work-user: {}\n',
    );
    const second = await readGhCliLogins('github.com', { createOctokit });
    expect(second.map((entry) => entry.login)).toEqual(['octocat', 'work-user']);
  });
});

describe('findGhCliLogin', () => {
  test('finds the login whose GitHub account id the account id names', async () => {
    setHostsYaml('github.com:\n  user: octocat\n  users:\n    octocat: {}\n    work-user: {}\n');
    const login = await findGhCliLogin('github.com', 'github.com#cli:2', { createOctokit });
    expect(login).toMatchObject({ id: 2, login: 'work-user', user: { login: 'work-user' } });
    // The placeholder id 0 names no account, and an id gh does not hold is not
    // another login in disguise.
    await expect(findGhCliLogin('github.com', 'github.com#cli:0', { createOctokit })).resolves.toBeNull();
    await expect(findGhCliLogin('github.com', 'github.com#cli:99', { createOctokit })).resolves.toBeNull();
    await expect(findGhCliLogin('github.com', 'github.com#cli:abc', { createOctokit })).resolves.toBeNull();
  });
});
