import { describe, expect, expectTypeOf, it } from 'vitest';
import { createProviderDescriptors } from './provider-descriptors.js';
import type { ProviderDescriptor, ProviderImplementation, ProviderMutationContext, ProviderMutations, ProviderReadContext, ProviderSession } from './provider-contract.js';
import type { createExtensionProvider } from './extension-provider.js';
import type { sourceControlProviderSchemasV1 } from '@openchamber/sdk/schemas';
import type { z } from 'zod';

type IsUntyped<Value> = 0 extends 1 & Value ? true : false;

describe('provider owner contracts', () => {
  it('returns only the shape checked by each extension response schema', () => {
    type Resources = ReturnType<typeof createExtensionProvider>['resources'];
    expectTypeOf<Awaited<ReturnType<Resources['readChangeRequestPatch']>>>()
      .toEqualTypeOf<z.output<typeof sourceControlProviderSchemasV1.data.readChangeRequestPatch>>();
    expectTypeOf<Awaited<ReturnType<Resources['readChangeRequestFile']>>>()
      .toEqualTypeOf<z.output<typeof sourceControlProviderSchemasV1.data.readChangeRequestFile>>();
    expectTypeOf<Awaited<ReturnType<Resources['readChangeRequestHead']>>>()
      .toEqualTypeOf<z.output<typeof sourceControlProviderSchemasV1.data.readChangeRequestHead>>();
  });

  it('returns typed descriptors from the registry', () => {
    const registry = createProviderDescriptors();
    const untyped: IsUntyped<ReturnType<typeof registry.get>> = false;
    expect(untyped).toBe(false);
    const descriptor: ProviderDescriptor | null = registry.get('github');
    expect(descriptor?.identity.noReplyEmail?.({ login: 'alice', id: undefined })).toBeNull();
    expect(registry.get('missing')).toBeNull();
  });

  it('carries validated read and mutation authority without replacing it with JSON', async () => {
    const context: ProviderReadContext = {
      directory: '/repo', repositoryId: 'repo', provider: 'github', instance: 'github.com',
      accountId: 'account', bindingRevision: 1, primaryRemote: 'origin', linked: true,
    };
    const mutation: ProviderMutationContext = {
      ...context, idempotencyKey: 'key',
      target: { repositoryId: 'repo', bindingRevision: 1, primaryRemote: 'origin', project: { id: 'o/r', owner: 'o', name: 'r' } },
    };
    const session: ProviderSession = {
      instance: 'github.com', accountId: 'account', credentialRevision: 1,
      providerUserId: 'user', secretKind: 'pat', persisted: true,
    };
    const read: NonNullable<ProviderImplementation['resources']['projectUpstream']> = async ({ context }) => ({
      directory: context.directory, primaryRemote: context.primaryRemote,
    });
    const resolve: ProviderMutations<{ number: number }, { number: number }>['resolveTarget'] = async ({ context, replayOf, input }) => ({
      providerTarget: { number: input.number }, target: replayOf?.target ?? context.target,
    });
    expect(await read({ context, session, directory: context.directory, remote: context.primaryRemote }))
      .toEqual({ directory: '/repo', primaryRemote: 'origin' });
    expect((await resolve({ context: mutation, session, kind: 'create', input: { number: 7 } })).target).toBe(mutation.target);
  });
});
