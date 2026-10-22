import { afterEach, describe, expect, it } from 'vitest';
import { sourceControlProviderListSchema } from '@openchamber/ui/lib/source-control/providers/descriptor';
import { buildExtensionDescriptor } from './extension-descriptor.js';
import { publicProviderDescriptor, sourceControlProviderDescriptors } from './provider-descriptors.js';
import { detachExtensionDescriptors } from './provider-descriptors.test-support.js';

const contribution = (overrides = {}) => ({
  wire: 1,
  label: 'Forge',
  terminology: { changeRequest: 'pullRequest', ci: 'checks' },
  referencePrefix: { changeRequest: '#', issue: '#' },
  repositoryPath: 'owner/name',
  instances: {
    defaultInstances: ['https://forge.example.com'],
    custom: false,
    allowLoopbackHttp: false,
    allowPort: false,
    placeholder: 'https://forge.example.com',
  },
  capabilities: {
    projects: true, issues: true, changeRequests: true, draftChangeRequests: false,
    merge: { methods: ['merge'] }, ci: false, comments: true, reviews: false,
    state: true, labels: false, reviewers: false, changeRequestPatch: false, liveSummaries: true,
  },
  token: { header: 'authorization', scheme: 'token', scopes: ['repo'], createPath: '/user/settings/applications' },
  transport: { httpsUsername: { kind: 'login' }, appendDotGitToHttpsClone: false },
  limits: { commentMaxLength: 65_536, reviewerId: 'login', labelsMax: 20, reviewersMax: 10 },
  trackedItems: { batchLimit: 25 },
  presentation: {
    abbreviation: 'PR',
    promptNoun: 'pull request',
    sharedNumberSpace: true,
    iconPath: 'M2 6h15v5.5z',
    urls: { changeRequest: ['/{owner}/{repo}/pulls/{number}'], issue: ['/{owner}/{repo}/issues/{number}'] },
    features: { authorCanReview: true, issueCloseReason: false },
    changeRequestTemplates: ['.forge/pull_request_template.md'],
  },
  ...overrides,
});
const guest = { name: 'Forge for OpenChamber', version: '1.2.0' };
const build = (overrides, guestId = 'forge') => buildExtensionDescriptor({ guestId, contribution: contribution(overrides), guest });
const threadPatternOf = (overrides) => build(overrides).urls.thread.pattern;

const isDeeplyFrozen = (value) => {
  if (Object(value) !== value || value instanceof RegExp || value instanceof Function) return true;
  return Object.isFrozen(value) && Object.values(value).every(isDeeplyFrozen);
};

afterEach(() => detachExtensionDescriptors());

