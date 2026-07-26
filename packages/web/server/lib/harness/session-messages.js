/**
 * Merge Claude harness turn-snapshot messages into OpenCode
 * `/session/:id/message` responses. Harness turns are broadcast-only into the
 * UI stream; OpenCode's message list is empty for those sessions, and an
 * authoritative empty refetch would wipe optimistic / event-applied chat.
 */

import { getSessionBinding } from './session-bindings.js';
import { getHarnessRecentMessages } from './turn-snapshot.js';

/**
 * @param {unknown} openCodeMessages
 * @param {string} sessionId
 * @returns {Array<{ info: object, parts?: object[] }>}
 */
export function mergeHarnessMessagesIntoSessionMessages(openCodeMessages, sessionId) {
  const base = Array.isArray(openCodeMessages) ? [...openCodeMessages] : [];
  if (typeof sessionId !== 'string' || !sessionId) {
    return base;
  }

  const binding = getSessionBinding(sessionId);
  if (binding?.harnessId !== 'claude-code') {
    return base;
  }

  const harnessMessages = getHarnessRecentMessages(sessionId);
  if (!Array.isArray(harnessMessages) || harnessMessages.length === 0) {
    return base;
  }

  const byId = new Map();
  for (const record of base) {
    const id = record?.info?.id;
    if (typeof id === 'string' && id) {
      byId.set(id, record);
    }
  }

  for (const record of harnessMessages) {
    const id = record?.info?.id;
    if (typeof id !== 'string' || !id) continue;
    const existing = byId.get(id);
    if (!existing) {
      base.push(record);
      byId.set(id, record);
      continue;
    }
    const existingParts = Array.isArray(existing.parts) ? existing.parts.length : 0;
    const nextParts = Array.isArray(record.parts) ? record.parts.length : 0;
    if (nextParts >= existingParts) {
      const index = base.indexOf(existing);
      if (index >= 0) base[index] = record;
      byId.set(id, record);
    }
  }

  base.sort((left, right) => {
    const leftId = typeof left?.info?.id === 'string' ? left.info.id : '';
    const rightId = typeof right?.info?.id === 'string' ? right.info.id : '';
    if (leftId < rightId) return -1;
    if (leftId > rightId) return 1;
    return 0;
  });

  return base;
}
