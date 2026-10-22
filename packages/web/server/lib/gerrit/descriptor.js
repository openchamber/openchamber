import { normalizeGerritInstance } from './instance.js';

// Three commits on a line with a review mark, drawn for a 24x24 box
// (OpenChamber's own mark, not Gerrit's logo artwork).
const CHANGE_PATH = 'M7 2a3 3 0 1 1 0 6a3 3 0 1 1 0-6z'
  + 'M7 16a3 3 0 1 1 0 6a3 3 0 1 1 0-6z'
  + 'M6 8h2v8H6z'
  + 'M13 10.5l1.5-1.5 2 2 4-4 1.5 1.5-5.5 5.5z';

/**
 * Gerrit's static description: synchronous and dependency-free. Gerrit is
 * always self-hosted here, so there is no default instance; every instance
 * comes from an account the user connected with a username and HTTP
 * password. A Gerrit change is one commit reviewed by label votes across
 * patchsets, created by pushing to `refs/for/<branch>`, and landed by submit.
 */
export const gerritDescriptor = Object.freeze({
  id: 'gerrit',
  label: 'Gerrit',
  terminology: Object.freeze({ changeRequest: 'change', ci: 'checks' }),
  // Gerrit addresses a change by its bare number, and has no issues.
  referencePrefix: Object.freeze({ changeRequest: '#', issue: '#' }),
  iconId: 'gerrit',
  instance: Object.freeze({
    form: 'origin',
    defaultInstances: Object.freeze([]),
    normalize: normalizeGerritInstance,
    origin: (instance) => new URL(instance),
  }),
  // Nested (`platform/build/soong`) or top-level (`demo`, owner '').
  repositoryPath: 'path',
  /**
   * The project a remote names: an HTTP(S) path may carry Gerrit's `a/`
   * authentication prefix, which is not part of the name; over SSH `a/` is a
   * real segment. A trailing `.git` is dropped either way.
   */
  projectPathOfRemote: ({ protocol, path }) => {
    const trimmed = path.replace(/^\/+/, '').replace(/\.git$/i, '');
    return protocol === 'https' || protocol === 'http' ? trimmed.replace(/^a\//, '') : trimmed;
  },
  capabilities: Object.freeze({
    projects: true,
    issues: false,
    changeRequests: true,
    // Work in progress; ready is `POST /changes/{id}/ready`.
    draftChangeRequests: true,
    merge: Object.freeze({ methods: Object.freeze(['submit']) }),
    // A Verified label is a vote, not a CI run.
    ci: false,
    comments: true,
    reviews: true,
    reviewModel: 'votes',
    revisions: true,
    createVia: 'push',
    // Abandon and restore.
    state: true,
    // Hashtags are shown read-only.
    labels: false,
    reviewers: true,
    reviewThreads: Object.freeze({ start: false, reply: false, resolve: false }),
    uploads: false,
    // Relation chains from `/related`.
    stacks: true,
    changeRequestPatch: true,
    liveSummaries: true,
    referencePicker: false,
    multipleAccounts: true,
  }),
  authMethods: Object.freeze({ device: false, pat: true, cli: false }),
  transport: Object.freeze({
    // The HTTP password goes with the account's Gerrit username.
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
    // `change.commentSizeLimit` defaults to 16 KiB.
    commentMaxLength: 16_384,
    // Reviewers are named by numeric account id.
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
      startThread: false, authorCanReview: true, projectUploads: false, issueCloseReason: false,
      // The commit message is the description; there is no template.
      changeRequestTemplates: Object.freeze([]),
      // A change's head is a patchset ref, not a branch to stack on.
      branchHeads: false,
      submitRequirements: true,
    }),
  }),
});
