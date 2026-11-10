import { isString } from '../shared/guards.js';
import { extensionProviderId } from '../source-control/provider-id.js';

/**
 * `contributes.tracker` as the SDK parsed it at install (`TrackerContribution`
 * in `packages/sdk/src/manifest.ts`; mirrored here so this module stays
 * SDK-free like every descriptor):
 *
 * @typedef {{
 *   wire: 1,
 *   label: string,
 *   instances: { kind: 'fixed', origin: string } | { kind: 'user', label: string, placeholder?: string },
 *   auth: {
 *     token?: { header: 'authorization' | 'private-token', scheme: 'bearer' | 'token' | 'basic' | 'none', username?: boolean, scopes?: string[], createPath?: string },
 *     oauth?: { authorizeUrl: string, tokenUrl: string, scopes?: string[] },
 *   },
 *   capabilities: {
 *     multipleAccounts: boolean, stateUpdate: boolean, children: boolean, labels: boolean, priority: boolean,
 *     filters: { people: boolean, priority: boolean }, projectMapping: boolean, sessionComments: boolean,
 *   },
 *   stateFilters: string[],
 *   identifier: 'key-number' | 'number' | 'short-code',
 *   urls: { item: string[] },
 * }} TrackerContribution
 */

/** @typedef {import('./tracker-contract').TrackerDescriptor} TrackerDescriptor */

/**
 * The identifier shapes an extension may declare, as the bounded group a link
 * pattern captures. Every repetition is bounded, so no pasted link can make
 * the compiled pattern backtrack without limit, whatever the templates.
 */
const IDENTIFIER_GROUPS = Object.freeze({
  'key-number': '[A-Za-z][A-Za-z0-9_]{0,31}-\\d{1,16}',
  number: '\\d{1,16}',
  'short-code': '[A-Za-z0-9][A-Za-z0-9_-]{0,63}',
});

const SEGMENT = '[^/]{1,256}';
const TEMPLATES_MAX = 8;
const TEMPLATE_MAX = 256;
// A literal template segment: no placeholder braces, no regex syntax.
const LITERAL = /^[A-Za-z0-9._~-]+$/;
// `?name={id}`: the query parameter that carries the identifier.
const QUERY_TEMPLATE = /^([A-Za-z0-9_.-]{1,64})=\{id\}$/;

const invalidContribution = (guestId, reason) => new Error(`Tracker contribution of ${String(guestId)} is invalid: ${reason}`);

const escapeLiteral = (segment) => segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The identifier pattern of a shape, anchored; what the descriptor publishes and the query form matches against. */
export const identifierPatternOf = (kind) => `^${IDENTIFIER_GROUPS[kind]}$`;

/**
 * One link template (`/browse/{id}`, `/{segments+}?selectedIssue={id}`) as a
 * `urlPatterns` entry: `path` is a regex source over the pathname (group one is
 * the identifier when the template carries `{id}` in the path), `query` names
 * the parameter that carries it otherwise. Literal segments are escaped and
 * every placeholder bounded. Never a regular expression the extension wrote.
 */
export const compileTrackerUrlTemplate = (template, kind, fail = (reason) => { throw new Error(reason); }) => {
  if (!isString(template) || !template.startsWith('/') || template.length > TEMPLATE_MAX) fail('link template must be a path');
  const group = IDENTIFIER_GROUPS[kind];
  if (!group) fail(`unknown identifier shape: ${String(kind)}`);
  const queryAt = template.indexOf('?');
  const pathPart = queryAt === -1 ? template : template.slice(0, queryAt);
  const queryPart = queryAt === -1 ? null : template.slice(queryAt + 1);
  const segments = pathPart === '/' ? [] : pathPart.slice(1).split('/');
  let ids = 0;
  let multi = 0;
  let source = '';
  for (const segment of segments) {
    if (segment === '{id}') {
      ids += 1;
      source += `/(${group})`;
    } else if (segment === '{segment}') {
      source += `/${SEGMENT}`;
    } else if (segment === '{segments+}') {
      multi += 1;
      source += `/${SEGMENT}(?:/${SEGMENT}){0,19}`;
    } else if (segment === '' || segment === '.' || segment === '..' || /[{}]/.test(segment) || !LITERAL.test(segment)) {
      fail(`link template has an invalid segment: ${segment}`);
    } else {
      source += `/${escapeLiteral(segment)}`;
    }
  }
  if (multi > 1) fail('link template uses {segments+} more than once');
  if (queryPart === null) {
    if (ids !== 1) fail('link template names {id} once');
    return { path: `^${source}(?:/|$)` };
  }
  const query = QUERY_TEMPLATE.exec(queryPart);
  if (!query || ids !== 0) fail('a query template is "?name={id}" with no {id} in the path');
  return { path: segments.length === 0 ? '^/$' : `^${source}(?:/|$)`, query: { name: query[1] } };
};

