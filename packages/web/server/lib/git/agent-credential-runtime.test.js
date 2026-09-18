import { describe, expect, test } from 'bun:test';
import { createGitAgentCredentialRuntime } from './agent-credential-runtime.js';

const endpoint = (url, fingerprint) => ({ displayUrl: url, fingerprint });
const GITHUB = 'https://github.com/team/repo.git';

const remote = (name = 'origin', url = GITHUB) => ({
  name, fetch: endpoint(url, `${name}-fetch`), push: endpoint(url, `${name}-push`),
});

const grant = (overrides = {}) => ({
  ...remote(), mode: 'managed', readiness: 'ready',
  credentialId: 'ocgit:v2:https:github:Z2l0aHViLmNvbQ:YWNjb3VudC0x:1:dXNlci0x', ...overrides,
});

const read = (grants = [grant()], remotes = [remote()]) => ({
  status: 'bound', revision: 2,
  repository: { repositoryId: 'repo_one', configRevision: 'config_one', bare: false, remotes },
  binding: { repositoryId: 'repo_one', configRevision: 'config_one', revision: 2, state: 'bound',
    providers: [], remotes: grants, auxiliary: [] },
});

const query = (host = 'github.com', protocol = 'https') => `protocol=${protocol}\nhost=${host}\n`;

const harness = ({
  binding = read(),
  grants = [{ mode: 'managed', displayUrl: GITHUB }],
  resolve = async () => ({ mode: 'managed', transport: 'https', username: 'x-access-token', password: 'secret-value' }),
  port = 4399,
  env = {},
  isRepositoryEnabled = null,
} = {}) => {
  const resolved = [];
  return {
    resolved,
    runtime: createGitAgentCredentialRuntime({
      readBinding: async (directory) => {
        if (directory === '/not-a-repo') throw new Error('Not a repository');
        return binding;
      },
      listRemoteGrants: async () => grants,
      credentialResolver: { resolve: async (input) => { resolved.push(input); return resolve(input); } },
      isRepositoryEnabled,
      getActivePort: () => port,
      helperPath: '/opt/openchamber/helper.js',
      nodePath: '/usr/bin/node',
      env,
    }),
  };
};

/** The route body the helper posts, answered through the registered handler. */
const ask = async (runtime, payload) => {
  let handler;
  runtime.registerRoutes({ post: (_path, route) => { handler = route; } });
  let status = 200;
  let body;
  await handler(
    { socket: { remoteAddress: '127.0.0.1' }, headers: { authorization: `Bearer ${payload.token}` }, body: payload.body },
    { set: () => {}, status: (code) => { status = code; return { end: () => {} }; }, json: (value) => { body = value; } },
  );
  return { status, body };
};

const armed = async (options) => {
  const { runtime, resolved } = harness(options);
  const env = await runtime.prepareManagedOpenCodeEnv();
  return { runtime, env, resolved, token: env.OPENCHAMBER_GIT_CREDENTIAL_TOKEN };
};

