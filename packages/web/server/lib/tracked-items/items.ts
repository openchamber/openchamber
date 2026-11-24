import { sourceControlProviderDescriptors as descriptors } from '../source-control/provider-descriptors.js';
import { isProviderId, isReservedProviderId } from '../source-control/provider-id.js';
import { allowsTopLevelProjects, joinProjectPath } from '../source-control/project-path.js';
import type { ProviderDescriptor } from '../source-control/provider-contract.js';
import type { CachedTrackedState, TrackedItem, TrackedItemInput, TrackedThread, TrackedWorkItem } from './contracts.js';

const isText = (value: unknown): value is { trim(): string } => Object.prototype.toString.call(value) === '[object String]';
export const isPlainRecord = (value: unknown): value is object => Object.prototype.toString.call(value) === '[object Object]';
export const isTrackedItemInput = (value: unknown): value is TrackedItemInput => isPlainRecord(value);
export const isCachedTrackedState = (value: unknown): value is CachedTrackedState => isPlainRecord(value);

const threadKindOf = (kind: string, descriptor: ProviderDescriptor) => (
  kind === 'pull' || kind === 'issue' || (kind === 'discussion' && descriptor.capabilities.discussions === true) ? kind : null
);
const WORK_ITEM_KIND = 'work-item';
const WORK_ITEM_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SEGMENT = /^[^\s/]+$/;
const NAMESPACE = /^[^\s/]+(?:\/[^\s/]+)*$/;

const isSafeInteger = (value: unknown): value is number => Number.isSafeInteger(value);
const isPositiveNumber = (value: unknown): value is number => isSafeInteger(value) && value > 0;

const parseWorkItem = (value: TrackedItemInput, provider: string): TrackedWorkItem | null => {
  if (descriptors.has(provider) || isReservedProviderId(provider)) return null;
  const identifier = (isText(value.identifier) ? value.identifier.trim() : '').toUpperCase();
  return WORK_ITEM_IDENTIFIER.test(identifier) ? { provider, kind: WORK_ITEM_KIND, identifier } : null;
};

const parseThread = (value: TrackedItemInput, descriptor: ProviderDescriptor): TrackedThread | null => {
  const kind = threadKindOf(isText(value.kind) ? value.kind.trim() : '', descriptor);
  const owner = isText(value.owner) ? value.owner.trim() : '';
  const repo = isText(value.repo) ? value.repo.trim() : '';
  const number = isPositiveNumber(value.number) ? value.number : null;
  if (!kind || !SEGMENT.test(repo) || number === null) return null;
  const topLevel = owner === '' && allowsTopLevelProjects(descriptor);
  if (!topLevel && !(descriptor.trackedItems.nestedOwners ? NAMESPACE : SEGMENT).test(owner)) return null;
  const accountId = isText(value.accountId) ? value.accountId.trim() : '';
  const account = accountId ? { accountId } : {};
  if (descriptor.instance.form === 'origin') {
    const rawInstance = value.instance;
    try {
      const url = new URL(isText(rawInstance) ? rawInstance.trim() : '');
      const instance = url.protocol === 'https:' || url.protocol === 'http:' ? url.origin.toLowerCase() : '';
      return instance ? { provider: descriptor.id, instance, kind, owner, repo, number, ...account } : null;
    } catch {
      return null;
    }
  }
  const instance = (isText(value.instance) ? value.instance.trim() : '').toLowerCase();
  if (!instance && !descriptor.trackedItems.defaultInstance) return null;
  return { provider: descriptor.id, instance: instance || undefined, kind, owner, repo, number, ...account };
};

export function parseTrackedItem(value: TrackedItemInput & { kind: 'pull' | 'issue' | 'discussion' }): TrackedThread | null;
export function parseTrackedItem(value: TrackedItemInput): TrackedItem | null;
export function parseTrackedItem(value: TrackedItemInput): TrackedItem | null {
  if (!isPlainRecord(value)) return null;
  const provider = isText(value.provider) ? value.provider.trim() : '';
  if (!isProviderId(provider)) return null;
  const kind = isText(value.kind) ? value.kind.trim() : '';
  if (kind === WORK_ITEM_KIND || (!kind && provider === 'linear')) return parseWorkItem(value, provider);
  const descriptor = descriptors.get(provider);
  return descriptor ? parseThread(value, descriptor) : null;
}

export const isWorkItem = (item: TrackedItem): item is TrackedWorkItem => item.kind === WORK_ITEM_KIND;

export const threadInstance = (item: TrackedThread) => (
  item.instance ?? descriptors.get(item.provider)?.trackedItems.defaultInstance ?? ''
);

export function trackedItemKey(item: TrackedItem) {
  if (isWorkItem(item)) return `${item.provider}|${item.identifier.toUpperCase()}`;
  const thread = `${item.kind}|${joinProjectPath(item.owner, item.repo)}#${item.number}`.toLowerCase();
  const instance = threadInstance(item).toLowerCase();
  const account = item.accountId ? `@${item.accountId}` : '';
  return `${item.provider}|${instance}|${thread}${account}`;
}

export function parseTrackedItems(value: unknown[] | null | undefined, limit: number) {
  if (!Array.isArray(value) || value.length > limit) return null;
  const items = new Map<string, TrackedItem>();
  for (const raw of value) {
    const item = isTrackedItemInput(raw) ? parseTrackedItem(raw) : null;
    if (item) items.set(trackedItemKey(item), item);
  }
  return items;
}
