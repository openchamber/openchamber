import express from 'express';
import { expect, test, vi } from 'vitest';
import { registerProviderRoutes } from './provider-routes.js';
import { createFixLoopGitServices } from './fix-loop-git.js';
import { createProviderDescriptors } from './provider-descriptors.js';
import { githubDescriptor } from '../github/descriptor.js';
import { CONTEXT, HEAD, PULL, TARGET } from '../agent-server/fix-loop-test-fixture.js';

test('agent admission reuses binding validation and exact-account resource admission before any worker exists', async () => {
  const validateReadContext = vi.fn(async (input) => input);
  const resolveAccount = vi.fn(async () => ({ exactAccount: true }));
  const fixLoopPull = vi.fn(async () => PULL);
  const descriptors = createProviderDescriptors([githubDescriptor]);
  const providers = { list: descriptors.list, has: descriptors.has, describe: descriptors.describe,
    events: { subscribe() {} },
    implementation: async () => ({ auth: { resolveAccount }, resources: { fixLoopPull } }) };
  const shell = registerProviderRoutes(express(), { providers, validateReadContext });
  expect(await shell.readFixLoopPull({ context: CONTEXT, ...TARGET })).toEqual({ context: CONTEXT, pull: PULL });
  expect(validateReadContext).toHaveBeenCalledExactlyOnceWith(CONTEXT);
  expect(resolveAccount).toHaveBeenCalledExactlyOnceWith({ instance: 'github.com', accountId: 'account' });
  expect(fixLoopPull.mock.calls[0][0]).toMatchObject({ context: CONTEXT, project: { owner: 'upstream', name: 'app' }, number: 7, session: { exactAccount: true } });
  validateReadContext.mockRejectedValue(Object.assign(new Error('stale'), { code: 'SOURCE_CONTROL_BINDING_STALE' }));
  await expect(shell.readFixLoopPull({ context: CONTEXT, ...TARGET })).rejects.toMatchObject({ code: 'SOURCE_CONTROL_BINDING_STALE' });
  expect(fixLoopPull).toHaveBeenCalledOnce();
});
test('fetch-head can run a single project operation without accepting a remote loop identity', async () => {
  const context = { ...CONTEXT, credentialId: 'not-forwarded' };
  const source = { context, requestedRemoteName: 'openchamber-fix-internal' };
  const resolveChangeRequestSource = vi.fn(async () => source);
  const transferContributorHead = vi.fn(async () => ({ state: 'succeeded' }));
  const service = createFixLoopGitServices({ bindings: { resolveChangeRequestSource }, network: { transferContributorHead },
    resolveAccount: async () => ({ status: 'valid', credentialId: 'credential', credentialRevision: 1, providerUserId: 'github.com#1' }) });
  await service.fetchHead({ ...TARGET, directory: '/repo', readContext: CONTEXT }, { headSha: HEAD });
  const request = resolveChangeRequestSource.mock.calls[0][0];
  expect(request).toMatchObject({ context: CONTEXT, project: { id: 'upstream/app', owner: 'upstream', name: 'app' }, number: 7, expectedHeadSha: HEAD });
  expect(request.requestedRemoteName).toMatch(/^openchamber-fix-[0-9a-f]{16}$/);
  expect(transferContributorHead.mock.calls[0][0].destinationRef).toBe('refs/remotes/openchamber-fix-internal/head');
  // Retries for one pull request reuse one ref; another pull request gets its own.
  await service.fetchHead({ ...TARGET, owner: 'UPSTREAM', directory: '/repo', readContext: CONTEXT }, { headSha: HEAD });
  await service.fetchHead({ ...TARGET, number: 8, directory: '/repo', readContext: CONTEXT }, { headSha: HEAD });
  const names = resolveChangeRequestSource.mock.calls.map(([input]) => input.requestedRemoteName);
  expect(names[1]).toBe(names[0]);
  expect(names[2]).not.toBe(names[0]);
});