describe('createGitAgentCredentialRuntime', () => {
  test('severs the credential chain for bound hosts and installs the helper after it', async () => {
    const { env } = await armed();
    expect(env.GIT_CONFIG_COUNT).toBe('2');
    expect(env.GIT_CONFIG_KEY_0).toBe('credential.https://github.com.helper');
    expect(env.GIT_CONFIG_VALUE_0).toBe('');
    expect(env.GIT_CONFIG_KEY_1).toBe('credential.https://github.com.helper');
    expect(env.GIT_CONFIG_VALUE_1).toBe("!'/usr/bin/node' '/opt/openchamber/helper.js'");
    expect(env.OPENCHAMBER_GIT_CREDENTIAL_URL).toBe('http://127.0.0.1:4399/api/git/agent-credential');
    expect(env.OPENCHAMBER_GIT_CREDENTIAL_TOKEN).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test('injects nothing when no binding names an HTTPS host', async () => {
    expect(await (await harness({ grants: [] })).runtime.prepareManagedOpenCodeEnv()).toEqual({});
    // SSH and anonymous grants claim no host: neither answers through a helper.
    const ssh = harness({ grants: [{ mode: 'managed', displayUrl: 'git@github.com:team/repo.git' },
      { mode: 'anonymous', displayUrl: GITHUB }] });
    expect(await ssh.runtime.prepareManagedOpenCodeEnv()).toEqual({});
  });

  test('continues an inherited GIT_CONFIG_COUNT instead of overwriting it', async () => {
    const { env } = await armed({ env: { GIT_CONFIG_COUNT: '2' } });
    expect(env.GIT_CONFIG_KEY_2).toBe('credential.https://github.com.helper');
    expect(env.GIT_CONFIG_KEY_3).toBe('credential.https://github.com.helper');
    expect(env.GIT_CONFIG_KEY_0).toBeUndefined();
    expect(env.GIT_CONFIG_COUNT).toBe('4');
  });

  test('answers a bound repository with its bound account', async () => {
    const { runtime, token, resolved } = await armed();
    const answer = await ask(runtime, { token, body: { cwd: '/repo', query: query() } });
    expect(answer.body).toEqual({ mode: 'managed', username: 'x-access-token', password: 'secret-value' });
    expect(resolved[0].credentialId).toBe('ocgit:v2:https:github:Z2l0aHViLmNvbQ:YWNjb3VudC0x:1:dXNlci0x');
    expect(resolved[0].endpoint).toEqual({ protocol: 'https', host: 'github.com', port: 443, path: '/team/repo.git' });
  });

  test('hands a System Git repository back to the person own chain', async () => {
    const { runtime, token } = await armed({
      binding: read([grant({ mode: 'system', credentialId: undefined })]),
      grants: [{ mode: 'system', displayUrl: GITHUB }],
    });
    expect((await ask(runtime, { token, body: { cwd: '/repo', query: query() } })).body).toEqual({ mode: 'system' });
  });

  test('hands an excluded repository back to the person own chain', async () => {
    // The host's chain is severed for the whole process, so answering nothing
    // would leave the repository without the setup they asked to keep.
    const { runtime, token, resolved } = await armed({ isRepositoryEnabled: async () => false });
    expect((await ask(runtime, { token, body: { cwd: '/repo', query: query() } })).body).toEqual({ mode: 'system' });
    expect(resolved).toEqual([]);
  });

  test('answers nothing for what nobody bound', async () => {
    const unbound = await armed({ binding: { status: 'missing', revision: 0, binding: null,
      repository: { repositoryId: 'repo_one', configRevision: 'config_one', bare: false, remotes: [remote()] } } });
    expect((await ask(unbound.runtime, { token: unbound.token, body: { cwd: '/repo', query: query() } })).body)
      .toEqual({ mode: 'none' });

    const elsewhere = await armed();
    expect((await ask(elsewhere.runtime, { token: elsewhere.token, body: { cwd: '/repo', query: query('gitlab.com') } })).body)
      .toEqual({ mode: 'none' });

    const outside = await armed();
    expect((await ask(outside.runtime, { token: outside.token, body: { cwd: '/not-a-repo', query: query() } })).body)
      .toEqual({ mode: 'none' });
  });

  test('answers nothing once the binding no longer matches the repository', async () => {
    const stale = await armed({ binding: read([grant({ fetch: endpoint(GITHUB, 'moved') })]) });
    expect((await ask(stale.runtime, { token: stale.token, body: { cwd: '/repo', query: query() } })).body)
      .toEqual({ mode: 'none' });
    const pending = await armed({ binding: read([grant({ readiness: 'confirmation-required' })]) });
    expect((await ask(pending.runtime, { token: pending.token, body: { cwd: '/repo', query: query() } })).body)
      .toEqual({ mode: 'none' });
  });

  test('answers nothing when the account behind the grant is gone', async () => {
    const { runtime, token } = await armed({ resolve: async () => { throw new Error('Managed provider account is unavailable'); } });
    expect((await ask(runtime, { token, body: { cwd: '/repo', query: query() } })).body).toEqual({ mode: 'none' });
  });

  test('refuses a request without the current token, and never leaves one armed for an empty injection', async () => {
    const { runtime, token } = await armed();
    expect((await ask(runtime, { token: 'wrong', body: { cwd: '/repo', query: query() } })).status).toBe(403);
    const { runtime: quiet } = harness({ grants: [] });
    await quiet.prepareManagedOpenCodeEnv();
    expect((await ask(quiet, { token: 'anything', body: { cwd: '/repo', query: query() } })).status).toBe(403);
  });

  test('ignores a query that is not HTTPS', async () => {
    const { runtime, token } = await armed();
    expect((await ask(runtime, { token, body: { cwd: '/repo', query: query('github.com', 'ssh') } })).body)
      .toEqual({ mode: 'none' });
  });
});