/** The host a pattern applies to: the instance's hostname without `www.`, as `matchUrl` compares it. */
const hostOf = (instance) => new URL(instance).hostname.replace(/^www\./, '').toLowerCase();

const freezeList = (list) => Object.freeze([...list]);

/**
 * The plain-JSON `TrackerDescriptor` of an extension's tracker. The host fixes
 * everything the extension must not choose: the id (`ext-<guestId>`), host
 * access off (the service never sees a token, so no panel may borrow one),
 * and the link patterns compiled from templates against the one instance the
 * accounts live on. A `user` instance is known only once an account is
 * connected: until then the descriptor carries no link patterns, and the
 * extension layer builds it again when the instance is set or cleared.
 *
 * @param {{ guestId: string, contribution: TrackerContribution, instance: string | null }} input
 * @returns {Readonly<TrackerDescriptor>}
 */
export function buildExtensionTrackerDescriptor({ guestId, contribution, instance }) {
  const fail = (reason) => { throw invalidContribution(guestId, reason); };
  const id = extensionProviderId(guestId);
  if (!id) fail('the guest id cannot name a provider');
  if (contribution?.wire !== 1) fail('unsupported wire version');
  const { label, capabilities, stateFilters, identifier, urls, auth } = contribution;
  if (!IDENTIFIER_GROUPS[identifier]) fail(`unknown identifier shape: ${String(identifier)}`);
  if (!auth?.token && !auth?.oauth) fail('the tracker declares no way to sign in');
  const templates = urls?.item;
  if (!Array.isArray(templates) || templates.length === 0 || templates.length > TEMPLATES_MAX) fail('link templates are invalid');

  const origin = contribution.instances.kind === 'fixed' ? contribution.instances.origin : instance;
  const host = origin ? hostOf(origin) : null;
  const compiled = templates.map((template) => compileTrackerUrlTemplate(template, identifier, fail));
  const urlPatterns = host
    ? compiled.map((pattern) => Object.freeze(pattern.query ? { host, path: pattern.path, query: Object.freeze({ ...pattern.query }) } : { host, path: pattern.path }))
    : [];

  return Object.freeze({
    id,
    name: label,
    // Browser sign-in first where both exist: it needs no token to be made by hand.
    authMethods: freezeList([...(auth.oauth ? ['oauth'] : []), ...(auth.token ? ['token'] : [])]),
    capabilities: Object.freeze({
      multipleAccounts: capabilities.multipleAccounts === true,
      stateUpdate: capabilities.stateUpdate === true,
      children: capabilities.children === true,
      labels: capabilities.labels === true,
      priority: capabilities.priority === true,
      filters: Object.freeze({ people: capabilities.filters?.people === true, priority: capabilities.filters?.priority === true }),
      projectMapping: capabilities.projectMapping === true,
      sessionComments: capabilities.sessionComments === true,
      // The service never holds a token; nothing may borrow one through it.
      hostAccess: false,
    }),
    stateFilters: freezeList(stateFilters),
    urlPatterns: freezeList(urlPatterns),
    identifierPattern: identifierPatternOf(identifier),
  });
}

/**
 * A descriptor's link matcher: the identifier an item link names, upper-cased,
 * or null. An http(s) URL whose host (without `www.`) is a pattern's host and
 * whose path matches; the identifier is the path's first group, or the named
 * query parameter when the pattern reads one, checked against the descriptor's
 * identifier pattern. The UI applies the same rule (`lib/trackers/matchTrackerUrl.ts`).
 *
 * @param {TrackerDescriptor} descriptor
 * @returns {(url: string) => string | null}
 */
export const createDescriptorUrlMatcher = (descriptor) => {
  const identifier = new RegExp(descriptor.identifierPattern);
  const patterns = descriptor.urlPatterns.map((pattern) => ({
    host: pattern.host.toLowerCase(),
    path: new RegExp(pattern.path),
    query: pattern.query?.name ?? null,
  }));
  return (value) => {
    const raw = isString(value) ? value.trim() : '';
    if (!raw || !URL.canParse(raw)) return null;
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    const host = url.hostname.replace(/^www\./, '').toLowerCase();
    for (const pattern of patterns) {
      if (pattern.host !== host) continue;
      const match = pattern.path.exec(url.pathname);
      if (!match) continue;
      if (pattern.query === null) {
        if (match[1]) return match[1].toUpperCase();
        continue;
      }
      const candidate = url.searchParams.get(pattern.query);
      if (candidate && identifier.test(candidate)) return candidate.toUpperCase();
    }
    return null;
  };
};
