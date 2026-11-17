import { normalizeGerritInstance } from './instance.js';

const CHANGE_PATH = 'M5 2H13A3 3 0 0 1 16 5V6.5H14V5A1 1 0 0 0 13 4H5A1 1 0 0 0 4 5V13A1 1 0 0 0 5 14H6.5V16H5A3 3 0 0 1 2 13V5A3 3 0 0 1 5 2Z'
  + 'M11 8H19A3 3 0 0 1 22 11V19A3 3 0 0 1 19 22H11A3 3 0 0 1 8 19V11A3 3 0 0 1 11 8Z'
  + 'M11 10A1 1 0 0 0 10 11V19A1 1 0 0 0 11 20H19A1 1 0 0 0 20 19V11A1 1 0 0 0 19 10Z'
  + 'M12 12.25H18V13.75H12Z'
  + 'M14.25 15H15.75V16.25H17V17.75H15.75V19H14.25V17.75H13V16.25H14.25Z';

export const gerritDescriptor = Object.freeze({
  id: 'gerrit',
  label: 'Gerrit',
  terminology: Object.freeze({ changeRequest: 'change', ci: 'checks' }),
  referencePrefix: Object.freeze({ changeRequest: '#', issue: '#' }),
  iconId: 'gerrit',
  instance: Object.freeze({
    form: 'origin',
    defaultInstances: Object.freeze([]),
    normalize: normalizeGerritInstance,
    origin: (instance) => new URL(instance),
  }),
  repositoryPath: 'path',
  projectPathOfRemote: ({ protocol, path }) => {
    const trimmed = path.replace(/^\/+/, '').replace(/\.git$/i, '');
    return protocol === 'https' || protocol === 'http' ? trimmed.replace(/^a\//, '') : trimmed;
  },
  capabilities: Object.freeze({
    projects: true,
    issues: false,
    changeRequests: true,
    draftChangeRequests: true,
    draftConversion: true,
    merge: Object.freeze({ methods: Object.freeze(['submit']) }),
    ci: false,
    comments: true,
    commentEdit: false,
    reviews: true,
    reviewModel: 'votes',
    revisions: true,
    createVia: 'push',
    state: true,
    labels: false,
    reviewers: true,
    reviewThreads: Object.freeze({ start: false, reply: false, resolve: false }),
    reviewDrafts: Object.freeze({ fileComments: true }),
    uploads: false,
    stacks: true,
    changeRequestPatch: true,
    liveSummaries: true,
    referencePicker: false,
    multipleAccounts: true,
  }),
  authMethods: Object.freeze({ device: false, pat: true, cli: false }),
  transport: Object.freeze({
    httpsUsername: Object.freeze({ kind: 'login' }),
    managedHttpsInstances: 'any',
    appendDotGitToHttpsClone: false,
  }),
  urls: Object.freeze({
    thread: Object.freeze({
      hosts: 'any',
      pattern: /^(\/c\/[^+]+\/\+\/\d+)(?:\/|$)/,
    }),
  }),
  trackedItems: Object.freeze({ nestedOwners: true, defaultInstance: null, batchLimit: 50 }),
  limits: Object.freeze({
    // external: https://gerrit-review.googlesource.com/Documentation/config-gerrit.html#change.commentSizeLimit The default comment size limit is 16 KiB.
    commentMaxLength: 16_384,
    reviewerId: /^\d+$/,
    labelsMax: 0,
    reviewersMax: 50,
  }),
  identity: Object.freeze({ noReplyEmail: null }),
  settings: Object.freeze([
    Object.freeze({ key: 'instance', type: 'instance-url', secret: false, scope: 'instance' }),
    Object.freeze({ key: 'username', type: 'username', secret: false, scope: 'instance' }),
    Object.freeze({ key: 'token', type: 'http-password', secret: true, scope: 'instance' }),
  ]),
  instances: Object.freeze({ legacyFlow: null }),
  presentation: Object.freeze({
    sharedNumberSpace: true,
    abbreviation: 'CL',
    promptNoun: 'change',
    icon: Object.freeze({ path: CHANGE_PATH }),
    instances: Object.freeze({
      multiple: true, allowLoopbackHttp: true, allowPort: true,
      reserved: Object.freeze([]), placeholder: 'https://gerrit.example.com',
    }),
    cliTransport: false,
    token: Object.freeze({ scopes: Object.freeze([]), createPath: '/settings/#HTTPCredentials' }),
    urls: Object.freeze({
      changeRequest: Object.freeze(['/c/{project+}/+/{number}']),
      issue: Object.freeze([]),
    }),
    features: Object.freeze({
      referenceSearch: false, referenceDetail: false, listStatuses: false, referencesAcross: false,
      startThread: false, reviewDrafts: true, reviewDraftFileComments: true, authorCanReview: true, projectUploads: false, issueCloseReason: false,
      commentEdit: false,
      changeRequestTemplates: Object.freeze([]),
      branchHeads: false,
      submitRequirements: true,
    }),
  }),
});
