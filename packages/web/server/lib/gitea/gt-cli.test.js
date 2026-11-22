import { describe, expect, it, vi } from 'vitest';
import { createGtCli } from './gt-cli.js';

const ORIGIN = 'https://gitea.example.com';
// What a promisified execFile throws when gt exits non-zero.
const exit = (code, stderr = '') => Object.assign(new Error('Command failed: gt'), { code, stdout: '', stderr });
const missing = () => Object.assign(new Error('spawn gt ENOENT'), { code: 'ENOENT' });

describe('gt token lookup', () => {
  it('asks for the token of the exact instance without prompting', async () => {
    const execFile = vi.fn(async () => ({ stdout: 'gt-token\n', stderr: '' }));

    await expect(createGtCli({ execFile }).tokenResult(ORIGIN)).resolves.toEqual({ token: 'gt-token' });
    expect(execFile).toHaveBeenCalledWith('gt', ['auth', 'token', '--host', ORIGIN, '--no-input'], expect.objectContaining({ windowsHide: true }));
  });

  // gt 1.1.0's messages for an instance it has no token for, as it printed them.
  it.each([
    `Error: no account for ${ORIGIN}; run gt auth login --host ${ORIGIN}, or use -R or --host to target another instance\n`,
    `Error: account "bob" is not logged in on ${ORIGIN} (accounts: alice)\n`,
    `Error: no active account on ${ORIGIN} (accounts: alice, bob); pass --user or run gt auth switch\n`,
    `Error: alice on ${ORIGIN} signs requests with an SSH key and has no token\n`,
  ])('reads exit 4 with a no-login message as gone: %s', async (stderr) => {
    const execFile = vi.fn(async () => { throw exit(4, stderr); });
    await expect(createGtCli({ execFile }).tokenResult(ORIGIN)).resolves.toEqual({ gone: true });
  });

  it('leaves every other failure unsettled and never logs gt output', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cases = [
      [exit(4, 'Error: could not read the token from the keyring: locked\n'), 'unrecognized'],
      [exit(1, 'Error: something else\n'), 'unrecognized'],
      [missing(), 'missing'],
      [Object.assign(new Error('timed out'), { killed: true, code: null, signal: 'SIGTERM' }), 'timeout'],
    ];
    for (const [error, reason] of cases) {
      const execFile = vi.fn(async () => { throw error; });
      await expect(createGtCli({ execFile }).tokenResult(ORIGIN)).resolves.toEqual({ unknown: true, reason });
    }
    expect(warn.mock.calls.flat().join('\n')).not.toMatch(/keyring|something else/);
    warn.mockRestore();
  });

  it('refuses output that is not one token', async () => {
    const execFile = vi.fn(async () => ({ stdout: 'two words\n', stderr: '' }));
    await expect(createGtCli({ execFile }).tokenResult(ORIGIN)).resolves.toEqual({ unknown: true, reason: 'unrecognized' });
  });
});

describe('gt instances', () => {
  const configPath = { stdout: 'config\t/cfg/gitea-cli/config.yml\nhosts\t/cfg/gitea-cli/hosts.yml\n', stderr: '' };

  it('lists the instances whose active account has a token, as Gitea origins', async () => {
    const execFile = vi.fn(async () => configPath);
    const readFile = vi.fn(async () => [
      'version: "1"',
      'hosts:',
      '  https://gitea.example.com:',
      '    user: alice',
      '    users:',
      '      alice: { auth_method: token, credential_store: keyring }',
      '  http://localhost:3000:',
      '    user: bob',
      '    users:',
      '      bob: { auth_method: oauth }',
      '  https://ssh.example.com:',
      '    user: carol',
      '    users:',
      '      carol: { auth_method: ssh }',
      '  https://logged-out.example.com: {}',
      '  https://sub.example.com/gitea:',
      '    user: dave',
      '  http://plain.example.com:',
      '    user: erin',
    ].join('\n'));

    await expect(createGtCli({ execFile, readFile }).listInstances()).resolves.toEqual(['https://gitea.example.com', 'http://localhost:3000']);
    expect(execFile).toHaveBeenCalledWith('gt', ['config', 'path', '--no-input'], expect.any(Object));
    expect(readFile).toHaveBeenCalledWith('/cfg/gitea-cli/hosts.yml', 'utf8');
  });

  it('asks gt where hosts.yml is once, then reads the file each time', async () => {
    const execFile = vi.fn(async () => configPath);
    const readFile = vi.fn(async () => 'version: "1"\nhosts: {}\n');
    const cli = createGtCli({ execFile, readFile });

    await cli.listInstances();
    await cli.listInstances();
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(readFile).toHaveBeenCalledTimes(2);
  });

  it('lists nothing without gt or its hosts.yml, and looks for gt again a minute later', async () => {
    let clock = 0;
    let installed = false;
    const execFile = vi.fn(async () => { if (!installed) throw missing(); return configPath; });
    const readFile = vi.fn(async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); });
    const cli = createGtCli({ execFile, readFile, now: () => clock });

    await expect(cli.listInstances()).resolves.toEqual([]);
    installed = true;
    clock = 30_000;
    await expect(cli.listInstances()).resolves.toEqual([]);
    expect(execFile).toHaveBeenCalledTimes(1);
    clock = 61_000;
    // Found now; gt has not logged in anywhere yet, so there is no hosts.yml.
    await expect(cli.listInstances()).resolves.toEqual([]);
    expect(execFile).toHaveBeenCalledTimes(2);
    expect(readFile).toHaveBeenCalledTimes(1);
  });

  it('lists nothing from a hosts.yml that does not parse', async () => {
    const execFile = vi.fn(async () => configPath);
    for (const text of ['hosts: [1, 2', 'hosts: 3', '', 'hosts:\n  https://gitea.example.com: 7']) {
      await expect(createGtCli({ execFile, readFile: async () => text }).listInstances()).resolves.toEqual([]);
    }
  });
});
