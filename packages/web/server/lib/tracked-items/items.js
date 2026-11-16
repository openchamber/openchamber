import { sourceControlProviderDescriptors as descriptors } from '../source-control/provider-descriptors.js';
import { isProviderId, isReservedProviderId } from '../source-control/provider-id.js';
import { allowsTopLevelProjects, joinProjectPath } from '../source-control/project-path.js';

const isText = (value) => Object.prototype.toString.call(value) === '[object String]';
const text = (value) => (isText(value) ? value.trim() : '');
export const isPlainRecord = (value) => Object.prototype.toString.call(value) === '[object Object]';

const THREAD_KINDS = new Set(['pull', 'issue']);
const threadKindOf = (kind, descriptor) => (
  THREAD_KINDS.has(kind) || (kind === 'discussion' && descriptor.capabilities.discussions === true) ? kind : null
);
const WORK_ITEM_KIND = 'work-item';
const WORK_ITEM_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SEGMENT = /^[^\s/]+$/;
const NAMESPACE = /^[^\s/]+(?:\/[^\s/]+)*$/;

const positiveNumber = (value) => (Number.isSafeInteger(value) && value > 0 ? value : null);

const instanceOrigin = (value) => {
  try {
    const url = new URL(text(value));
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin.toLowerCase() : '';
  } catch {
    return '';
  }
};

const parseWorkItem = (value, provider) => {
  if (descriptors.has(provider) || isReservedProviderId(provider)) return null;
  const identifier = text(value.identifier).toUpperCase();
  return WORK_ITEM_IDENTIFIER.test(identifier) ? { provider, kind: WORK_ITEM_KIND, identifier } : null;
};

const parseThread = (value, descriptor) => {
  const kind = threadKindOf(text(value.kind), descriptor);
  const owner = text(value.owner);
  const repo = text(value.repo);
  const number = positiveNumber(value.number);
  if (!kind || !SEGMENT.test(repo) || number === null) return null;
  const topLevel = owner === '' && allowsTopLevelProjects(descriptor);
  if (!topLevel && !(descriptor.trackedItems.nestedOwners ? NAMESPACE : SEGMENT).test(owner)) return null;
  const accountId = text(value.accountId);
  const account = accountId ? { accountId } : {};
  if (descriptor.instance.form === 'origin') {
    const instance = instanceOrigin(value.instance);
    return instance ? { provider: descriptor.id, instance, kind, owner, repo, number, ...account } : null;
  }
  const instance = text(value.instance).toLowerCase();
  if (!instance && !descriptor.trackedItems.defaultInstance) return null;
  return { provider: descriptor.id, instance: instance || undefined, kind, owner, repo, number, ...account };
};

export function parseTrackedItem(value) {
  if (!isPlainRecord(value)) return null;
  const provider = text(value.provider);
  if (!isProviderId(provider)) return null;
  const kind = text(value.kind);
  if (kind === WORK_ITEM_KIND || (!kind && provider === 'linear')) return parseWorkItem(value, provider);
  const descriptor = descriptors.get(provider);
  return descriptor ? parseThread(value, descriptor) : null;
}

export const isWorkItem = (item) => item.kind === WORK_ITEM_KIND;

export const threadInstance = (item) => (
  item.instance ?? descriptors.get(item.provider)?.trackedItems.defaultInstance ?? ''
);

export function trackedItemKey(item) {
  if (isWorkItem(item)) return `${item.provider}|${item.identifier.toUpperCase()}`;
  const thread = `${item.kind}|${joinProjectPath(item.owner, item.repo)}#${item.number}`.toLowerCase();
  const instance = threadInstance(item).toLowerCase();
  const account = item.accountId ? `@${item.accountId}` : '';
  return `${item.provider}|${instance}|${thread}${account}`;
}

export function parseTrackedItems(value, limit) {
  if (!Array.isArray(value) || value.length > limit) return null;
  const items = new Map();
  for (const raw of value) {
    const item = parseTrackedItem(raw);
    if (item) items.set(trackedItemKey(item), item);
  }
  return items;
}
