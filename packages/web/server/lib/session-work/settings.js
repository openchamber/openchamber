/**
 * `sessionWorkEntry`: how sessions enter In work. `off` (only Track puts a
 * session in work), `every-message` (every sent message does), `jev` (Jev
 * reads each sent message and each finished turn and decides; without a
 * classification provider nothing enters, as with `off`).
 */
const SESSION_WORK_ENTRY_VALUES = new Set(['off', 'every-message', 'jev']);

const DEFAULT_SESSION_WORK_ENTRY = 'off';

export const isSessionWorkEntry = (value) => SESSION_WORK_ENTRY_VALUES.has(value);

/**
 * The entry mode for a settings document. A document from before the setting
 * existed has none: until then every sent message put a session in work while
 * `sessionWorkEnabled` was on, so someone who had set that switch on keeps
 * that; everyone else gets the default.
 */
export const resolveSessionWorkEntry = (settings) => {
  if (isSessionWorkEntry(settings?.sessionWorkEntry)) return settings.sessionWorkEntry;
  return settings?.sessionWorkEnabled === true ? 'every-message' : DEFAULT_SESSION_WORK_ENTRY;
};
