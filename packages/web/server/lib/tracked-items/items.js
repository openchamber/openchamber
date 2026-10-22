// What the server can follow on a client's behalf: a change request or issue
// on a registered source-control provider, or a work item on a tracker.
// Parsed here once, at the boundary; everything past this file works with
// these shapes and the key they produce.

import { sourceControlProviderDescriptors as descriptors } from '../source-control/provider-descriptors.js';
import { isProviderId, isReservedProviderId } from '../source-control/provider-id.js';
import { allowsTopLevelProjects, joinProjectPath } from '../source-control/project-path.js';

const isText = (value) => Object.prototype.toString.call(value) === '[object String]';
const text = (value) => (isText(value) ? value.trim() : '');
export const isPlainRecord = (value) => Object.prototype.toString.call(value) === '[object Object]';

const THREAD_KINDS = new Set(['pull', 'issue']);
const WORK_ITEM_KIND = 'work-item';
// A tracker's human key (Linear's ENG-12). Each tracker checks its own shape
// when it reads; this only keeps the key and the batch request sane.
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

/**
 * A work item names a tracker by id. Trackers and source-control providers
 * share one id namespace, so a source-control id or a reserved id is never a
 * tracker; whether the id is registered is the reader's answer at read time.
 * The legacy shape `{ provider: 'linear', identifier }` without `kind` is
 * what older clients send and older files hold.
 */
const parseWorkItem = (value, provider) => {
  if (descriptors.has(provider) || isReservedProviderId(provider)) return null;
  const identifier = text(value.identifier).toUpperCase();
  return WORK_ITEM_IDENTIFIER.test(identifier) ? { provider, kind: WORK_ITEM_KIND, identifier } : null;
};

/**
 * A source-control item, in the shape its descriptor's `trackedItems` names:
 * owners are namespace paths where the provider nests them (GitLab
 * subgroups), single segments elsewhere; repository names are always one
 * segment. A host-form instance (GitHub) may be missing and then means the
 * provider's default instance, kept missing so the client's shape round-trips;
 * an origin-form instance is required. `accountId` names the account a
 * repository is bound to (a branch's pull request); without it the host's
 * current account reads it (a linked item).
 */
const parseThread = (value, descriptor) => {
  const kind = text(value.kind);
  const owner = text(value.owner);
  const repo = text(value.repo);
  const number = positiveNumber(value.number);
  if (!THREAD_KINDS.has(kind) || !SEGMENT.test(repo) || number === null) return null;
  // A path provider's top-level project (Gerrit's `demo`) has no owner.
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

/** One followed item, or null when the value names nothing the server can read. */
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

/** The instance a source-control item is read on: its own, else its provider's default. */
export const threadInstance = (item) => (
  item.instance ?? descriptors.get(item.provider)?.trackedItems.defaultInstance ?? ''
);

/** Case-insensitive identity, the same one the UI computes for the same item. */
export function trackedItemKey(item) {
  if (isWorkItem(item)) return `${item.provider}|${item.identifier.toUpperCase()}`;
  // The joined project path: `owner/repo` as always, `repo` for a top-level project.
  const thread = `${item.kind}|${joinProjectPath(item.owner, item.repo)}#${item.number}`.toLowerCase();
  // The same owner/repo/number on two instances (github.com and an enterprise
  // host) must stay apart, so the instance is always part of the key.
  const instance = threadInstance(item).toLowerCase();
  // Account ids are opaque and case-sensitive; they stay as they are.
  const account = item.accountId ? `@${item.accountId}` : '';
  return `${item.provider}|${instance}|${thread}${account}`;
}

/** Reads a list of items, dropping malformed ones and duplicates; null when the value is not a list. */
export function parseTrackedItems(value, limit) {
  if (!Array.isArray(value) || value.length > limit) return null;
  const items = new Map();
  for (const raw of value) {
    const item = parseTrackedItem(raw);
    if (item) items.set(trackedItemKey(item), item);
  }
  return items;
}
