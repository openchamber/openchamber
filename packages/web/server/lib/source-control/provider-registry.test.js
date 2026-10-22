import { describe, expect, it, vi } from 'vitest';
import { createAccountEvents, createSourceControlProviders } from './provider-registry.js';
import { createProviderDescriptors, sourceControlProviderDescriptors } from './provider-descriptors.js';
import { gitlabDescriptor } from '../gitlab/descriptor.js';
import { githubDescriptor } from '../github/descriptor.js';

const fakeLoader = (impl) => vi.fn(async () => ({ createProvider: vi.fn((services) => ({ ...impl, services })) }));

describe('source control provider registry', () => {
  it('lists the descriptors in priority order without loading any implementation', () => {
    const loaders = { github: vi.fn(), gitlab: vi.fn() };
    const providers = createSourceControlProviders({ loaders });
    expect(providers.list().map((descriptor) => descriptor.id)).toEqual(['github', 'gitlab', 'gitea']);
    expect(providers.describe('gitlab')).toBe(gitlabDescriptor);
    expect(providers.has('forgejo')).toBe(false);
    expect(loaders.github).not.toHaveBeenCalled();
    expect(loaders.gitlab).not.toHaveBeenCalled();
  });

  it('loads an implementation once, on first use, with its host services', async () => {
    const gitlab = fakeLoader({ id: 'fake-gitlab' });
    const store = { readInstance: vi.fn() };
    const authStore = { section: vi.fn() };
    const providers = createSourceControlProviders({
      authStore, loaders: { gitlab }, hostServices: { gitlab: { store } },
    });
    const [first, second] = await Promise.all([providers.implementation('gitlab'), providers.implementation('gitlab')]);
    expect(first).toBe(second);
    expect(gitlab).toHaveBeenCalledOnce();
    expect(first.services).toMatchObject({ descriptor: gitlabDescriptor, authStore, store, events: providers.events });
  });

  it('answers null for an unknown id or a provider without a loader', async () => {
    const providers = createSourceControlProviders({ loaders: {} });
    await expect(providers.implementation('forgejo')).resolves.toBeNull();
    await expect(providers.implementation('gitlab')).resolves.toBeNull();
    await expect(providers.readTransportCredential({ provider: 'forgejo', instance: 'x', credentialId: 'y' })).resolves.toBeNull();
  });

  it('tries a failed load again on the next request', async () => {
    let attempts = 0;
    const gitlab = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('module failed');
      return { createProvider: () => ({ ok: true }) };
    });
    const providers = createSourceControlProviders({ loaders: { gitlab } });
    await expect(providers.implementation('gitlab')).rejects.toThrow('module failed');
    await expect(providers.implementation('gitlab')).resolves.toEqual({ ok: true });
  });

  it('reads a transport credential through the provider that owns it', async () => {
    const readCredential = vi.fn(async () => ({ credentialId: 'one', secret: 'token' }));
    const providers = createSourceControlProviders({
      loaders: { gitlab: fakeLoader({ transport: { readCredential } }) },
    });
    await expect(providers.readTransportCredential({
      provider: 'gitlab', instance: 'https://gitlab.com', credentialId: 'one', credentialRevision: 2,
    })).resolves.toEqual({ credentialId: 'one', secret: 'token' });
    expect(readCredential).toHaveBeenCalledWith({ instance: 'https://gitlab.com', credentialId: 'one', credentialRevision: 2 });
  });

  it('serves only the descriptors it was given, so a registry can hold one provider', () => {
    const providers = createSourceControlProviders({
      descriptors: createProviderDescriptors([gitlabDescriptor]), loaders: {},
    });
    expect(providers.list()).toEqual([gitlabDescriptor]);
    expect(sourceControlProviderDescriptors.list()).toContain(githubDescriptor);
  });
});

