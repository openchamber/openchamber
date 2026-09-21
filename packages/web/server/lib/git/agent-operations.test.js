import { describe, expect, test } from 'bun:test';
import { createGitAgentOperations } from './agent-operations.js';

const endpoint = (name, role) => ({ displayUrl: `https://github.com/team/repo.git`, fingerprint: `${name}-${role}` });

const remote = (name) => ({ name, fetch: endpoint(name, 'fetch'), push: endpoint(name, 'push') });

const grant = (name, mode = 'managed', readiness = 'ready') => ({
  ...remote(name), mode, readiness, ...(mode === 'managed' ? { credentialId: `credential-${name}` } : {}),
});

const boundRead = (grants = [grant('origin')], remotes = grants.map((entry) => remote(entry.name))) => ({
  status: 'bound',
  revision: 3,
  repository: { repositoryId: 'repo_one', configRevision: 'config_one', bare: false, remotes },
  binding: { repositoryId: 'repo_one', configRevision: 'config_one', revision: 3, state: 'bound',
    providers: [], remotes: grants, auxiliary: [] },
});

const harness = ({ read = boundRead(), status = { current: 'main', tracking: 'origin/main' } } = {}) => {
  const planned = [];
  const executed = [];
  return {
    planned,
    executed,
    operations: createGitAgentOperations({
      networkOperations: {
        plan: async (request) => { planned.push(request); return { operationId: 'git_1' }; },
        execute: async (operationId) => {
          executed.push(operationId);
          return { state: 'succeeded', completedSteps: [{ step: 'push', status: 'succeeded' }] };
        },
      },
      readBinding: async () => read,
      readStatus: async () => status,
    }),
  };
};

const rejection = async (promise) => {
  try {
    await promise;
    throw new Error('Expected a refusal');
  } catch (error) {
    return error;
  }
};

describe('createGitAgentOperations', () => {
  test('pushes the current branch to its upstream through the bound transport', async () => {
    const { operations, planned, executed } = harness();
    const result = await operations.execute('push', { directory: '/repo' });
    expect(planned).toEqual([{
      operation: 'push',
      directory: '/repo',
      repositoryId: 'repo_one',
      bindingRevision: 3,
      configRevision: 'config_one',
      remote: { name: 'origin', endpoint: endpoint('origin', 'push') },
      sourceRef: 'refs/heads/main',
      destinationRef: 'refs/heads/main',
      transportMode: 'managed',
    }]);
    expect(executed).toEqual(['git_1']);
    expect(result).toEqual({
      operation: 'push', remote: 'origin', transport: 'managed', state: 'succeeded',
      completedSteps: [{ step: 'push', status: 'succeeded' }],
    });
  });

  test('fetches the whole remote without needing a branch', async () => {
    const { operations, planned } = harness({ status: { current: 'HEAD', tracking: null } });
    await operations.execute('fetch', { directory: '/repo' });
    expect(planned[0].operation).toBe('fetch');
    expect(planned[0].fetchScope).toBe('remote');
    expect(planned[0].sourceRef).toBeUndefined();
  });

  test('pulls the tracked branch into the checked out one', async () => {
    const { operations, planned } = harness({ status: { current: 'feature', tracking: 'origin/main' } });
    await operations.execute('pull', { directory: '/repo' });
    expect(planned[0].sourceRef).toBe('refs/heads/main');
    expect(planned[0].destinationRef).toBe('refs/heads/feature');
    expect(planned[0].remote.endpoint).toEqual(endpoint('origin', 'fetch'));
  });

  test('refuses a repository with no binding rather than transferring ambiently', async () => {
    const { operations, planned } = harness({ read: { status: 'missing', revision: 0, binding: null,
      repository: { repositoryId: 'repo_one', configRevision: 'config_one', bare: false, remotes: [remote('origin')] } } });
    const error = await rejection(operations.execute('push', { directory: '/repo' }));
    expect(error.code).toBe('GIT_AGENT_OPERATION_REFUSED');
    expect(error.message).toContain('not bound');
    expect(planned).toEqual([]);
  });

  test('refuses a remote whose grant no longer matches the repository', async () => {
    const stale = boundRead([{ ...grant('origin'), fetch: endpoint('origin', 'stale') }]);
    const { operations, planned } = harness({ read: stale });
    const error = await rejection(operations.execute('push', { directory: '/repo' }));
    expect(error.code).toBe('GIT_AGENT_OPERATION_REFUSED');
    expect(planned).toEqual([]);
  });

  test('refuses a grant that is not ready', async () => {
    const { operations } = harness({ read: boundRead([grant('origin', 'system', 'confirmation-required')]) });
    const error = await rejection(operations.execute('push', { directory: '/repo' }));
    expect(error.code).toBe('GIT_AGENT_OPERATION_REFUSED');
  });

  test('refuses to guess between several bound remotes, and accepts a named one', async () => {
    const read = boundRead([grant('upstream'), grant('mirror')]);
    const ambiguous = harness({ read });
    const error = await rejection(ambiguous.operations.execute('push', { directory: '/repo' }));
    expect(error.message).toContain('upstream, mirror');
    const named = harness({ read, status: { current: 'main', tracking: 'mirror/main' } });
    await named.operations.execute('push', { directory: '/repo', remote: 'mirror' });
    expect(named.planned[0].remote.name).toBe('mirror');
  });

  test('prefers origin when several remotes are bound', async () => {
    const { operations, planned } = harness({ read: boundRead([grant('mirror'), grant('origin')]) });
    await operations.execute('fetch', { directory: '/repo' });
    expect(planned[0].remote.name).toBe('origin');
  });

  test('refuses a detached HEAD and a branch with no upstream', async () => {
    const detached = harness({ status: { current: 'HEAD', tracking: null } });
    expect((await rejection(detached.operations.execute('push', { directory: '/repo' }))).message).toContain('detached');
    const untracked = harness({ status: { current: 'main', tracking: null } });
    expect((await rejection(untracked.operations.execute('push', { directory: '/repo' }))).message).toContain('does not track');
  });

  test('refuses to push through an anonymous read-only transport', async () => {
    const { operations, planned } = harness({ read: boundRead([grant('origin', 'anonymous')]) });
    const error = await rejection(operations.execute('push', { directory: '/repo' }));
    expect(error.message).toContain('read-only');
    expect(planned).toEqual([]);
    // The same grant still fetches, because reading is what it is for.
    const reader = harness({ read: boundRead([grant('origin', 'anonymous')]) });
    await reader.operations.execute('fetch', { directory: '/repo' });
    expect(reader.planned[0].transportMode).toBe('anonymous');
  });

  test('rejects an unknown operation and a missing directory before reading anything', async () => {
    const { operations, planned } = harness();
    expect((await rejection(operations.execute('clone', { directory: '/repo' }))).code).toBe('INVALID_REQUEST');
    expect((await rejection(operations.execute('push', { directory: '  ' }))).code).toBe('INVALID_REQUEST');
    expect(planned).toEqual([]);
  });
});
