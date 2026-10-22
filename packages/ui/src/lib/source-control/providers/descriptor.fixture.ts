import type { SourceControlProviderDescriptor } from './descriptor';

/** A provider the UI has no code for: path icon, PAT only, origin instances, `/pulls/` links. */
export const acmeDescriptor = (overrides: Partial<SourceControlProviderDescriptor> = {}): SourceControlProviderDescriptor => ({
  id: 'acme',
  label: 'Acme Forge',
  order: 5,
  terminology: {
    changeRequest: 'pullRequest', changeRequestPrefix: '#', issuePrefix: '#',
    sharedNumberSpace: true, abbreviation: 'PR', promptNoun: 'pull request', ci: 'checks',
  },
  icon: { path: 'M12 2L2 22h20L12 2z' },
  repository: { nestedNamespaces: false },
  instances: {
    format: 'origin', defaultInstance: null, multiple: true, allowLoopbackHttp: true, allowPort: true,
    reserved: [], placeholder: 'https://forge.example.com',
  },
  auth: { methods: ['pat'], cliTransport: false, token: { scopes: ['repo'], createPath: '/user/settings/applications' } },
  settings: {
    fields: [
      { id: 'instance', kind: 'instance-url', secret: false },
      { id: 'token', kind: 'personal-access-token', secret: true },
    ],
  },
  urls: { changeRequest: ['/{owner}/{repo}/pulls/{number}'], issue: ['/{owner}/{repo}/issues/{number}'] },
  features: {
    referenceSearch: false, referenceDetail: false, listStatuses: false, referencesAcross: false,
    startThread: false, authorCanReview: false, projectUploads: false, issueCloseReason: true,
    changeRequestTemplates: [],
  },
  ...overrides,
});

export const githubLikeDescriptor = (): SourceControlProviderDescriptor => acmeDescriptor({
  id: 'github',
  label: 'GitHub',
  order: 0,
  icon: { sprite: 'github', filledSprite: 'github-fill' },
  instances: {
    format: 'host', defaultInstance: 'github.com', multiple: true, allowLoopbackHttp: false, allowPort: false,
    reserved: ['github.com'], placeholder: 'https://github.example.com',
  },
  urls: { changeRequest: ['/{owner}/{repo}/pull/{number}'], issue: ['/{owner}/{repo}/issues/{number}'] },
});

export const gitlabLikeDescriptor = (): SourceControlProviderDescriptor => acmeDescriptor({
  id: 'gitlab',
  label: 'GitLab',
  order: 1,
  terminology: {
    changeRequest: 'mergeRequest', changeRequestPrefix: '!', issuePrefix: '#',
    sharedNumberSpace: false, abbreviation: 'MR', promptNoun: 'merge request', ci: 'pipeline',
  },
  icon: { sprite: 'gitlab' },
  repository: { nestedNamespaces: true },
  instances: {
    format: 'origin', defaultInstance: 'https://gitlab.com', multiple: true, allowLoopbackHttp: true, allowPort: true,
    reserved: [], placeholder: 'https://gitlab.example.com',
  },
  urls: {
    changeRequest: ['/{namespace+}/{repo}/-/merge_requests/{number}'],
    issue: ['/{namespace+}/{repo}/-/issues/{number}', '/{namespace+}/{repo}/-/work_items/{number}'],
  },
});
