import { afterEach, describe, expect, it } from 'vitest';
import {
  createProviderDescriptors,
  publicProviderDescriptor,
  sourceControlProviderDescriptors,
} from './provider-descriptors.js';
import { extensionProviderId, isExtensionProviderId, isProviderId, isReservedProviderId } from './provider-id.js';
import { detachExtensionDescriptors } from './provider-descriptors.test-support.js';
import { BUILT_IN_SOURCE_CONTROL_PROVIDERS } from '../../../src/api/source-control-providers';

const github = sourceControlProviderDescriptors.get('github');
const gitlab = sourceControlProviderDescriptors.get('gitlab');
const gitea = sourceControlProviderDescriptors.get('gitea');

describe('source control provider descriptors', () => {
  it('lists the built-in providers in priority order', () => {
    expect(sourceControlProviderDescriptors.list().map((descriptor) => descriptor.id)).toEqual(['github', 'gitlab', 'gitea', 'gerrit', 'forgejo']);
    expect(sourceControlProviderDescriptors.has('gitlab')).toBe(true);
    expect(sourceControlProviderDescriptors.get('sourcehut')).toBeNull();
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
      .toEqual([['github', 'checks'], ['gitlab', 'pipeline'], ['gitea', 'checks'], ['gerrit', 'checks'], ['forgejo', 'checks']]);
    // A host without the diff read publishes it off; every built-in reads it.
    expect(publicProviderDescriptor({ ...gitea, capabilities: { ...gitea.capabilities, changeRequestPatch: false } }, 2).features.changeRequestPatch).toBe(false);
    expect(sourceControlProviderDescriptors.list().every((descriptor) => publicProviderDescriptor(descriptor, 0).features.changeRequestPatch)).toBe(true);
  });

  // A server without the providers route serves exactly GitHub and GitLab, so
  // the web adapter's fallback stays those two; every provider added since
  // comes after them in the published list.
  // Discussions came later, so a server that old has none and the fallback leaves them out.
  it('publishes the web adapter fallback for an older server as its leading providers', () => {
    const withoutDiscussions = (descriptor) => {
      const features = { ...descriptor.features };
      const urls = { ...descriptor.urls };
      delete features.discussions;
      delete urls.discussion;
      return { ...descriptor, features, urls };
    };
    const published = sourceControlProviderDescriptors.list().map((descriptor, order) => withoutDiscussions(publicProviderDescriptor(descriptor, order)));
    expect(published.slice(0, BUILT_IN_SOURCE_CONTROL_PROVIDERS.length)).toEqual(BUILT_IN_SOURCE_CONTROL_PROVIDERS);
    expect(BUILT_IN_SOURCE_CONTROL_PROVIDERS.map((descriptor) => descriptor.id)).toEqual(['github', 'gitlab']);
  });

  it('refuses a descriptor list with an invalid, reserved or duplicate id', () => {
    expect(() => createProviderDescriptors([{ id: 'Bad' }])).toThrow();
    expect(() => createProviderDescriptors([{ id: 'link' }])).toThrow();
    expect(() => createProviderDescriptors([{ id: 'binding' }])).toThrow();
    expect(() => createProviderDescriptors([github, github])).toThrow();
    expect(() => createProviderDescriptors([{ ...gitea, id: 'ext-gitea' }])).toThrow();
    expect(() => createProviderDescriptors([{ ...gitea, id: 'ext-' }])).toThrow();
  });
});

