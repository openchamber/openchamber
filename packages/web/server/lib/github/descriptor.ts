const INSTANCE_ERROR = 'GitHub instance must be an HTTPS origin';

function normalizeGitHubInstance(raw: string | undefined) {
  let host = String(raw).trim().toLowerCase().replace(/\.$/, '');
  if (host.includes('://')) {
    let url;
    try {
      url = new URL(host);
    } catch {
      throw new Error(INSTANCE_ERROR);
    }
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash
      || (url.pathname && url.pathname !== '/')) throw new Error(INSTANCE_ERROR);
    host = url.hostname.toLowerCase().replace(/\.$/, '');
  } else if (host) {
    let url;
    try {
      url = new URL(`https://${host}`);
    } catch {
      throw new Error(INSTANCE_ERROR);
    }
    if (url.username || url.password || url.port || url.search || url.hash
      || (url.pathname && url.pathname !== '/')) throw new Error(INSTANCE_ERROR);
    host = url.hostname.toLowerCase().replace(/\.$/, '');
  }
  return host;
}

export const githubDescriptor = Object.freeze({
  id: 'github',
  label: 'GitHub',
  terminology: Object.freeze({ changeRequest: 'pullRequest', ci: 'checks' }),
  referencePrefix: Object.freeze({ changeRequest: '#', issue: '#' }),
  iconId: 'github',
  instance: Object.freeze({
    form: 'host',
    defaultInstances: Object.freeze(['github.com']),
    normalize: normalizeGitHubInstance,
    origin: (instance: string) => new URL(`https://${instance}`),
  }),
  repositoryPath: 'owner/name',
  capabilities: Object.freeze({
    projects: true,
    issues: true,
    changeRequests: true,
    draftChangeRequests: true,
    draftConversion: true,
    merge: Object.freeze({ methods: Object.freeze(['merge', 'squash', 'rebase'] as const) }),
    ci: true,
    comments: true,
    commentEdit: true,
    reviews: true,
    state: true,
    labels: true,
    reviewers: true,
    reviewThreads: Object.freeze({ start: false, reply: true, resolve: true }),
    reviewDrafts: Object.freeze({ fileComments: true }),
    uploads: true,
    stacks: true,
    changeRequestPatch: true,
    liveSummaries: true,
    referencePicker: true,
    multipleAccounts: true,
    discussions: true,
  }),
  authMethods: Object.freeze({ device: true, pat: true, cli: Object.freeze({ tool: 'gh' }) }),
  transport: Object.freeze({
    httpsUsername: Object.freeze({ kind: 'fixed', value: 'x-access-token' }),
    managedHttpsInstances: 'default-only',
    appendDotGitToHttpsClone: false,
  }),
  urls: Object.freeze({
    thread: Object.freeze({
      hosts: Object.freeze(['github.com']),
      pattern: /^\/([^/]+)\/([^/]+)\/(pull|issues|discussions)\/(\d+)(?:\/|$)/,
    }),
  }),
  trackedItems: Object.freeze({ nestedOwners: false, defaultInstance: 'github.com', batchLimit: 100 }),
  limits: Object.freeze({
    commentMaxLength: 65536,
    reviewerId: /^[^\0\r\n]{1,256}$/,
    labelsMax: 100,
    reviewersMax: 50,
  }),
  identity: Object.freeze({
    noReplyEmail: (user: { login?: string; id?: number | string | undefined } | null | undefined) => (user?.login && Number.isInteger(user?.id)
      ? `${user.id}+${user.login}@users.noreply.github.com`
      : null),
  }),
  settings: Object.freeze([
    Object.freeze({ key: 'instance', type: 'instance-url', secret: false, scope: 'instance' }),
    Object.freeze({ key: 'token', type: 'personal-access-token', secret: true, scope: 'instance' }),
  ]),
  instances: Object.freeze({
    legacyFlow: Object.freeze({ instance: 'github.com', kind: 'github-com-device' }),
  }),
  presentation: Object.freeze({
    sharedNumberSpace: true,
    abbreviation: 'PR',
    promptNoun: 'pull request',
    icon: Object.freeze({ sprite: 'github', filledSprite: 'github-fill' }),
    instances: Object.freeze({
      multiple: true, allowLoopbackHttp: false, allowPort: false,
      reserved: Object.freeze(['github.com']), placeholder: 'https://github.example.com',
    }),
    cliTransport: true,
    token: Object.freeze({
      scopes: Object.freeze(['repo', 'read:org', 'workflow', 'read:user', 'user:email']),
      createPath: '/settings/tokens',
    }),
    urls: Object.freeze({
      changeRequest: Object.freeze(['/{owner}/{repo}/pull/{number}']),
      issue: Object.freeze(['/{owner}/{repo}/issues/{number}']),
      discussion: Object.freeze(['/{owner}/{repo}/discussions/{number}']),
      commit: Object.freeze(['/{owner}/{repo}/commit/{sha}']),
      user: Object.freeze(['/{user}']),
    }),
    features: Object.freeze({
      referenceSearch: true, referenceDetail: true, listStatuses: true, referencesAcross: true,
      startThread: false, authorCanReview: false, projectUploads: true, absoluteProjectUploads: true, issueCloseReason: true,
      issueEdit: true, changeRequestEdit: true, issueAssignees: true, issueCloseReasonWrite: true, commentEdit: true,
      advancedSearch: true,
      reviewDrafts: true, reviewDraftFileComments: true,
      changeRequestTemplates: Object.freeze([]),
    }),
  }),
  routeAliases: Object.freeze({
    authAliasPrefix: '/api/github',
    retiredGet: Object.freeze(['/pr/status', '/repo/upstream', '/repo/branches', '/issues/list', '/issues/get',
      '/issues/comments', '/pulls/list', '/pulls/context']),
    retiredPost: Object.freeze(['/pr/create', '/pr/update', '/pr/merge', '/pr/ready']),
    extraAuthAliases: Object.freeze({ '/auth/gh-cli': '/auth/cli' }),
  }),
});
