import { linearTracker } from '../linear/tracker.js';
import { isPlainObject } from '../shared/guards.js';
import { sourceControlProviderDescriptors } from '../source-control/provider-descriptors.js';
import { EXTENSION_PROVIDER_PREFIX, isProviderId, isReservedProviderId } from '../source-control/provider-id.js';

/** @typedef {import('./tracker-contract').TrackerEntry} TrackerEntry */
/** @typedef {import('./tracker-contract').TrackerDescriptor} TrackerDescriptor */
/** @typedef {import('./tracker-contract').TrackerImplementation} TrackerImplementation */
/** @typedef {import('./tracker-contract').TrackerRegistry} TrackerRegistry */

/**
 * The built-in trackers in registration order: one module folder and one entry here each.
 * `server/index.js` builds the one registry over them.
 */
export const BUILT_IN_TRACKERS = Object.freeze([linearTracker]);

// Descriptors are plain JSON: objects, arrays and primitives.
const deepFreeze = (value) => {
  if (Array.isArray(value) || isPlainObject(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};

const invalidEntry = (id, reason) => new Error(`Tracker registration is invalid (${String(id)}): ${reason}`);

/**
 * The tracker registry: descriptors answered synchronously, implementations
 * loaded the first time they are asked for and kept.
 *
 * Tracker ids share one namespace with source-control provider ids (tracked
 * items and the read cache key on `provider`), so an id a source-control
 * provider owns is refused, as are the reserved ids and malformed ones. So is
 * any `ext-` id: extension source-control providers attach after this
 * registry is built, so the prefix is refused rather than a snapshot of ids.
 * A bad registration is a programming error and throws at construction.
 *
 * @param {TrackerEntry[]} [entries]
 * @param {{ foreignIds?: string[] }} [options] ids owned by the other registry.
 * @returns {TrackerRegistry}
 */
export function createTrackerRegistry(
  entries = BUILT_IN_TRACKERS,
  { foreignIds = sourceControlProviderDescriptors.list().map((descriptor) => descriptor.id) } = {},
) {
  const byId = new Map();
  for (const entry of entries) {
    const id = entry?.descriptor?.id;
    if (!isProviderId(id)) throw invalidEntry(id, 'malformed id');
    if (isReservedProviderId(id)) throw invalidEntry(id, 'reserved id');
    if (foreignIds.includes(id) || id.startsWith(EXTENSION_PROVIDER_PREFIX)) throw invalidEntry(id, 'id belongs to a source-control provider');
    if (byId.has(id)) throw invalidEntry(id, 'duplicate id');
    if (!(entry.load instanceof Function)) throw invalidEntry(id, 'missing loader');
    byId.set(id, {
      // A copy, so the plain JSON a client reads cannot be changed through a
      // module's own descriptor object.
      descriptor: deepFreeze(structuredClone(entry.descriptor)),
      load: entry.load,
      loading: null,
    });
  }
  const descriptors = Object.freeze([...byId.values()].map((slot) => slot.descriptor));
  const ids = Object.freeze([...byId.keys()]);

  return Object.freeze({
    has: (id) => byId.has(id),
    descriptor: (id) => byId.get(id)?.descriptor ?? null,
    descriptors: () => descriptors,
    list: () => ids,
    implementation: async (id) => {
      const slot = byId.get(id);
      if (!slot) return null;
      if (!slot.loading) {
        // A failed load is not cached, so the next request tries again.
        slot.loading = Promise.resolve().then(() => slot.load()).catch((error) => {
          slot.loading = null;
          throw error;
        });
      }
      return slot.loading;
    },
  });
}