describe('extension provider descriptors', () => {
  afterEach(() => detachExtensionDescriptors());

  const extension = (id) => Object.freeze({ ...gitea, id });

  it('lists the built-ins first, then attached extensions sorted by id', () => {
    const before = sourceControlProviderDescriptors.list();
    sourceControlProviderDescriptors.attachExtension(extension('ext-zeta'));
    sourceControlProviderDescriptors.attachExtension(extension('ext-alpha'));

    const listed = sourceControlProviderDescriptors.list();
    expect(listed.map((descriptor) => descriptor.id)).toEqual(['github', 'gitlab', 'gitea', 'gerrit', 'forgejo', 'ext-alpha', 'ext-zeta']);
    expect(Object.isFrozen(listed)).toBe(true);
    expect(before.map((descriptor) => descriptor.id)).toEqual(['github', 'gitlab', 'gitea', 'gerrit', 'forgejo']);
    expect(sourceControlProviderDescriptors.has('ext-alpha')).toBe(true);
    expect(sourceControlProviderDescriptors.get('ext-zeta').id).toBe('ext-zeta');
  });

  it('replaces an attached extension with the same id and detaches it again', () => {
    const descriptors = createProviderDescriptors([gitea]);
    const first = extension('ext-forge');
    const second = extension('ext-forge');
    descriptors.attachExtension(first);
    descriptors.attachExtension(second);
    expect(descriptors.list()).toEqual([gitea, second]);

    expect(descriptors.detachExtension('ext-forge')).toBe(true);
    expect(descriptors.detachExtension('ext-forge')).toBe(false);
    expect(descriptors.detachExtension('gitea')).toBe(false);
    expect(descriptors.get('ext-forge')).toBeNull();
    expect(descriptors.list()).toEqual([gitea]);
  });

  it('attaches only extension ids', () => {
    const descriptors = createProviderDescriptors([gitea]);
    for (const id of ['gitea', 'forgejo', 'ext-', 'ext-Bad', undefined]) {
      expect(() => descriptors.attachExtension({ ...gitea, id })).toThrow();
    }
  });

  it('publishes the extension marker only when given', () => {
    expect(publicProviderDescriptor(gitea, 2)).not.toHaveProperty('extension');
    const marker = { guestId: 'forge', name: 'Forge', version: '1.0.0', token: { header: 'authorization' } };
    expect(publicProviderDescriptor(extension('ext-forge'), 3, marker).extension).toEqual({ guestId: 'forge', name: 'Forge', version: '1.0.0' });
  });
});

describe('provider ids', () => {
  it('accepts the open syntax and nothing else', () => {
    for (const id of ['github', 'gitlab', 'forgejo', 'a', 'gitea-2']) expect(isProviderId(id)).toBe(true);
    for (const id of ['', 'GitHub', '1abc', '-x', 'a'.repeat(33), 'git_hub', null, 7]) expect(isProviderId(id)).toBe(false);
    expect(isReservedProviderId('repository')).toBe(true);
    expect(isReservedProviderId('github')).toBe(false);
  });

  it('derives extension provider ids from guest ids that fit', () => {
    expect(extensionProviderId('forge')).toBe('ext-forge');
    expect(extensionProviderId('a'.repeat(28))).toBe(`ext-${'a'.repeat(28)}`);
    for (const guestId of ['a'.repeat(29), 'Forge', '1forge', '', null]) expect(extensionProviderId(guestId)).toBeNull();
    expect(isExtensionProviderId('ext-forge')).toBe(true);
    for (const id of ['gitea', 'ext-', 'ext-Forge', `ext-${'a'.repeat(29)}`, 7]) expect(isExtensionProviderId(id)).toBe(false);
  });

  describe('change-host extensions', () => {
    const changeHost = (capabilities, features = {}) => ({
      ...gitea,
      id: 'review',
      capabilities: { ...gitea.capabilities, ...capabilities },
      presentation: { ...gitea.presentation, features: { ...gitea.presentation.features, ...features } },
    });

    it('publishes the change-host features only when declared', () => {
      const published = publicProviderDescriptor(changeHost(
        { merge: { methods: ['submit'] }, reviewModel: 'votes', revisions: true, createVia: 'push' },
        { branchHeads: false, submitRequirements: true },
      ), 3);
      expect(published.features).toMatchObject({
        reviewModel: 'votes', revisions: true, createByPush: true, branchHeads: false, submitRequirements: true,
      });
      for (const descriptor of [github, gitlab, gitea]) {
        const features = publicProviderDescriptor(descriptor, 0).features;
        for (const key of ['reviewModel', 'revisions', 'createByPush', 'branchHeads', 'submitRequirements']) {
          expect(features).not.toHaveProperty(key);
        }
      }
    });

    it('refuses submit beside another merge method, and unknown change-host values', () => {
      expect(() => createProviderDescriptors([changeHost({ merge: { methods: ['submit', 'merge'] } })])).toThrow('submit must be the only method');
      expect(() => createProviderDescriptors([changeHost({ reviewModel: 'stars' })])).toThrow('review model');
      expect(() => createProviderDescriptors([changeHost({ createVia: 'email' })])).toThrow('create method');
      expect(() => createProviderDescriptors([changeHost({ revisions: 'yes' })])).toThrow('revisions');
      expect(createProviderDescriptors([changeHost({ merge: { methods: ['submit'] } })]).has('review')).toBe(true);
      const facade = createProviderDescriptors([]);
      expect(() => facade.attachExtension({ ...changeHost({ merge: { methods: ['squash', 'submit'] } }), id: 'ext-review' })).toThrow('submit');
    });
  });
});

