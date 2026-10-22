import { isString } from '../shared/guards.js';
import { normalizeOriginInstance } from './origin-instance.js';
import { builtInDefaultHosts } from './provider-descriptors.js';
import { extensionProviderId } from './provider-id.js';

/**
 * `contributes.sourceControl` as the SDK parsed it at install
 * (`SourceControlContribution` in `packages/sdk/src/manifest.ts`; mirrored
 * here so this module stays SDK-free like every descriptor):
 *
 * @typedef {{
 *   wire: 1,
 *   label: string,
 *   terminology: { changeRequest: 'pullRequest' | 'mergeRequest', ci: 'checks' | 'pipeline' },
 *   referencePrefix: { changeRequest: string, issue: string },
 *   repositoryPath: 'owner/name' | 'namespace/name',
 *   instances: { defaultInstances: string[], custom: boolean, allowLoopbackHttp: boolean, allowPort: boolean, placeholder: string },
 *   capabilities: {
 *     projects: boolean, issues: boolean, changeRequests: boolean, draftChangeRequests: boolean,
 *     merge: false | { methods: Array<'merge' | 'squash' | 'rebase'> }, ci: boolean, comments: boolean, reviews: boolean,
 *     state: boolean, labels: boolean, reviewers: boolean, changeRequestPatch: boolean, liveSummaries: boolean,
 *   },
 *   token: { header: 'authorization' | 'private-token', scheme: 'bearer' | 'token' | 'none', scopes: string[], createPath?: string },
 *   transport: { httpsUsername: { kind: 'login' } | { kind: 'fixed', value: string }, appendDotGitToHttpsClone: boolean },
 *   limits: { commentMaxLength: number, reviewerId: 'numeric' | 'login', labelsMax: number, reviewersMax: number },
 *   trackedItems: { batchLimit: number },
 *   presentation: {
 *     abbreviation: string, promptNoun: string, sharedNumberSpace: boolean, iconPath?: string,
 *     urls: { changeRequest: string[], issue: string[] },
 *     features: { authorCanReview: boolean, issueCloseReason: boolean },
 *     changeRequestTemplates: string[],
 *   },
 * }} SourceControlContribution
 */

/** @typedef {import('./provider-contract').ProviderDescriptor} ProviderDescriptor */

// Bounded placeholders: no unbounded repetition anywhere, so a path cannot
// make the compiled pattern backtrack without limit, whatever the templates.
const SEGMENT = '[^/]{1,256}';
const TOKEN_SOURCE = new Map([
  ['{owner}', SEGMENT],
  ['{namespace+}', `${SEGMENT}(?:/${SEGMENT}){0,19}`],
  ['{repo}', SEGMENT],
  ['{number}', '\\d{1,16}'],
]);
const TEMPLATES_MAX = 8;
const TEMPLATE_MAX = 256;

const invalidContribution = (guestId, reason) => new Error(`Source control contribution of ${String(guestId)} is invalid: ${reason}`);

const escapeLiteral = (segment) => segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * One URL template (`/{owner}/{repo}/pulls/{number}`) as a regular
 * expression source: literal segments escaped, placeholders bounded. A
 * template must name its owner (or namespace), repo and number once each,
 * the same rule the UI's link matcher applies.
 */
const templateSource = (template, fail) => {
  if (!isString(template) || !template.startsWith('/') || template.length > TEMPLATE_MAX) fail('URL template must be a path');
  const seen = [];
  let source = '';
  for (const segment of template.split('/').slice(1)) {
    if (!segment) fail('URL template has an empty segment');
    const placeholder = TOKEN_SOURCE.get(segment);
    if (placeholder) {
      seen.push(segment === '{namespace+}' ? '{owner}' : segment);
      source += `/${placeholder}`;
    } else if (/[{}]/.test(segment)) {
      fail(`URL template uses an unknown placeholder: ${segment}`);
    } else {
      source += `/${escapeLiteral(segment)}`;
    }
  }
  if (new Set(seen).size !== seen.length || !['{owner}', '{repo}', '{number}'].every((token) => seen.includes(token))) {
    fail('URL template must name the owner, repo and number once each');
  }
  return source;
};

