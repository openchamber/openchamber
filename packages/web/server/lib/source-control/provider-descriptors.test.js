import { describe, expect, it } from 'vitest';
import {
  createProviderDescriptors,
  publicProviderDescriptor,
  sourceControlProviderDescriptors,
} from './provider-descriptors.js';
import { isProviderId, isReservedProviderId } from './provider-id.js';
import { BUILT_IN_SOURCE_CONTROL_PROVIDERS } from '../../../src/api/source-control-providers';

const github = sourceControlProviderDescriptors.get('github');
const gitlab = sourceControlProviderDescriptors.get('gitlab');
const gitea = sourceControlProviderDescriptors.get('gitea');

describe('source control provider descriptors', () => {
  it('lists the built-in providers in priority order', () => {
    expect(sourceControlProviderDescriptors.list().map((descriptor) => descriptor.id)).toEqual(['github', 'gitlab', 'gitea']);
    expect(sourceControlProviderDescriptors.has('gitlab')).toBe(true);
    expect(sourceControlProviderDescriptors.get('forgejo')).toBeNull();
  });

  it.each([
    ['github.com', 'github.com'],
    ['GitHub.com.', 'github.com'],
    ['HTTPS://GHE.Example.com/', 'ghe.example.com'],
    ['ghe.example.com', 'ghe.example.com'],
  ])('normalizes the GitHub instance %s as before', (input, expected) => {
    expect(github.instance.normalize(input)).toBe(expected);
  });

  it.each([
    'https://ghe.example.com/api/v3', 'https://user@example.com', 'https://example.com:8443', 'http://ghe.example.com', 'git hub.com',
  ])('refuses the GitHub instance %s', (input) => {
    expect(() => github.instance.normalize(input)).toThrow('GitHub instance must be an HTTPS origin');
  });

  it.each([
    ['gitlab.com', 'https://gitlab.com'],
    ['https://GitLab.Example.com:8443/', 'https://gitlab.example.com:8443'],
    ['http://127.0.0.1:8080', 'http://127.0.0.1:8080'],
    ['http://localhost:3000', 'http://localhost:3000'],
  ])('normalizes the GitLab instance %s as before', (input, expected) => {
    expect(gitlab.instance.normalize(input)).toBe(expected);
  });

  it.each([
    ['http://gitlab.example.com', 'GitLab instances must use HTTPS'],
    ['https://gitlab.example.com/group', 'GitLab instance must be an origin'],
    ['https://user:pass@gitlab.example.com', 'GitLab instance must be an origin'],
    ['', 'GitLab instance is required'],
  ])('refuses the GitLab instance %s', (input, message) => {
    expect(() => gitlab.instance.normalize(input)).toThrow(message);
  });

  it.each([
    ['gitea.example.com', 'https://gitea.example.com'],
    ['https://Gitea.Example.com:3000/', 'https://gitea.example.com:3000'],
    ['http://localhost:3000', 'http://localhost:3000'],
  ])('normalizes the Gitea instance %s to its origin', (input, expected) => {
    expect(gitea.instance.normalize(input)).toBe(expected);
  });

  it.each([
    ['http://gitea.example.com', 'Gitea instances must use HTTPS'],
    ['https://example.com/gitea/', 'Gitea instance must be an origin'],
    ['https://token@gitea.example.com', 'Gitea instance must be an origin'],
  ])('refuses the Gitea instance %s', (input, message) => {
    expect(() => gitea.instance.normalize(input)).toThrow(message);
  });

  it('describes Gitea as a token-only provider without threads, uploads or stacks', () => {
    expect(gitea.instance.defaultInstances).toEqual([]);
    expect(gitea.authMethods).toEqual({ device: false, pat: true, cli: false });
    expect(gitea.transport.httpsUsername).toEqual({ kind: 'login' });
    expect(gitea.capabilities).toMatchObject({
      merge: { methods: ['merge', 'squash', 'rebase'] },
      reviewThreads: { start: false, reply: false, resolve: false },
      uploads: false, stacks: false, referencePicker: false,
    });
    const published = publicProviderDescriptor(gitea, 2);
    expect(published).toMatchObject({ id: 'gitea', auth: { methods: ['pat'] }, instances: { defaultInstance: null } });
    expect(published.icon.path).toMatch(/^[MmLlHhVvCcSsQqTtAaZz0-9eE.,\s+-]+$/);
  });

  it('builds the origin every caller used to spell out per provider', () => {
    expect(github.instance.origin('github.com').origin).toBe('https://github.com');
    expect(github.instance.origin('ghe.example.com').origin).toBe('https://ghe.example.com');
    expect(gitlab.instance.origin('https://gitlab.example.com:8443').origin).toBe('https://gitlab.example.com:8443');
  });

  it('keeps the transport username and clone policy each provider had', () => {
    expect(github.transport).toMatchObject({ httpsUsername: { kind: 'fixed', value: 'x-access-token' }, managedHttpsInstances: 'default-only', appendDotGitToHttpsClone: false });
    expect(gitlab.transport).toMatchObject({ httpsUsername: { kind: 'fixed', value: 'oauth2' }, managedHttpsInstances: 'any', appendDotGitToHttpsClone: true });
    expect(gitlab.capabilities.merge.methods).toEqual(['merge', 'squash']);
  });

  it('publishes plain JSON without functions, patterns or transport policy', () => {
    for (const [order, descriptor] of sourceControlProviderDescriptors.list().entries()) {
      const published = publicProviderDescriptor(descriptor, order);
      expect(JSON.parse(JSON.stringify(published))).toEqual(published);
      expect(published).not.toHaveProperty('transport');
      expect(published).not.toHaveProperty('capabilities');
    }
    expect(publicProviderDescriptor(github, 0).terminology).toMatchObject({ changeRequest: 'pullRequest', changeRequestPrefix: '#' });
    expect(publicProviderDescriptor(gitlab, 1).auth).toMatchObject({ methods: ['device', 'pat', 'cli'], cliName: 'glab' });
    // The noun English model-facing text uses for the automation on a change request.
    expect(sourceControlProviderDescriptors.list().map((descriptor) => [descriptor.id, publicProviderDescriptor(descriptor, 0).terminology.ci]))
      .toEqual([['github', 'checks'], ['gitlab', 'pipeline'], ['gitea', 'checks']]);
  });

  // A server without the providers route serves exactly GitHub and GitLab, so
  // the web adapter's fallback stays those two; every provider added since
  // comes after them in the published list.
  it('publishes the web adapter fallback for an older server as its leading providers', () => {
    const published = sourceControlProviderDescriptors.list().map((descriptor, order) => publicProviderDescriptor(descriptor, order));
    expect(published.slice(0, BUILT_IN_SOURCE_CONTROL_PROVIDERS.length)).toEqual(BUILT_IN_SOURCE_CONTROL_PROVIDERS);
    expect(BUILT_IN_SOURCE_CONTROL_PROVIDERS.map((descriptor) => descriptor.id)).toEqual(['github', 'gitlab']);
  });

  it('refuses a descriptor list with an invalid, reserved or duplicate id', () => {
    expect(() => createProviderDescriptors([{ id: 'Bad' }])).toThrow();
    expect(() => createProviderDescriptors([{ id: 'link' }])).toThrow();
    expect(() => createProviderDescriptors([{ id: 'binding' }])).toThrow();
    expect(() => createProviderDescriptors([github, github])).toThrow();
  });
});

describe('provider ids', () => {
  it('accepts the open syntax and nothing else', () => {
    for (const id of ['github', 'gitlab', 'forgejo', 'a', 'gitea-2']) expect(isProviderId(id)).toBe(true);
    for (const id of ['', 'GitHub', '1abc', '-x', 'a'.repeat(33), 'git_hub', null, 7]) expect(isProviderId(id)).toBe(false);
    expect(isReservedProviderId('repository')).toBe(true);
    expect(isReservedProviderId('github')).toBe(false);
  });
});
