/**
 * GitHub's static description: synchronous and SDK-free, so the Git layer,
 * bindings and the client can read it without loading Octokit.
 */
const INSTANCE_ERROR = 'GitHub instance must be an HTTPS origin';

/**
 * A GitHub instance is a bare hostname: github.com, or any other host for
 * GitHub Enterprise. This checks the form only; whether a non-github.com host
 * may receive a token is the trust gate's call (host-trust.js), never this one.
 */
function normalizeGitHubInstance(raw) {
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
    // A scheme-less value must form a valid origin callers can build an
    // https://<instance> URL from; one that cannot fails here with the same
    // readable error the https:// branch uses.
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
    origin: (instance) => new URL(`https://${instance}`),
  }),
  repositoryPath: 'owner/name',
  capabilities: Object.freeze({
    projects: true,
    issues: true,
    changeRequests: true,
    draftChangeRequests: true,
    merge: Object.freeze({ methods: Object.freeze(['merge', 'squash', 'rebase']) }),
    ci: true,
    comments: true,
    reviews: true,
    state: true,
    labels: true,
    reviewers: true,
    // GitHub opens a review thread only on a diff line, which the board does not offer.
    reviewThreads: Object.freeze({ start: false, reply: true, resolve: true }),
    uploads: false,
    stacks: true,
    changeRequestPatch: true,
    liveSummaries: true,
    referencePicker: true,
    multipleAccounts: true,
    // A repository's discussions: listed, previewed, attached and answered beside issues.
    discussions: true,
  }),
  authMethods: Object.freeze({ device: true, pat: true, cli: Object.freeze({ tool: 'gh' }) }),
  transport: Object.freeze({
    httpsUsername: Object.freeze({ kind: 'fixed', value: 'x-access-token' }),
    // Managed Git transport reaches github.com only; an enterprise host's
    // tokens serve API reads and writes but never a clone or push.
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
    // GitHub names a reviewer by login; the routes bound only its length.
    reviewerId: /^[^\0\r\n]{1,256}$/,
    labelsMax: 100,
    reviewersMax: 50,
  }),
  identity: Object.freeze({
    // GitHub attributes commits to this address without exposing the real one.
    noReplyEmail: (user) => (user?.login && Number.isInteger(user?.id)
      ? `${user.id}+${user.login}@users.noreply.github.com`
      : null),
  }),
  settings: Object.freeze([
    Object.freeze({ key: 'instance', type: 'instance-url', secret: false, scope: 'instance' }),
    Object.freeze({ key: 'token', type: 'personal-access-token', secret: true, scope: 'instance' }),
  ]),
  instances: Object.freeze({
    // github.com signs in through OpenChamber's own device flow and keeps
    // its accounts in github-auth.json; enterprise hosts use the shared store.
    legacyFlow: Object.freeze({ instance: 'github.com', kind: 'github-com-device' }),
  }),
  // What only the client draws: literal words, icon, URL shapes, settings
  // hints and the board features it offers. Published by
  // `GET /api/source-control/providers`; the web adapter's fallback for an
  // older server mirrors it.
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
      startThread: false, authorCanReview: false, projectUploads: false, issueCloseReason: true,
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
