import { isSourceControlString as isString } from './input-guards.js';
import { normalizeOriginInstance } from './origin-instance.js';
import { builtInDefaultHosts } from './provider-descriptors.js';
import { extensionProviderId } from './provider-id.js';
import type { SourceControlContribution } from '@openchamber/sdk';
import type { ProviderCapabilities, ProviderDescriptor } from './provider-contract.js';

const SEGMENT = '[^/]{1,256}';
const TOKEN_SOURCE = new Map([
  ['{owner}', SEGMENT],
  ['{namespace+}', `${SEGMENT}(?:/${SEGMENT}){0,19}`],
  ['{repo}', SEGMENT],
  ['{number}', '\\d{1,16}'],
]);
const TEMPLATES_MAX = 8;
const TEMPLATE_MAX = 256;

const invalidContribution = (guestId: string, reason: string) => new Error(`Source control contribution of ${String(guestId)} is invalid: ${reason}`);

const escapeLiteral = (segment: string) => segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const templateSource = (template: string, fail: (reason: string) => never) => {
  if (!isString(template) || !template.startsWith('/') || template.length > TEMPLATE_MAX) fail('URL template must be a path');
  const seen: string[] = [];
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

const threadPattern = ({ changeRequest, issue }: SourceControlContribution['presentation']['urls'], fail: (reason: string) => never) => {
  const templates = [changeRequest, issue];
  if (!templates.every((list) => Array.isArray(list) && list.length <= TEMPLATES_MAX)) fail('URL templates are invalid');
  const sources = templates.flat().map((template) => templateSource(template, fail));
  if (!sources.length) return /(?!)/;
  return new RegExp(`^(${sources.map((source) => `(?:${source})`).join('|')})(?:/|$)`);
};

const freezeList = <T>(list: Iterable<T>) => Object.freeze([...list]);

const hasMessage = (value: unknown): value is { message?: unknown } => value !== null && value !== undefined;

export function buildExtensionDescriptor({ guestId, contribution, guest }: {
  guestId: string;
  contribution: SourceControlContribution;
  guest: { name: string; version: string };
}): Readonly<ProviderDescriptor & { extension: NonNullable<ProviderDescriptor['extension']> }> {
  const fail: (reason: string) => never = (reason) => { throw invalidContribution(guestId, reason); };
  const id = extensionProviderId(guestId);
  if (!id) fail('the guest id cannot name a provider');
  if (contribution?.wire !== 1) fail('unsupported wire version');

  const { label, instances: declared, capabilities, presentation, limits } = contribution;
  const normalizeOrigin = (raw: string) => {
    const origin = normalizeOriginInstance(raw, { label });
    const url = new URL(origin);
    if (url.protocol === 'http:' && !declared.allowLoopbackHttp) throw new Error(`${label} instances must use HTTPS`);
    if (url.port && !declared.allowPort) throw new Error(`${label} instance must not name a port`);
    if (builtInDefaultHosts.has(url.hostname)) throw new Error(`${label} cannot serve ${url.hostname}, which a built-in provider serves`);
    return origin;
  };
  let defaultInstances: string[];
  try {
    defaultInstances = declared.defaultInstances.map(normalizeOrigin);
  } catch (error) {
    if (!hasMessage(error)) throw new TypeError(`Cannot read properties of ${error} (reading 'message')`);
    fail(`default instance: ${error.message}`);
  }
  if (!declared.custom && !defaultInstances.length) fail('an extension without custom instances must name a default one');
  const normalize = (raw: string) => {
    const origin = normalizeOrigin(raw);
    if (!declared.custom && !defaultInstances.includes(origin)) throw new Error(`${label} does not serve the instance ${origin}`);
    return origin;
  };
  const pattern = threadPattern(presentation.urls, fail);

  const token: { scopes: readonly string[]; createPath?: string } | null = contribution.token ? { scopes: freezeList(contribution.token.scopes) } : null;
  if (token && contribution.token?.createPath) token.createPath = contribution.token.createPath;
  const tokenPresentation: Pick<ProviderDescriptor['presentation'], 'token'> = {};
  if (token) tokenPresentation.token = Object.freeze(token);
  const extension: NonNullable<ProviderDescriptor['extension']> = { guestId, name: guest.name, version: guest.version };
  if (contribution.token) extension.token = Object.freeze({ header: contribution.token.header, scheme: contribution.token.scheme });
  const login = contribution.login ? Object.freeze({ ...contribution.login }) : null;

  const settings: ProviderDescriptor['settings'][number][] = [Object.freeze({ key: 'instance', type: 'instance-url', secret: false, scope: 'instance' })];
  if (contribution.token?.scheme === 'basic') {
    settings.push(Object.freeze({ key: 'username', type: 'username', secret: false, scope: 'instance' }));
  }
  if (token) settings.push(Object.freeze({ key: 'token', type: 'personal-access-token', secret: true, scope: 'instance' }));

  const changeBased: Pick<ProviderCapabilities, 'reviewModel' | 'revisions' | 'draftConversion'> = {};
  if (capabilities.reviewModel) changeBased.reviewModel = capabilities.reviewModel;
  if (capabilities.revisions) changeBased.revisions = true;
  if (capabilities.draftConversion) changeBased.draftConversion = true;
  const submitRequirements = presentation.features.submitRequirements ? { submitRequirements: true } : {};

  return Object.freeze({
    id,
    label,
    terminology: Object.freeze({ changeRequest: contribution.terminology.changeRequest, ci: contribution.terminology.ci }),
    referencePrefix: Object.freeze({ changeRequest: contribution.referencePrefix.changeRequest, issue: contribution.referencePrefix.issue }),
    iconId: 'branch',
    instance: Object.freeze({
      form: 'origin',
      defaultInstances: freezeList(defaultInstances),
      normalize,
      origin: (instance: string) => new URL(instance),
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
      commentEdit: capabilities.commentEdit === true,
      reviews: capabilities.reviews,
      state: capabilities.state,
      labels: capabilities.labels,
      reviewers: capabilities.reviewers,
      reviewThreads: Object.freeze({ start: false, reply: false, resolve: false }),
      uploads: false,
      stacks: false,
      changeRequestPatch: capabilities.changeRequestPatch,
      liveSummaries: capabilities.liveSummaries,
      referencePicker: false,
      multipleAccounts: true,
      ...changeBased,
    }),
    authMethods: Object.freeze({ device: false, pat: Boolean(token), cli: login ?? false }),
    transport: Object.freeze({
      httpsUsername: contribution.transport.httpsUsername.kind === 'fixed'
        ? Object.freeze({ kind: 'fixed', value: contribution.transport.httpsUsername.value })
        : Object.freeze({ kind: 'login' }),
      managedHttpsInstances: 'any',
      appendDotGitToHttpsClone: contribution.transport.appendDotGitToHttpsClone,
    }),
    urls: Object.freeze({
      thread: Object.freeze({
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
    settings: Object.freeze(settings),
    instances: Object.freeze({ legacyFlow: null }),
    presentation: Object.freeze({
      sharedNumberSpace: presentation.sharedNumberSpace,
      abbreviation: presentation.abbreviation,
      promptNoun: presentation.promptNoun,
      icon: Object.freeze(presentation.iconPath ? { path: presentation.iconPath } : { sprite: 'git-branch' }),
      instances: Object.freeze({
        multiple: declared.custom || defaultInstances.length > 1,
        allowLoopbackHttp: declared.allowLoopbackHttp,
        allowPort: declared.allowPort,
        reserved: Object.freeze([]),
        placeholder: declared.placeholder,
      }),
      cliTransport: false,
      ...tokenPresentation,
      urls: Object.freeze({
        changeRequest: freezeList(presentation.urls.changeRequest),
        issue: freezeList(presentation.urls.issue),
      }),
      features: Object.freeze({
        referenceSearch: false, referenceDetail: false, listStatuses: false, referencesAcross: false,
        startThread: false,
        authorCanReview: presentation.features.authorCanReview,
        projectUploads: false,
        issueCloseReason: presentation.features.issueCloseReason,
        issueEdit: presentation.features.issueEdit === true,
        changeRequestEdit: presentation.features.changeRequestEdit === true,
        advancedSearch: false,
        commentEdit: capabilities.commentEdit === true,
        ...submitRequirements,
        changeRequestTemplates: freezeList(presentation.changeRequestTemplates),
      }),
    }),
    extension: Object.freeze(extension),
  });
}
