import { createLocalTracker, LOCAL_TRACKER_DESCRIPTOR } from './tracker.js';

/** @typedef {import('../trackers/tracker-contract').TrackerEntry} TrackerEntry */

/**
 * The projects reader the local tracker lists issues from. `settings-runtime.js`
 * exports only the `createSettingsRuntime` factory — the runtime instance (and
 * so the migrated settings state) belongs to `server/index.js` — so the server
 * hands its reader over once at startup and this module stays free of a
 * settings-runtime dependency of its own.
 * @type {(() => Promise<{ projects?: unknown[] } | null>) | null}
 */
let readSettings = null;

/**
 * Called once by `server/index.js` before any tracker load.
 * @param {{ readSettings: () => Promise<{ projects?: unknown[] } | null> }} deps
 */
export const configureLocalTracker = ({ readSettings: reader }) => {
  readSettings = reader;
};

/** @type {TrackerEntry} */
export const localTracker = {
  descriptor: LOCAL_TRACKER_DESCRIPTOR,
  load: async () => {
    if (!readSettings) {
      throw new Error('The local tracker is not configured: the server must call configureLocalTracker({ readSettings }) at startup');
    }
    // A settings read failure throws through to the caller (routes answer 500,
    // the session-status load is retried) instead of presenting every issue as
    // gone; only settings without a project array read as an empty list.
    const listProjects = async () => {
      const settings = await readSettings();
      return settings && Array.isArray(settings.projects) ? settings.projects : [];
    };
    return createLocalTracker({ listProjects });
  },
};
