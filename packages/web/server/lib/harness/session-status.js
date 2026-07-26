/**
 * Merge Claude harness busy sessions into OpenCode `/session/status` snapshots.
 * OpenCode does not own harness turns, so its status poll would otherwise report
 * those sessions idle and the UI watchdog would clear Stop / queue auto-send.
 */

import { listHarnessBusyStatuses } from './turn-snapshot.js';

/**
 * @param {unknown} openCodeStatuses
 * @param {string} [directory]
 * @returns {Record<string, { type: string, [key: string]: unknown }>}
 */
export function mergeHarnessBusyIntoSessionStatuses(openCodeStatuses, directory) {
  const base = openCodeStatuses && typeof openCodeStatuses === 'object' && !Array.isArray(openCodeStatuses)
    ? { ...openCodeStatuses }
    : {};
  const harnessBusy = listHarnessBusyStatuses(directory);
  for (const [sessionId, status] of Object.entries(harnessBusy)) {
    base[sessionId] = status;
  }
  return base;
}
