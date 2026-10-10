/** Capture an archived root and its archived descendants before a queued send. */
export async function prepareUserMessageResume(sessionId, { archiveStore, getSession, getChildren, broadcastRestored }) {
  const entries = await archiveStore.getAll();
  const root = await getSession(sessionId);
  const archivedAt = Object.hasOwn(entries, sessionId) ? entries[sessionId] : root.time?.archived;
  if (root.parentID || !archivedAt) return async () => {};

  const targets = new Map([[sessionId, entries[sessionId]]]);
  const pending = [sessionId];
  for (let index = 0; index < pending.length; index += 1) {
    const children = await getChildren(pending[index]);
    if (children === null) {
      console.warn('[sessions] could not read archived subsessions for automatic restoration');
      continue;
    }
    for (const id of children) {
      if (targets.has(id)) continue;
      let stamp = entries[id];
      if (!Object.hasOwn(entries, id)) {
        try {
          stamp = (await getSession(id)).time?.archived;
        } catch {
          console.warn('[sessions] could not read a subsession for automatic restoration');
          continue;
        }
      }
      if (!stamp) continue;
      targets.set(id, entries[id]);
      pending.push(id);
    }
  }

  return async () => {
    const failed = [];
    for (const [id, expectedEntry] of targets) {
      const { restored, failedIds } = await archiveStore.unarchiveUnchanged(id, expectedEntry);
      failed.push(...failedIds);
      if (id === sessionId && failedIds.length) throw new Error('Could not restore archived session');
      // A later manual archive wins. Do not restore children if the root changed.
      if (id === sessionId && restored.length === 0) return;
      for (const entry of restored) broadcastRestored(entry.id);
    }
    if (failed.length) throw new Error('Could not restore some archived subsessions');
  };
}
