import { normalizeOriginInstance } from '../source-control/origin-instance.js';

/**
 * GitLab's static description: synchronous and SDK-free, so the Git layer,
 * bindings and the client can read it without loading GitBeaker.
 */
export const gitlabDescriptor = Object.freeze({
  id: 'gitlab',
  label: 'GitLab',
  terminology: Object.freeze({ changeRequest: 'mergeRequest', ci: 'pipeline' }),
  referencePrefix: Object.freeze({ changeRequest: '!', issue: '#' }),
  iconId: 'gitlab',
  instance: Object.freeze({
    form: 'origin',
    defaultInstances: Object.freeze(['https://gitlab.com']),
    normalize: (raw) => normalizeOriginInstance(raw, { label: 'GitLab' }),
    origin: (instance) => new URL(instance),
  }),
  repositoryPath: 'namespace/name',
  capabilities: Object.freeze({
    projects: true,
    issues: true,
    changeRequests: true,
    draftChangeRequests: true,
    // Rebase is not one atomic merge on GitLab, so it is never offered.
    merge: Object.freeze({ methods: Object.freeze(['merge', 'squash']) }),
    ci: true,
    comments: true,
    reviews: true,
    state: true,
    labels: true,
    reviewers: true,
    reviewThreads: Object.freeze({ start: true, reply: true, resolve: true }),
    uploads: true,
    stacks: true,
    changeRequestPatch: true,
    liveSummaries: true,
    referencePicker: false,
    multipleAccounts: true,
  }),
  authMethods: Object.freeze({ device: true, pat: true, cli: Object.freeze({ tool: 'glab' }) }),
  transport: Object.freeze({
    httpsUsername: Object.freeze({ kind: 'fixed', value: 'oauth2' }),
    managedHttpsInstances: 'any',
    appendDotGitToHttpsClone: true,
  }),
  urls: Object.freeze({
    thread: Object.freeze({
      hosts: 'any',
      pattern: /^(\/.+\/-\/(?:merge_requests|issues|work_items)\/\d+)(?:\/|$)/,
    }),
  }),
  trackedItems: Object.freeze({ nestedOwners: true, defaultInstance: null, batchLimit: 50 }),
  limits: Object.freeze({
    commentMaxLength: 1_000_000,
    // GitLab names a reviewer by numeric user id.
    reviewerId: /^\d+$/,
    labelsMax: 100,
    reviewersMax: 50,
  }),
  identity: Object.freeze({ noReplyEmail: null }),
  settings: Object.freeze([
    Object.freeze({ key: 'instance', type: 'instance-url', secret: false, scope: 'instance' }),
    Object.freeze({ key: 'token', type: 'personal-access-token', secret: true, scope: 'instance' }),
  ]),
  instances: Object.freeze({ legacyFlow: null }),
  // What only the client draws; see the GitHub descriptor.
  presentation: Object.freeze({
    sharedNumberSpace: false,
    abbreviation: 'MR',
    promptNoun: 'merge request',
    icon: Object.freeze({ sprite: 'gitlab' }),
    instances: Object.freeze({
      multiple: true, allowLoopbackHttp: true, allowPort: true,
      reserved: Object.freeze([]), placeholder: 'https://gitlab.example.com',
    }),
    // A glab login serves API reads only; Git transport needs a stored account.
    cliTransport: false,
    token: Object.freeze({ scopes: Object.freeze(['api']), createPath: '/-/user_settings/personal_access_tokens' }),
    urls: Object.freeze({
      changeRequest: Object.freeze(['/{namespace+}/{repo}/-/merge_requests/{number}']),
      issue: Object.freeze(['/{namespace+}/{repo}/-/issues/{number}', '/{namespace+}/{repo}/-/work_items/{number}']),
      commit: Object.freeze(['/{namespace+}/{repo}/-/commit/{sha}']),
      user: Object.freeze(['/{user}']),
    }),
    features: Object.freeze({
      referenceSearch: false, referenceDetail: false, listStatuses: false, referencesAcross: false,
      startThread: true, authorCanReview: true, projectUploads: true, issueCloseReason: false,
      changeRequestTemplates: Object.freeze(['.gitlab/merge_request_templates/Default.md']),
    }),
  }),
});
