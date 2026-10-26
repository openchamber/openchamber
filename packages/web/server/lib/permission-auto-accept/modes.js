/**
 * How a session answers tool permissions:
 *
 * - `ask`: every request waits for the user.
 * - `safety`: requests are accepted unless the safety net (Jev) says the user
 *   should decide; without an answer from Jev the request waits.
 * - `auto`: every request is accepted.
 *
 * Policy files written before the modes existed store booleans: `false` is
 * `ask`, and `true` meant auto-accept, which the old global safety-net switch
 * turned into `safety`. The caller supplies that answer as `legacyEnabledMode`.
 */
export const PERMISSION_MODES = ['ask', 'safety', 'auto'];

export const isPermissionMode = (value) => PERMISSION_MODES.includes(value);

/** A stored or requested value as a mode, or null when it is neither a mode nor a legacy boolean. */
export const toPermissionMode = (value, legacyEnabledMode = 'auto') => {
  if (isPermissionMode(value)) return value;
  if (value === true) return legacyEnabledMode;
  if (value === false) return 'ask';
  return null;
};

/** What clients that only know on/off see: anything but `ask` answers requests by itself. */
export const isAutoAnsweringMode = (mode) => mode === 'safety' || mode === 'auto';
