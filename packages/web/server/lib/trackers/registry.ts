import { linearTracker } from '../linear/tracker.js';
import { isPlainObject } from '../shared/guards.js';
import { sourceControlProviderDescriptors } from '../source-control/provider-descriptors.js';
import { EXTENSION_PROVIDER_PREFIX, isExtensionProviderId, isProviderId, isReservedProviderId } from '../source-control/provider-id.js';

import type { TrackerEntry, TrackerImplementation } from './tracker-contract.js';
import type { createExtensionTracker } from './extension-tracker.js';

export type RegisteredTrackerImplementation = TrackerImplementation | (ReturnType<typeof createExtensionTracker> & { hostAccess?: never });
export type ExtensionTrackerEntry = {
  descriptor: TrackerEntry['descriptor'];
  load(): Promise<RegisteredTrackerImplementation>;
};

export const BUILT_IN_TRACKERS = Object.freeze([linearTracker]);

const isFreezable = (value: unknown): value is object => Array.isArray(value) || isPlainObject(value);

const deepFreeze = <T>(value: T): T => {
  if (isFreezable(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};

const invalidEntry = (id: string, reason: string) => new Error(`Tracker registration is invalid (${String(id)}): ${reason}`);

type TrackerSlot = {
  descriptor: TrackerEntry['descriptor'];
  load: ExtensionTrackerEntry['load'];
  loading: Promise<RegisteredTrackerImplementation> | null;
};

const slotOf = (entry: ExtensionTrackerEntry): TrackerSlot => ({
  descriptor: deepFreeze(structuredClone(entry.descriptor)),
  load: entry.load,
  loading: null,
});

export function createTrackerRegistry(
  entries: readonly TrackerEntry[] = BUILT_IN_TRACKERS,
  { foreignIds = sourceControlProviderDescriptors.list().map((descriptor) => descriptor.id) }: { foreignIds?: readonly string[] } = {},
) {
  const builtIn = new Map<string, TrackerSlot>();
  for (const entry of entries) {
    const id = entry?.descriptor?.id;
    if (!isProviderId(id)) throw invalidEntry(id, 'malformed id');
    if (isReservedProviderId(id)) throw invalidEntry(id, 'reserved id');
    if (foreignIds.includes(id) || id.startsWith(EXTENSION_PROVIDER_PREFIX)) throw invalidEntry(id, 'id belongs to a source-control provider');
    if (builtIn.has(id)) throw invalidEntry(id, 'duplicate id');
    if (!(entry.load instanceof Function)) throw invalidEntry(id, 'missing loader');
    builtIn.set(id, slotOf(entry));
  }
  const attached = new Map<string, TrackerSlot>();

  const slots = () => [...builtIn.values(), ...attached.values()];
  const slot = (id: string) => builtIn.get(id) ?? attached.get(id) ?? null;

  return Object.freeze({
    has: (id: string) => slot(id) !== null,
    descriptor: (id: string) => slot(id)?.descriptor ?? null,
    descriptors: () => Object.freeze(slots().map((entry) => entry.descriptor)),
    list: () => Object.freeze(slots().map((entry) => entry.descriptor.id)),
    implementation: async (id: string) => {
      const current = slot(id);
      if (!current) return null;
      if (!current.loading) {
        current.loading = Promise.resolve().then(() => current.load()).catch((error) => {
          current.loading = null;
          throw error;
        });
      }
      return current.loading;
    },
    attachExtension: (entry: ExtensionTrackerEntry) => {
      const id = entry?.descriptor?.id;
      if (!isExtensionProviderId(id)) throw invalidEntry(id, 'an extension tracker is named ext-<guestId>');
      if (foreignIds.includes(id)) throw invalidEntry(id, 'id belongs to a source-control provider');
      if (!(entry.load instanceof Function)) throw invalidEntry(id, 'missing loader');
      attached.set(id, slotOf(entry));
    },
    detachExtension: (id: string) => attached.delete(id),
  });
}
