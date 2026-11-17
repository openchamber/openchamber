import { isString } from '../shared/guards.js';
import { extensionProviderId } from '../source-control/provider-id.js';

import type { TrackerContribution } from '@openchamber/sdk';
import type { TrackerAuthMethod, TrackerDescriptor } from './tracker-contract.js';
export type { TrackerContribution } from '@openchamber/sdk';

const IDENTIFIER_GROUPS = Object.freeze({
  'key-number': '[A-Za-z][A-Za-z0-9_]{0,31}-\\d{1,16}',
  number: '\\d{1,16}',
  'short-code': '[A-Za-z0-9][A-Za-z0-9_-]{0,63}',
});

const SEGMENT = '[^/]{1,256}';
const TEMPLATES_MAX = 8;
const TEMPLATE_MAX = 256;
const LITERAL = /^[A-Za-z0-9._~-]+$/;
const QUERY_TEMPLATE = /^([A-Za-z0-9_.-]{1,64})=\{id\}$/;

const invalidContribution = (guestId: string, reason: string) => new Error(`Tracker contribution of ${String(guestId)} is invalid: ${reason}`);

const escapeLiteral = (segment: string) => segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const identifierPatternOf = (kind: TrackerContribution['identifier']) => `^${IDENTIFIER_GROUPS[kind]}$`;

export const compileTrackerUrlTemplate = (template: string, kind: TrackerContribution['identifier'], fail: (reason: string) => never = (reason) => { throw new Error(reason); }) => {
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
  if (!query || query[1] === undefined || ids !== 0) return fail('a query template is "?name={id}" with no {id} in the path');
  return { path: segments.length === 0 ? '^/$' : `^${source}(?:/|$)`, query: { name: query[1] } };
};

const hostOf = (instance: string) => new URL(instance).hostname.replace(/^www\./, '').toLowerCase();

const freezeList = <T>(list: readonly T[]) => Object.freeze([...list]);

export function buildExtensionTrackerDescriptor({ guestId, contribution, instance }: { guestId: string; contribution: TrackerContribution; instance: string | null }): Readonly<TrackerDescriptor> {
  const fail: (reason: string) => never = (reason) => { throw invalidContribution(guestId, reason); };
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
  const oauthMethods: TrackerAuthMethod[] = auth.oauth ? ['oauth'] : [];
  const tokenMethods: TrackerAuthMethod[] = auth.token ? ['token'] : [];

  return Object.freeze({
    id,
    name: label,
    authMethods: freezeList([...oauthMethods, ...tokenMethods]),
    capabilities: Object.freeze({
      multipleAccounts: capabilities.multipleAccounts === true,
      stateUpdate: capabilities.stateUpdate === true,
      children: capabilities.children === true,
      labels: capabilities.labels === true,
      priority: capabilities.priority === true,
      filters: Object.freeze({ people: capabilities.filters?.people === true, priority: capabilities.filters?.priority === true }),
      projectMapping: capabilities.projectMapping === true,
      sessionComments: capabilities.sessionComments === true,
      hostAccess: false,
    }),
    stateFilters: freezeList(stateFilters),
    urlPatterns: freezeList(urlPatterns),
    identifierPattern: identifierPatternOf(identifier),
  });
}

export const createDescriptorUrlMatcher = (descriptor: Pick<TrackerDescriptor, 'identifierPattern' | 'urlPatterns'>) => {
  const identifier = new RegExp(descriptor.identifierPattern);
  const patterns = descriptor.urlPatterns.map((pattern) => ({
    host: pattern.host.toLowerCase(),
    path: new RegExp(pattern.path),
    query: pattern.query?.name ?? null,
  }));
  return (value: string) => {
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