describe('account events', () => {
  it('awaits every listener in order and stops calling one that unsubscribed', async () => {
    const events = createAccountEvents();
    const calls = [];
    events.subscribe({ invalidated: async (identity) => { await Promise.resolve(); calls.push(['first', identity.accountId]); } });
    const unsubscribe = events.subscribe({ invalidated: (identity) => calls.push(['second', identity.accountId]) });
    await events.invalidated({ accountId: 'one' });
    unsubscribe();
    await events.invalidated({ accountId: 'two' });
    expect(calls).toEqual([['first', 'one'], ['second', 'one'], ['first', 'two']]);
    await expect(events.connected({})).resolves.toBeUndefined();
  });

  it('passes a listener failure to the reporter, so storage is not changed after it', async () => {
    const events = createAccountEvents();
    events.subscribe({ removed: async () => { throw Object.assign(new Error('busy'), { code: 'SOURCE_CONTROL_LOCK_BUSY' }); } });
    await expect(events.removed({ accountId: 'one' })).rejects.toMatchObject({ code: 'SOURCE_CONTROL_LOCK_BUSY' });
  });
});

describe('extension providers in the registry', () => {
  const descriptor = Object.freeze({
    ...gitlabDescriptor, id: 'ext-forge', label: 'Forge',
    extension: { guestId: 'forge', name: 'Forge', version: '1.0.0', token: { header: 'authorization', scheme: 'token' } },
  });
  const guest = { id: 'forge', name: 'Forge', packageRoot: '/pkg', service: { entry: 'service/main.js' }, capabilityGrants: ['service'] };
  const setup = () => {
    const descriptors = createProviderDescriptors([githubDescriptor]);
    const handles = { revokeGuest: vi.fn() };
    const authStore = { section: vi.fn((id) => ({ id })) };
    const providers = createSourceControlProviders({ descriptors, authStore, loaders: {}, extensionServices: { handles, persistPath: '/store.json' } });
    return { providers, descriptors, handles, authStore };
  };

  it('lists a registered extension after the built-ins and builds it on first use with its own auth section', async () => {
    const { providers, authStore } = setup();
    providers.registerExtension({ descriptor, guest });
    expect(providers.list().map(({ id }) => id)).toEqual(['github', 'ext-forge']);
    expect(providers.has('ext-forge')).toBe(true);
    const impl = await providers.implementation('ext-forge');
    expect(impl.descriptor).toBe(descriptor);
    expect(authStore.section).toHaveBeenCalledWith('ext-forge');
    await expect(providers.implementation('ext-forge')).resolves.toBe(impl);
  });

  it('unregistering forgets the implementation and ends the guest handles', async () => {
    const { providers, handles } = setup();
    providers.registerExtension({ descriptor, guest });
    await providers.implementation('ext-forge');
    expect(providers.unregisterExtension('ext-forge')).toBe(true);
    expect(handles.revokeGuest).toHaveBeenCalledWith('forge');
    expect(providers.has('ext-forge')).toBe(false);
    await expect(providers.implementation('ext-forge')).resolves.toBeNull();
    expect(providers.unregisterExtension('ext-forge')).toBe(false);
  });

  it('unregistering disposes the built implementation, so a running call cannot store an account', async () => {
    const { providers } = setup();
    providers.registerExtension({ descriptor, guest });
    const impl = await providers.implementation('ext-forge');
    providers.unregisterExtension('ext-forge');
    await vi.waitFor(() => expect(impl.auth.activate({ instance: 'https://forge.example', accountId: 'a' }))
      .rejects.toMatchObject({ code: 'SOURCE_CONTROL_PROVIDER_UNAVAILABLE' }));
  });

  it('refuses an extension where the runtime offers no extension services', () => {
    const providers = createSourceControlProviders({ descriptors: createProviderDescriptors([githubDescriptor]), loaders: {} });
    expect(() => providers.registerExtension({ descriptor, guest })).toThrow('unavailable');
  });
});
