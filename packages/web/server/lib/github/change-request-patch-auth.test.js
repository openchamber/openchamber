import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { expect, it, vi } from 'vitest';

it('marks only the rejected enterprise account invalid when a diff gets 401', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-enterprise-patch-'));
  const previous = process.env.OPENCHAMBER_DATA_DIR;
  process.env.OPENCHAMBER_DATA_DIR = directory;
  vi.resetModules();
  try {
    const auth = await import('./auth.js');
    const { githubDescriptor } = await import('./descriptor.js');
    const { createProviderDescriptors } = await import('../source-control/provider-descriptors.js');
    const { createSourceControlProviders } = await import('../source-control/provider-registry.js');
    const { registerProviderRoutes } = await import('../source-control/provider-routes.js');
    const instance = 'company.ghe.com';
    const account = await auth.setGitHubAuthForHost(instance, { accessToken: 'fixture', user: { id: 7, login: 'user' }, source: 'pat' });
    const sibling = await auth.setGitHubAuthForHost(instance, { accessToken: 'other-fixture', user: { id: 8, login: 'other' }, source: 'pat' });
    const providers = createSourceControlProviders({
      descriptors: createProviderDescriptors([githubDescriptor]),
      hostServices: { github: { resolveGitHubRepoFromDirectory: async () => ({ repo: { host: instance, owner: 'team', repo: 'app' } }) } },
    });
    const invalidated = vi.fn();
    providers.events.subscribe({ invalidated });
    const shell = registerProviderRoutes(express(), { providers });
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ message: 'Bad credentials' }, { status: 401 })));
    const context = { provider: 'github', instance, accountId: account.accountId, directory: '/repo', primaryRemote: 'origin' };
    await expect(shell.readChangeRequestPatch({ context, number: 7 })).rejects.toMatchObject({ status: 401 });
    expect(invalidated).toHaveBeenCalledOnce();
    expect(invalidated).toHaveBeenCalledWith({ provider: 'github', instance, accountId: account.accountId });
    expect(await auth.getGitHubAuthByAccountId(account.accountId)).toBeNull();
    expect(await auth.getGitHubAuthByAccountId(sibling.accountId)).not.toBeNull();
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ message: 'Forbidden' }, { status: 403 })));
    await expect(shell.readChangeRequestPatch({ context: { ...context, accountId: sibling.accountId }, number: 7 })).rejects.toMatchObject({ status: 403 });
    expect(invalidated).toHaveBeenCalledOnce();
    expect(await auth.getGitHubAuthByAccountId(sibling.accountId)).not.toBeNull();
  } finally {
    vi.unstubAllGlobals();
    if (previous === undefined) delete process.env.OPENCHAMBER_DATA_DIR;
    else process.env.OPENCHAMBER_DATA_DIR = previous;
    await fs.rm(directory, { recursive: true, force: true });
  }
});
