import { sessionParentId } from '../session-lineage.js';
import type { OpenCodeClient } from '@opencode/client';

const ARCHIVED_PAGE_SIZE = 200;

export const listArchivedSubsessions = async (client: OpenCodeClient, rootID: string) => {
  const childrenOf = new Map<string, string[]>();
  const seenCursors = new Set<string>();
  let cursor: string | null | undefined;
  do {
    const page = await client.session.list(cursor
      ? { cursor }
      : { archived: true, limit: ARCHIVED_PAGE_SIZE });
    for (const record of page?.data ?? []) {
      const parentID = sessionParentId(record);
      if (!record?.id || !record.time?.archived || !parentID) continue;
      const siblings = childrenOf.get(parentID);
      if (siblings) siblings.push(record.id);
      else childrenOf.set(parentID, [record.id]);
    }
    cursor = page?.data?.length ? page.cursor?.next : undefined;
    if (cursor && seenCursors.has(cursor)) cursor = undefined;
    if (cursor) seenCursors.add(cursor);
  } while (cursor);
  const seen = new Set([rootID]);
  const parents = [rootID];
  while (parents.length > 0) {
    const parentID = parents.shift();
    if (parentID === undefined) throw new Error('missing parent in archived session traversal');
    for (const childID of childrenOf.get(parentID) ?? []) {
      if (seen.has(childID)) continue;
      seen.add(childID);
      parents.push(childID);
    }
  }
  seen.delete(rootID);
  return [...seen];
};
