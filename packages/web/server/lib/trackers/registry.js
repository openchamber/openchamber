import { linearTracker } from '../linear/tracker.js';
import { isPlainObject } from '../shared/guards.js';
import { sourceControlProviderDescriptors } from '../source-control/provider-descriptors.js';
import { EXTENSION_PROVIDER_PREFIX, isExtensionProviderId, isProviderId, isReservedProviderId } from '../source-control/provider-id.js';

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

/** One registry slot: the frozen plain-JSON copy of the descriptor and the lazy loader. */
const slotOf = (entry) => ({
  // A copy, so the plain JSON a client reads cannot be changed through a
  // module's own descriptor object.
  descriptor: deepFreeze(structuredClone(entry.descriptor)),
  load: entry.load,
  loading: null,
});

/**
 * The tracker registry: descriptors answered synchronously, implementations
 * loaded the first time they are asked for and kept.
 *
 * Two layers share one namespace with source-control provider ids (tracked
 * items and the read cache key on `provider`). The built-ins are fixed at
 * construction: an id a source-control provider owns is refused, as are the
 * reserved ids and malformed ones, and so is any `ext-` id, which only an
 * extension may take. A bad built-in registration is a programming error and
 * throws at construction. Extensions attach and detach while the server runs
 * (`attachExtension`, `detachExtension`: `ext-<guestId>` ids only, from the
 * extension layer in `extension-trackers.js`), so `list()` and `descriptors()`
 * answer what is registered now, built-ins first.
 *
 * @param {TrackerEntry[]} [entries]
 * @param {{ foreignIds?: string[] }} [options] ids owned by the other registry.
 * @returns {TrackerRegistry & {
 *   attachExtension: (entry: TrackerEntry) => void,
 *   detachExtension: (id: string) => boolean,
 * }}
 */
export function createTrackerRegistry(
  entries = BUILT_IN_TRACKERS,
  { foreignIds = sourceControlProviderDescriptors.list().map((descriptor) => descriptor.id) } = {},
) {
  const builtIn = new Map();
  for (const entry of entries) {
    const id = entry?.descriptor?.id;
    if (!isProviderId(id)) throw invalidEntry(id, 'malformed id');
    if (isReservedProviderId(id)) throw invalidEntry(id, 'reserved id');
    if (foreignIds.includes(id) || id.startsWith(EXTENSION_PROVIDER_PREFIX)) throw invalidEntry(id, 'id belongs to a source-control provider');
    if (builtIn.has(id)) throw invalidEntry(id, 'duplicate id');
    if (!(entry.load instanceof Function)) throw invalidEntry(id, 'missing loader');
    builtIn.set(id, slotOf(entry));
  }
  /** Extension trackers, in attach order; a re-attach keeps the slot's place. */
  const attached = new Map();

  const slots = () => [...builtIn.values(), ...attached.values()];
  const slot = (id) => builtIn.get(id) ?? attached.get(id) ?? null;

  return Object.freeze({
    has: (id) => slot(id) !== null,
    descriptor: (id) => slot(id)?.descriptor ?? null,
    descriptors: () => Object.freeze(slots().map((entry) => entry.descriptor)),
    list: () => Object.freeze(slots().map((entry) => entry.descriptor.id)),
    implementation: async (id) => {
      const current = slot(id);
      if (!current) return null;
      if (!current.loading) {
        // A failed load is not cached, so the next request tries again.
        current.loading = Promise.resolve().then(() => current.load()).catch((error) => {
          current.loading = null;
          throw error;
        });
      }
      return current.loading;
    },
    /**
     * An installed extension's tracker, named `ext-<guestId>` by the host.
     * Attaching an id again replaces its descriptor and loader (a new version,
     * a connected server), and a load already cached is dropped with it.
     */
    attachExtension: (entry) => {
      const id = entry?.descriptor?.id;
      if (!isExtensionProviderId(id)) throw invalidEntry(id, 'an extension tracker is named ext-<guestId>');
      if (foreignIds.includes(id)) throw invalidEntry(id, 'id belongs to a source-control provider');
      if (!(entry.load instanceof Function)) throw invalidEntry(id, 'missing loader');
      attached.set(id, slotOf(entry));
    },
    /** True when an extension tracker was registered under the id. Built-ins never detach. */
    detachExtension: (id) => attached.delete(id),
  });
}