/**
 * `urls.thread.pattern` from the change request and issue templates: group
 * one is the thread's path, and the match ends where the thread does, as the
 * built-ins' hand-written patterns do. Never a regular expression the
 * extension wrote.
 */
const threadPattern = ({ changeRequest, issue }, fail) => {
  const templates = [changeRequest, issue];
  if (!templates.every((list) => Array.isArray(list) && list.length <= TEMPLATES_MAX)) fail('URL templates are invalid');
  const sources = templates.flat().map((template) => templateSource(template, fail));
  // No template: a pattern that never matches.
  if (!sources.length) return /(?!)/;
  return new RegExp(`^(${sources.map((source) => `(?:${source})`).join('|')})(?:/|$)`);
};

const freezeList = (list) => Object.freeze([...list]);

/**
 * The full, frozen `ProviderDescriptor` of an extension's Git host. The host
 * fixes everything the wire cannot carry or the extension must not choose:
 * the id (`ext-<guestId>`), personal access tokens as the only sign-in,
 * origins as instances (only the declared ones unless `custom`, and never a
 * host a built-in serves by default, declared or entered), the thread
 * pattern compiled from templates, and the features PR 2 does not forward
 * (review threads, uploads, stacks, the reference picker) off.
 *
 * `extension` records which guest serves it, and how the outbound proxy
 * sends its token; it never reaches a client except through
 * `publicProviderDescriptor`'s explicit marker.
 *
 * @param {{ guestId: string, contribution: SourceControlContribution, guest: { name: string, version: string } }} input
 * @returns {Readonly<ProviderDescriptor>}
 */
