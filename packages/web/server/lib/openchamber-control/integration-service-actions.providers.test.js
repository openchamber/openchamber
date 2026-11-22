import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerSourceControlRoutes } from '../source-control/routes.js';
import { createIntegrationServiceActions } from './integration-service-actions.js';

// The agent tool's github.* and gitlab.* account actions run through the
// source-control routes' accountOperations, which reach the provider
// registry's implementation. Oracle: the fake provider's auth method is
// called with the instance and arguments the action names, and its answer
// (or its route-shaped refusal) is what the action returns.

const GITLAB = 'https://gitlab.example.com';
const SEED = 'SEEDED-TOKEN-4c1d';

const responseError = (status, body) => Object.assign(new Error(body.error), { sourceControlResponse: { status, body } });

const fakeAuth = (provider) => ({
  status: vi.fn(async ({ instance }) => ({ provider, instance, connected: true, accounts: [{ id: `${provider}-a`, current: true, accessToken: SEED }] })),
  accounts: vi.fn(async () => []),
  connectToken: vi.fn(async () => ({ connected: true })),
  addFromVault: vi.fn(async ({ instance, reference }) => ({ connected: true, instance, user: { login: 'vault-user' }, tokenReference: reference, token: SEED })),
  activate: vi.fn(async ({ instance, accountId }) => {
    if (accountId === 'missing') throw responseError(404, { error: `${provider} account not found` });
    return { provider, instance, connected: true, current: accountId };
  }),
  remove: vi.fn(async ({ accountId }) => ({ removed: accountId !== 'missing' })),
  setCliDisabled: vi.fn(async ({ disabled }) => ({ available: true, disabled })),
  listInstances: vi.fn(async () => (provider === 'gitlab' ? [GITLAB] : ['github.com'])),
  listConnectedAccounts: vi.fn(async () => []),
  readCurrentAccountId: vi.fn(async () => null),
});

const tempDirs = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const setup = async () => {
  const configRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-account-ops-'));
  tempDirs.push(configRoot);
  const implementations = { github: { auth: fakeAuth('github') }, gitlab: { auth: fakeAuth('gitlab') } };
  const providers = {
    list: () => [],
    describe: () => null,
    implementation: async (id) => implementations[id] ?? null,
    events: { subscribe: () => () => {} },
    readTransportCredential: async () => null,
    registerExtension: () => {},
    unregisterExtension: () => {},
  };
  const app = express();
  const sourceControl = registerSourceControlRoutes(app, {
    configRoot,
    providers,
    identityProvisioning: { backfillAccountIdentities: () => {}, ensureAccountIdentity: () => {}, repointAccountIdentities: () => {} },
  });
  const actions = createIntegrationServiceActions({
    getIntegrationOperations: () => ({ ...sourceControl.accountOperations, bindings: sourceControl.bindingOperations }),
  });
  return { github: implementations.github.auth, gitlab: implementations.gitlab.auth, run: (action, input = {}) => actions.execute(action, input, {}) };
};

describe('github account actions reach the GitHub provider', () => {
  it('github.status reads the github.com status, without tokens', async () => {
    const { github, run } = await setup();
    const answer = await run('github.status');
    expect(github.status).toHaveBeenCalledWith({ instance: 'github.com' });
    expect(answer).toMatchObject({ provider: 'github', instance: 'github.com', connected: true });
    expect(JSON.stringify(answer)).not.toContain(SEED);
  });

  it('github.activate switches the account, and a refusal keeps the provider status', async () => {
    const { github, run } = await setup();
    await expect(run('github.activate', { accountId: 'github-b' })).resolves.toMatchObject({ current: 'github-b' });
    expect(github.activate).toHaveBeenCalledWith({ instance: 'github.com', accountId: 'github-b' });
    await expect(run('github.activate', { accountId: 'missing' })).rejects.toMatchObject({ statusCode: 404, message: 'github account not found' });
  });

  it('github.addFromVault hands the reference to the provider and never the token', async () => {
    const { github, run } = await setup();
    const answer = await run('github.addFromVault', { tokenReference: 'op://Vault/github/token' });
    expect(github.addFromVault).toHaveBeenCalledWith({ instance: 'github.com', reference: 'op://Vault/github/token' });
    expect(answer).toMatchObject({ connected: true, tokenReference: 'op://Vault/github/token' });
    expect(JSON.stringify(answer)).not.toContain(SEED);
  });

  it('github.remove signs the account out', async () => {
    const { github, run } = await setup();
    await expect(run('github.remove', { accountId: 'github-a', confirm: true })).resolves.toEqual({ removed: true });
    expect(github.remove).toHaveBeenCalledWith({ instance: 'github.com', accountId: 'github-a' });
  });

  it('github.cli turns the gh login off', async () => {
    const { github, run } = await setup();
    await expect(run('github.cli', { disabled: true })).resolves.toEqual({ available: true, disabled: true });
    expect(github.setCliDisabled).toHaveBeenCalledWith({ instance: 'github.com', disabled: true });
  });
});

describe('gitlab account actions reach the GitLab provider', () => {
  it('gitlab.status lists every stored instance, and one instance on request', async () => {
    const { gitlab, run } = await setup();
    const all = await run('gitlab.status');
    expect(gitlab.listInstances).toHaveBeenCalled();
    expect(all.instances).toEqual([expect.objectContaining({ instance: GITLAB, connected: true })]);
    await run('gitlab.status', { instance: GITLAB });
    expect(gitlab.status).toHaveBeenCalledWith({ instance: GITLAB });
    expect(JSON.stringify(all)).not.toContain(SEED);
  });

  it('gitlab.activate switches the account on the instance', async () => {
    const { gitlab, run } = await setup();
    await expect(run('gitlab.activate', { instance: GITLAB, accountId: 'gitlab-b' })).resolves.toMatchObject({ current: 'gitlab-b' });
    expect(gitlab.activate).toHaveBeenCalledWith({ instance: GITLAB, accountId: 'gitlab-b' });
  });

  it('gitlab.addFromVault hands the reference to the provider for that instance', async () => {
    const { gitlab, run } = await setup();
    const answer = await run('gitlab.addFromVault', { instance: GITLAB, tokenReference: 'op://Vault/gitlab/token' });
    expect(gitlab.addFromVault).toHaveBeenCalledWith({ instance: GITLAB, reference: 'op://Vault/gitlab/token' });
    expect(JSON.stringify(answer)).not.toContain(SEED);
  });

  it('gitlab.remove signs the account out on the instance', async () => {
    const { gitlab, run } = await setup();
    await expect(run('gitlab.remove', { instance: GITLAB, accountId: 'gitlab-a', confirm: true })).resolves.toEqual({ removed: true });
    expect(gitlab.remove).toHaveBeenCalledWith({ instance: GITLAB, accountId: 'gitlab-a' });
  });

  it('gitlab.cli turns the glab login off on the instance', async () => {
    const { gitlab, run } = await setup();
    await expect(run('gitlab.cli', { instance: GITLAB, disabled: true })).resolves.toEqual({ available: true, disabled: true });
    expect(gitlab.setCliDisabled).toHaveBeenCalledWith({ instance: GITLAB, disabled: true });
  });
});
