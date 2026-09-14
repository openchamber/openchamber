import { describe, expect, test } from 'bun:test';
import { createGitShellBoundaryRuntime } from './shell-boundary-runtime.js';

const bound = {
  status: 'bound', revision: 1,
  repository: { repositoryId: 'repo_one', configRevision: 'config_one', bare: false, remotes: [] },
  binding: { repositoryId: 'repo_one', configRevision: 'config_one', revision: 1, state: 'bound',
    providers: [], remotes: [{ name: 'origin', mode: 'managed', readiness: 'ready' }], auxiliary: [] },
};
const missing = { status: 'missing', revision: 0, binding: null,
  repository: { repositoryId: 'repo_one', configRevision: 'config_one', bare: false, remotes: [] } };

const harness = ({ binding = bound, port = 4399, isRepositoryEnabled = null } = {}) => createGitShellBoundaryRuntime({
  isRepositoryEnabled,
  readBinding: async (directory) => {
    if (directory === '/not-a-repo') throw new Error('Not a repository');
    return binding;
  },
  getActivePort: () => port,
});

const ask = async (runtime, { token, body }) => {
  let handler;
  runtime.registerRoutes({ post: (_path, route) => { handler = route; } });
  let status = 200;
  let answer;
  await handler(
    { socket: { remoteAddress: '127.0.0.1' }, headers: { authorization: `Bearer ${token}` }, body },
    { set: () => {}, status: (code) => { status = code; return { end: () => {} }; }, json: (value) => { answer = value; } },
  );
  return { status, answer };
};

const armed = (options) => {
  const runtime = harness(options);
  const env = runtime.prepareManagedOpenCodeEnv();
  return { runtime, env, token: env.OPENCHAMBER_SHELL_BOUNDARY_TOKEN };
};

describe('createGitShellBoundaryRuntime', () => {
  test('publishes a loopback endpoint and a fresh token', () => {
    const { env } = armed();
    expect(env.OPENCHAMBER_SHELL_BOUNDARY_URL).toBe('http://127.0.0.1:4399/api/git/shell-boundary');
    expect(env.OPENCHAMBER_SHELL_BOUNDARY_TOKEN).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(harness({ port: 0 }).prepareManagedOpenCodeEnv()).toEqual({});
  });

  test('refuses a transfer in a configured repository and says what to use instead', async () => {
    const { runtime, token } = armed();
    const { answer } = await ask(runtime, { token, body: { command: 'git push origin main', directory: '/repo' } });
    expect(answer.blocked).toBe(true);
    expect(answer.reason).toContain('git.push');
  });

  test('leaves local work alone', async () => {
    const { runtime, token } = armed();
    for (const command of ['git status', 'git commit -m "fix"', 'npm test']) {
      expect((await ask(runtime, { token, body: { command, directory: '/repo' } })).answer).toEqual({ blocked: false });
    }
  });

  test('leaves a repository nobody configured alone, because there is nowhere to send the agent', async () => {
    const unbound = armed({ binding: missing });
    expect((await ask(unbound.runtime, { token: unbound.token, body: { command: 'git push', directory: '/repo' } })).answer)
      .toEqual({ blocked: false });
    const withoutTransport = armed({ binding: { ...bound, binding: { ...bound.binding, remotes: [] } } });
    expect((await ask(withoutTransport.runtime, { token: withoutTransport.token, body: { command: 'git push', directory: '/repo' } })).answer)
      .toEqual({ blocked: false });
  });

  test('leaves a repository the person put on System Git alone', async () => {
    // The credential helper hands those requests back to their own chain, so
    // refusing the same command here would contradict the choice they made.
    const system = armed({ binding: { ...bound, binding: { ...bound.binding,
      remotes: [{ name: 'origin', mode: 'system', readiness: 'ready' }] } } });
    expect((await ask(system.runtime, { token: system.token, body: { command: 'git push', directory: '/repo' } })).answer)
      .toEqual({ blocked: false });
    // One managed remote is enough to mean OpenChamber answers for this repository.
    const mixed = armed({ binding: { ...bound, binding: { ...bound.binding, remotes: [
      { name: 'origin', mode: 'system', readiness: 'ready' },
      { name: 'upstream', mode: 'managed', readiness: 'ready' },
    ] } } });
    expect((await ask(mixed.runtime, { token: mixed.token, body: { command: 'git push', directory: '/repo' } })).answer.blocked)
      .toBe(true);
  });

  test('allows rather than blocks when it cannot tell', async () => {
    const { runtime, token } = armed();
    expect((await ask(runtime, { token, body: { command: 'git push', directory: '/not-a-repo' } })).answer)
      .toEqual({ blocked: false });
    expect((await ask(runtime, { token, body: { command: 'git push' } })).answer).toEqual({ blocked: false });
    expect((await ask(runtime, { token, body: { directory: '/repo' } })).answer).toEqual({ blocked: false });
  });

  test('leaves a repository the person excluded alone', async () => {
    const excluded = armed({ isRepositoryEnabled: async () => false });
    expect((await ask(excluded.runtime, { token: excluded.token, body: { command: 'git push', directory: '/repo' } })).answer)
      .toEqual({ blocked: false });
  });

  test('answers nothing without the current token', async () => {
    const { runtime } = armed();
    expect((await ask(runtime, { token: 'wrong', body: { command: 'git push', directory: '/repo' } })).status).toBe(403);
  });
});
