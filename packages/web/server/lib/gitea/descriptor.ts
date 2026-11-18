import { normalizeGiteaInstance } from './instance.js';

const TEACUP_PATH = 'M2 6h15v5.5a6.5 6.5 0 0 1-6.5 6.5h-2A6.5 6.5 0 0 1 2 11.5z'
  + 'M17 7h2.5a3.5 3.5 0 0 1 0 7H17v-2h2.5a1.5 1.5 0 0 0 0-3H17z'
  + 'M3 20h13v1.5H3z';

export const giteaDescriptor = Object.freeze({
  id: 'gitea',
  label: 'Gitea',
  terminology: Object.freeze({ changeRequest: 'pullRequest', ci: 'checks' }),
  referencePrefix: Object.freeze({ changeRequest: '#', issue: '#' }),
  iconId: 'gitea',
  instance: Object.freeze({
    form: 'origin',
    defaultInstances: Object.freeze([]),
    normalize: normalizeGiteaInstance,
    origin: (instance: string) => new URL(instance),
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
    reviewThreads: Object.freeze({ start: false, reply: false, resolve: false }),
    reviewDrafts: Object.freeze({ fileComments: false }),
    uploads: false,
    stacks: false,
    changeRequestPatch: true,
    liveSummaries: true,
    referencePicker: false,
    multipleAccounts: true,
  }),
  authMethods: Object.freeze({ device: false, pat: true, cli: Object.freeze({ tool: 'gt' }) }),
  transport: Object.freeze({
    httpsUsername: Object.freeze({ kind: 'login' }),
    managedHttpsInstances: 'any',
    appendDotGitToHttpsClone: false,
  }),
  urls: Object.freeze({
    thread: Object.freeze({
      hosts: 'any',
      pattern: /^(\/[^/]+\/[^/]+\/(?:pulls|issues)\/\d+)(?:\/|$)/,
    }),
  }),
  trackedItems: Object.freeze({ nestedOwners: false, defaultInstance: null, batchLimit: 50 }),
  limits: Object.freeze({
    commentMaxLength: 65_536,
    reviewerId: /^\d+$/,
    labelsMax: 100,
    reviewersMax: 50,
  }),
  identity: Object.freeze({ noReplyEmail: null }),
  settings: Object.freeze([
    Object.freeze({ key: 'instance', type: 'instance-url', secret: false, scope: 'instance' }),
    Object.freeze({ key: 'sshUrl', type: 'instance-url', secret: false, scope: 'instance' }),
    Object.freeze({ key: 'token', type: 'personal-access-token', secret: true, scope: 'instance' }),
  ]),
  instances: Object.freeze({ legacyFlow: null }),
  presentation: Object.freeze({
    sharedNumberSpace: true,
    abbreviation: 'PR',
    promptNoun: 'pull request',
    icon: Object.freeze({ path: TEACUP_PATH }),
    instances: Object.freeze({
      multiple: true, allowLoopbackHttp: true, allowPort: true,
      reserved: Object.freeze([]), placeholder: 'https://gitea.example.com',
    }),
    cliTransport: false,
    token: Object.freeze({
      scopes: Object.freeze(['write:repository', 'write:issue', 'read:user']),
      createPath: '/user/settings/applications',
    }),
    urls: Object.freeze({
      changeRequest: Object.freeze(['/{owner}/{repo}/pulls/{number}']),
      issue: Object.freeze(['/{owner}/{repo}/issues/{number}']),
      commit: Object.freeze(['/{owner}/{repo}/commit/{sha}']),
      user: Object.freeze(['/{user}']),
    }),
    features: Object.freeze({
      referenceSearch: false, referenceDetail: false, listStatuses: false, referencesAcross: false,
      startThread: false, reviewDrafts: true, reviewDraftFileComments: false, authorCanReview: false, projectUploads: false, issueCloseReason: false,
      issueEdit: true, changeRequestEdit: true, commentEdit: true,
      changeRequestTemplates: Object.freeze([
        '.gitea/pull_request_template.md',
        '.gitea/PULL_REQUEST_TEMPLATE.md',
        '.github/pull_request_template.md',
      ]),
    }),
  }),
});