export function buildExtensionDescriptor({ guestId, contribution, guest }) {
  const fail = (reason) => { throw invalidContribution(guestId, reason); };
  const id = extensionProviderId(guestId);
  if (!id) fail('the guest id cannot name a provider');
  if (contribution?.wire !== 1) fail('unsupported wire version');

  const { label, instances: declared, capabilities, presentation, limits } = contribution;
  const normalizeOrigin = (raw) => {
    const origin = normalizeOriginInstance(raw, { label });
    const url = new URL(origin);
    if (url.protocol === 'http:' && !declared.allowLoopbackHttp) throw new Error(`${label} instances must use HTTPS`);
    if (url.port && !declared.allowPort) throw new Error(`${label} instance must not name a port`);
    // A built-in's credential for its own host must never be routed to an extension.
    if (builtInDefaultHosts.has(url.hostname)) throw new Error(`${label} cannot serve ${url.hostname}, which a built-in provider serves`);
    return origin;
  };
  let defaultInstances;
  try {
    defaultInstances = declared.defaultInstances.map(normalizeOrigin);
  } catch (error) {
    fail(`default instance: ${error.message}`);
  }
  if (!declared.custom && !defaultInstances.length) fail('an extension without custom instances must name a default one');
  const normalize = (raw) => {
    const origin = normalizeOrigin(raw);
    if (!declared.custom && !defaultInstances.includes(origin)) throw new Error(`${label} does not serve the instance ${origin}`);
    return origin;
  };
  const pattern = threadPattern(presentation.urls, fail);

  const token = { scopes: freezeList(contribution.token.scopes) };
  if (contribution.token.createPath) token.createPath = contribution.token.createPath;

  return Object.freeze({
    id,
    label,
    terminology: Object.freeze({ changeRequest: contribution.terminology.changeRequest, ci: contribution.terminology.ci }),
    referencePrefix: Object.freeze({ changeRequest: contribution.referencePrefix.changeRequest, issue: contribution.referencePrefix.issue }),
    // The generic identity mark; an extension draws its own only in the UI.
    iconId: 'branch',
    instance: Object.freeze({
      form: 'origin',
      defaultInstances: freezeList(defaultInstances),
      normalize,
      origin: (instance) => new URL(instance),
    }),
    repositoryPath: contribution.repositoryPath,
    capabilities: Object.freeze({
      projects: capabilities.projects,
      issues: capabilities.issues,
      changeRequests: capabilities.changeRequests,
      draftChangeRequests: capabilities.draftChangeRequests,
      merge: capabilities.merge ? Object.freeze({ methods: freezeList(capabilities.merge.methods) }) : false,
      ci: capabilities.ci,
      comments: capabilities.comments,
      reviews: capabilities.reviews,
      state: capabilities.state,
      labels: capabilities.labels,
      reviewers: capabilities.reviewers,
      reviewThreads: Object.freeze({ start: false, reply: false, resolve: false }),
      // Uploads stream a provider Response, which the service wire cannot carry.
      uploads: false,
      stacks: false,
      changeRequestPatch: capabilities.changeRequestPatch,
      liveSummaries: capabilities.liveSummaries,
      referencePicker: false,
      multipleAccounts: true,
    }),
    authMethods: Object.freeze({ device: false, pat: true, cli: false }),
    transport: Object.freeze({
      httpsUsername: contribution.transport.httpsUsername.kind === 'fixed'
        ? Object.freeze({ kind: 'fixed', value: contribution.transport.httpsUsername.value })
        : Object.freeze({ kind: 'login' }),
      managedHttpsInstances: 'any',
      appendDotGitToHttpsClone: contribution.transport.appendDotGitToHttpsClone,
    }),
    urls: Object.freeze({
      thread: Object.freeze({
        // Only the declared hosts when the user cannot add another.
        hosts: declared.custom ? 'any' : freezeList(new Set(defaultInstances.map((origin) => new URL(origin).hostname))),
        pattern,
      }),
    }),
    trackedItems: Object.freeze({
      nestedOwners: contribution.repositoryPath === 'namespace/name',
      defaultInstance: null,
      batchLimit: contribution.trackedItems.batchLimit,
    }),
    limits: Object.freeze({
      commentMaxLength: limits.commentMaxLength,
      reviewerId: limits.reviewerId === 'numeric' ? /^\d{1,20}$/ : /^[^\0\r\n]{1,256}$/,
      labelsMax: limits.labelsMax,
      reviewersMax: limits.reviewersMax,
    }),
    identity: Object.freeze({ noReplyEmail: null }),
    settings: Object.freeze([
      Object.freeze({ key: 'instance', type: 'instance-url', secret: false, scope: 'instance' }),
      Object.freeze({ key: 'token', type: 'personal-access-token', secret: true, scope: 'instance' }),
    ]),
    instances: Object.freeze({ legacyFlow: null }),
    presentation: Object.freeze({
      sharedNumberSpace: presentation.sharedNumberSpace,
      abbreviation: presentation.abbreviation,
      promptNoun: presentation.promptNoun,
      // Without a mark of its own the UI draws the generic branch.
      icon: Object.freeze(presentation.iconPath ? { path: presentation.iconPath } : { sprite: 'git-branch' }),
      instances: Object.freeze({
        multiple: declared.custom || defaultInstances.length > 1,
        allowLoopbackHttp: declared.allowLoopbackHttp,
        allowPort: declared.allowPort,
        reserved: Object.freeze([]),
        placeholder: declared.placeholder,
      }),
      cliTransport: false,
      token: Object.freeze(token),
      urls: Object.freeze({
        changeRequest: freezeList(presentation.urls.changeRequest),
        issue: freezeList(presentation.urls.issue),
      }),
      features: Object.freeze({
        referenceSearch: false, referenceDetail: false, listStatuses: false, referencesAcross: false,
        // Starting a thread needs review threads, which the host keeps off.
        startThread: false,
        authorCanReview: presentation.features.authorCanReview,
        projectUploads: false,
        issueCloseReason: presentation.features.issueCloseReason,
        changeRequestTemplates: freezeList(presentation.changeRequestTemplates),
      }),
    }),
    extension: Object.freeze({
      guestId,
      name: guest.name,
      version: guest.version,
      token: Object.freeze({ header: contribution.token.header, scheme: contribution.token.scheme }),
    }),
  });
}
