/**
 * Sessions nobody is meant to see: `metadata.hidden: true` on the session
 * record. OpenChamber's dreaming pass over the agent memory sets it, and so can
 * a plugin that runs sessions of its own. Every event and list that reaches a
 * client or a server-side consumer leaves them out, which keeps them out of the
 * sidebar, In work, notifications, hints and extension events alike.
 *
 * Most events carry only a session id, so the registry keeps the ids it has
 * learned: from a record's metadata in `session.created` and `session.updated`,
 * from every session list the proxy serves, and from the list read when the
 * server connects to OpenCode. An id stays for the life of the process, so the
 * events that trail a deleted session stay hidden too.
 */

import { z } from 'zod';

const hiddenRecordSchema = z.object({ metadata: z.object({ hidden: z.literal(true) }) });

/** Where a v2 wire event names its session: `data.sessionID`, a record's `data.info.id`, or a session event's `data.id`. */
const wireSessionSchema = z.object({
  type: z.string().catch(''),
  data: z.object({
    sessionID: z.string().optional().catch(undefined),
    id: z.string().optional().catch(undefined),
    metadata: z.unknown().optional(),
    info: z.object({ id: z.string().optional().catch(undefined), metadata: z.unknown().optional() }).optional().catch(undefined),
  }),
});

const sessionPageSchema = z.object({ data: z.array(z.unknown()) }).passthrough();
const activeMapSchema = z.record(z.string(), z.unknown());
const activeAnswerSchema = z.object({ data: activeMapSchema }).passthrough();
const listPageSchema = z.object({
  data: z.array(z.object({ id: z.string() }).passthrough()),
  cursor: z.object({ next: z.string().nullish() }).partial().nullish(),
});

const SEED_PAGES = 10;

export const createHiddenSessionRegistry = () => {
  const ids = new Set();

  const isHiddenRecord = (record) => hiddenRecordSchema.safeParse(record).success;
  const has = (sessionID, record) => ids.has(sessionID) || isHiddenRecord(record);
  const learn = (sessions) => {
    for (const session of sessions) {
      if (isHiddenRecord(session) && session?.id) ids.add(session.id);
    }
  };
  const visible = (sessions) => {
    learn(sessions);
    return sessions.filter((session) => !has(session?.id, session));
  };
  const visibleActive = (map) => Object.fromEntries(Object.entries(map).filter(([id]) => !ids.has(id)));

  return {
    add(sessionID) {
      if (sessionID) ids.add(sessionID);
    },
    has,
    isHiddenPayload(payload) {
      const parsed = wireSessionSchema.safeParse(payload);
      if (!parsed.success) return false;
      const { type, data } = parsed.data;
      const recordId = data.info?.id ?? data.sessionID ?? data.id;
      if (type.startsWith('session.') && recordId
        && (isHiddenRecord({ metadata: data.metadata }) || isHiddenRecord({ metadata: data.info?.metadata }))) {
        ids.add(recordId);
      }
      if (ids.size === 0) return false;
      return ids.has(data.sessionID) || ids.has(data.info?.id) || (type.startsWith('session.') && ids.has(data.id));
    },
    /** A session list answer without the hidden ones; anything else passes as it is. */
    filterSessionList(body) {
      if (Array.isArray(body)) return visible(body);
      const page = sessionPageSchema.safeParse(body);
      return page.success ? { ...page.data, data: visible(page.data.data) } : body;
    },
    /** `/api/session/active` without the hidden ones: `{ data: { [id]: status } }` or the bare map. */
    filterActive(body) {
      if (ids.size === 0) return body;
      const wrapped = activeAnswerSchema.safeParse(body);
      if (wrapped.success) return { ...wrapped.data, data: visibleActive(wrapped.data.data) };
      const bare = activeMapSchema.safeParse(body);
      return bare.success ? visibleActive(bare.data) : body;
    },
    /**
     * Learns the hidden sessions that already exist, from OpenCode's session
     * list: one left by a pass that outlived its server, or a plugin's. Run
     * when the server connects to OpenCode; a failed read only leaves them to
     * be learned from their next event or list.
     */
    async seed(readPage) {
      let cursor = null;
      for (let page = 0; page < SEED_PAGES; page += 1) {
        const parsed = listPageSchema.safeParse(await readPage(cursor));
        if (!parsed.success) return;
        learn(parsed.data.data);
        cursor = parsed.data.cursor?.next ?? null;
        if (!cursor) return;
      }
    },
  };
};