describe('extension source-control descriptors', () => {
  it('derives the id from the guest and freezes the whole descriptor', () => {
    const descriptor = build();
    expect(descriptor.id).toBe('ext-forge');
    expect(isDeeplyFrozen(descriptor)).toBe(true);
    expect(descriptor.extension).toEqual({
      guestId: 'forge', name: guest.name, version: guest.version, token: { header: 'authorization', scheme: 'token' },
    });
  });

  it('fixes what the host owns whatever the extension declares', () => {
    const descriptor = build();
    expect(descriptor.authMethods).toEqual({ device: false, pat: true, cli: false });
    expect(descriptor.capabilities).toMatchObject({
      reviewThreads: { start: false, reply: false, resolve: false },
      uploads: false, stacks: false, referencePicker: false, multipleAccounts: true,
      merge: { methods: ['merge'] }, liveSummaries: true,
    });
    expect(descriptor.transport).toEqual({ httpsUsername: { kind: 'login' }, managedHttpsInstances: 'any', appendDotGitToHttpsClone: false });
    expect(descriptor.settings.map((field) => [field.type, field.scope])).toEqual([['instance-url', 'instance'], ['personal-access-token', 'instance']]);
    expect(descriptor.identity.noReplyEmail).toBeNull();
    expect(descriptor.instances.legacyFlow).toBeNull();
    expect(descriptor).not.toHaveProperty('routeAliases');
    expect(descriptor.presentation.features).toMatchObject({
      referenceSearch: false, referenceDetail: false, listStatuses: false, referencesAcross: false, projectUploads: false,
      // Starting a thread needs review threads, which stay off.
      startThread: false, authorCanReview: true,
    });
    expect(descriptor.terminology).toEqual({ changeRequest: 'pullRequest', ci: 'checks' });
    expect(descriptor.trackedItems).toEqual({ nestedOwners: false, defaultInstance: null, batchLimit: 25 });
  });

  it('creates through the API only and builds the same descriptor when no change-based field is declared', () => {
    const descriptor = build();
    // Absent means `api`: an extension never creates by push.
    expect(descriptor.capabilities).not.toHaveProperty('createVia');
    expect(descriptor.capabilities).not.toHaveProperty('reviewModel');
    expect(descriptor.capabilities).not.toHaveProperty('revisions');
    // Branch heads keep the UI's default: an extension cannot turn them off.
    expect(descriptor.presentation.features).not.toHaveProperty('branchHeads');
    expect(descriptor.presentation.features).not.toHaveProperty('submitRequirements');
    expect(descriptor.settings.map((field) => field.key)).toEqual(['instance', 'token']);
  });

  it('passes the change-based fields through, and still creates through the API', () => {
    const descriptor = build({
      terminology: { changeRequest: 'change', ci: 'checks' },
      capabilities: { ...contribution().capabilities, reviews: true, merge: { methods: ['submit'] }, reviewModel: 'votes', revisions: true },
      token: { header: 'authorization', scheme: 'basic', username: true, scopes: [] },
      presentation: { ...contribution().presentation, features: { authorCanReview: false, issueCloseReason: false, submitRequirements: true } },
    });
    expect(isDeeplyFrozen(descriptor)).toBe(true);
    expect(descriptor.terminology.changeRequest).toBe('change');
    expect(descriptor.capabilities).toMatchObject({
      merge: { methods: ['submit'] }, reviewModel: 'votes', revisions: true, stacks: false,
    });
    expect(descriptor.capabilities).not.toHaveProperty('createVia');
    expect(descriptor.presentation.features.submitRequirements).toBe(true);
    expect(descriptor.presentation.features).not.toHaveProperty('branchHeads');
    expect(descriptor.extension.token).toEqual({ header: 'authorization', scheme: 'basic' });
    expect(descriptor.settings.map((field) => [field.key, field.type, field.secret])).toEqual([
      ['instance', 'instance-url', false], ['username', 'username', false], ['token', 'personal-access-token', true],
    ]);
  });

  it('serves only the declared instances unless the extension allows custom ones', () => {
    const pinned = build();
    expect(pinned.instance.form).toBe('origin');
    expect(pinned.instance.defaultInstances).toEqual(['https://forge.example.com']);
    expect(pinned.instance.normalize('Forge.Example.com/')).toBe('https://forge.example.com');
    expect(() => pinned.instance.normalize('https://other.example.com')).toThrow(/does not serve/);
    expect(pinned.urls.thread.hosts).toEqual(['forge.example.com']);

    const open = build({ instances: { ...contribution().instances, custom: true } });
    expect(open.instance.normalize('https://other.example.com')).toBe('https://other.example.com');
    expect(open.urls.thread.hosts).toBe('any');
    expect(() => open.instance.normalize('https://other.example.com/path')).toThrow(/must be an origin/);
  });

  it('refuses loopback HTTP and ports unless declared', () => {
    const strict = build({ instances: { ...contribution().instances, custom: true } });
    expect(() => strict.instance.normalize('http://localhost:3000')).toThrow(/HTTPS/);
    expect(() => strict.instance.normalize('https://forge.example.com:8443')).toThrow(/port/);

    const local = build({ instances: { ...contribution().instances, custom: true, allowLoopbackHttp: true, allowPort: true } });
    expect(local.instance.normalize('http://localhost:3000')).toBe('http://localhost:3000');
  });

  it('never serves a host a built-in provider serves, declared or entered', () => {
    for (const origin of ['https://github.com', 'https://gitlab.com', 'https://GitHub.com/']) {
      expect(() => build({ instances: { ...contribution().instances, defaultInstances: [origin] } })).toThrow(/default instance.*built-in/);
    }
    const open = build({ instances: { ...contribution().instances, custom: true, allowPort: true } });
    expect(() => open.instance.normalize('https://github.com')).toThrow(/built-in/);
    expect(() => open.instance.normalize('gitlab.com')).toThrow(/built-in/);
    expect(() => open.instance.normalize('https://gitlab.com:8443')).toThrow(/built-in/);
    expect(open.instance.normalize('https://gitlab.example.com')).toBe('https://gitlab.example.com');
  });

  it('refuses a guest id too long for a provider id, a foreign wire and broken defaults', () => {
    expect(() => build(undefined, 'a'.repeat(29))).toThrow(/guest id/);
    expect(build(undefined, 'a'.repeat(28)).id).toBe(`ext-${'a'.repeat(28)}`);
    expect(() => build(undefined, 'Forge')).toThrow(/guest id/);
    expect(() => build({ wire: 2 })).toThrow(/wire/);
    expect(() => build({ instances: { ...contribution().instances, defaultInstances: ['http://forge.example.com'] } })).toThrow(/default instance/);
    expect(() => build({ instances: { ...contribution().instances, defaultInstances: [] } })).toThrow(/default one/);
  });

  it('compiles the thread pattern from the URL templates', () => {
    const { pattern } = build().urls.thread;
    expect(pattern.exec('/alice/app/pulls/12/files')?.[1]).toBe('/alice/app/pulls/12');
    expect(pattern.exec('/alice/app/issues/3')?.[1]).toBe('/alice/app/issues/3');
    expect(pattern.exec('/alice/app/pulls/12x')).toBeNull();
    expect(pattern.exec('/alice/app/tree/main')).toBeNull();

    const nested = build({
      repositoryPath: 'namespace/name',
      presentation: {
        ...contribution().presentation,
        urls: { changeRequest: ['/{namespace+}/{repo}/-/merge_requests/{number}'], issue: [] },
      },
    });
    expect(nested.urls.thread.pattern.exec('/group/sub/app/-/merge_requests/7/diffs')?.[1]).toBe('/group/sub/app/-/merge_requests/7');
    expect(nested.trackedItems.nestedOwners).toBe(true);
  });

  it('escapes literal segments, so a template cannot smuggle in regular expression syntax', () => {
    const pattern = threadPatternOf({
      presentation: { ...contribution().presentation, urls: { changeRequest: ['/{owner}/{repo}/p.r(s)*/{number}'], issue: [] } },
    });
    expect(pattern.test('/alice/app/p.r(s)*/1')).toBe(true);
    expect(pattern.test('/alice/app/pXr(s)*/1')).toBe(false);
    expect(pattern.test('/alice/app/prsss/1')).toBe(false);
  });

  it('refuses templates that do not name owner, repo and number once, or use unknown placeholders', () => {
    const withUrls = (changeRequest) => ({ presentation: { ...contribution().presentation, urls: { changeRequest, issue: [] } } });
    expect(() => build(withUrls(['/{owner}/pulls/{number}']))).toThrow(/owner, repo and number/);
    expect(() => build(withUrls(['/{owner}/{owner}/{repo}/{number}']))).toThrow(/owner, repo and number/);
    expect(() => build(withUrls(['/{owner}/{repo}/{id}/{number}']))).toThrow(/unknown placeholder/);
    expect(() => build(withUrls(['{owner}/{repo}/{number}']))).toThrow(/path/);
    expect(() => build(withUrls(['/{owner}//{repo}/{number}']))).toThrow(/empty segment/);
    expect(() => build(withUrls(Array.from({ length: 9 }, () => '/{owner}/{repo}/{number}')))).toThrow(/templates/);
  });

  it('compiles a pattern that stays fast on a hostile path', () => {
    const pattern = threadPatternOf({
      repositoryPath: 'namespace/name',
      presentation: {
        ...contribution().presentation,
        urls: {
          changeRequest: ['/{namespace+}/{repo}/{number}', '/{namespace+}/{repo}/-/x/{number}'],
          issue: ['/{namespace+}/{repo}/-/y/{number}'],
        },
      },
    });
    // Unbounded `(a+)+`-shaped repetition would take exponential time here.
    const hostile = `/${'a/'.repeat(5_000)}${'a'.repeat(5_000)}!`;
    const started = performance.now();
    expect(pattern.test(hostile)).toBe(false);
    expect(performance.now() - started).toBeLessThan(250);
    // Every repetition is bounded.
    expect(pattern.source).not.toMatch(/[+*]/);
  });

  it('publishes plain JSON the UI registry parses, with the extension marker', () => {
    const descriptor = build();
    const published = publicProviderDescriptor(descriptor, 3, descriptor.extension);
    expect(JSON.parse(JSON.stringify(published))).toEqual(published);
    expect(published.extension).toEqual({ guestId: 'forge', name: guest.name, version: guest.version });
    expect(published).toMatchObject({
      id: 'ext-forge', order: 3, auth: { methods: ['pat'], token: { scopes: ['repo'], createPath: '/user/settings/applications' } },
      instances: { format: 'origin', defaultInstance: 'https://forge.example.com', multiple: false },
      icon: { path: 'M2 6h15v5.5z' },
    });
    const [parsed] = sourceControlProviderListSchema.parse([published]);
    expect(parsed).toMatchObject({ id: 'ext-forge', label: 'Forge', order: 3, auth: { methods: ['pat'] } });

    const markless = build({ presentation: { ...contribution().presentation, iconPath: undefined } });
    expect(sourceControlProviderListSchema.parse([publicProviderDescriptor(markless, 4)])[0].icon).toEqual({ sprite: 'git-branch' });
  });

  it('publishes the change-based features only when declared', () => {
    const plain = publicProviderDescriptor(build(), 3, build().extension);
    for (const key of ['reviewModel', 'revisions', 'createByPush', 'branchHeads', 'submitRequirements']) {
      expect(plain.features).not.toHaveProperty(key);
    }
    expect(plain.settings.fields.map((field) => field.kind)).toEqual(['instance-url', 'personal-access-token']);

    const change = build({
      terminology: { changeRequest: 'change', ci: 'checks' },
      capabilities: { ...contribution().capabilities, reviews: true, merge: { methods: ['submit'] }, reviewModel: 'votes', revisions: true },
      token: { header: 'authorization', scheme: 'basic', username: true, scopes: [] },
      presentation: { ...contribution().presentation, features: { authorCanReview: false, issueCloseReason: false, submitRequirements: true } },
    });
    const published = publicProviderDescriptor(change, 3, change.extension);
    expect(published.terminology.changeRequest).toBe('change');
    expect(published.features).toMatchObject({ reviewModel: 'votes', revisions: true, submitRequirements: true });
    expect(published.features).not.toHaveProperty('createByPush');
    expect(published.features).not.toHaveProperty('branchHeads');
    expect(published.settings.fields).toContainEqual({ id: 'username', kind: 'username', secret: false });
  });

  it('is visible through the process-wide facade once attached', () => {
    const descriptor = build();
    sourceControlProviderDescriptors.attachExtension(descriptor);
    expect(sourceControlProviderDescriptors.get('ext-forge')).toBe(descriptor);
    expect(sourceControlProviderDescriptors.list().map((entry) => entry.id)).toEqual(['github', 'gitlab', 'gitea', 'gerrit', 'ext-forge']);
  });
});
