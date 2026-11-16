import { z } from 'zod';

const sessionEventSchema = z.object({
  type: z.string(),
  created: z.number().finite(),
  properties: z.object({ sessionID: z.string().min(1) }).loose(),
});

const statusSchema = z.object({ type: z.string() }).loose();

/**
 * @param {object} deps
 * @param {(sessionID: string, patch: object, options: { directory: string }) => Promise<unknown>} deps.persistSessionMetadataPatch
 * @param {(sessionID: string) => boolean | undefined} deps.isChildSession true for a known subsession
 */
export const createTurnDurationRecorder = ({ persistSessionMetadataPatch, isChildSession }) => {
  const startedAt = new Map();

  const record = (sessionID, start, endedAt, directory) => {
    if (isChildSession(sessionID) === true) return;
    const turn = { endedAt, durationMs: Math.max(0, endedAt - start) };
    void Promise.resolve(persistSessionMetadataPatch(sessionID, { openchamber: { turn } }, { directory }))
      .catch((error) => console.warn('[turn-duration] could not record a turn length:', error?.message ?? error));
  };

  const processPayload = (payload, directory = '') => {
    if (payload?.type === 'server.connected') {
      startedAt.clear();
      return;
    }
    const parsed = sessionEventSchema.safeParse(payload);
    if (!parsed.success) return;
    const { type, created, properties } = parsed.data;
    const { sessionID } = properties;

    if (type === 'session.status') {
      const status = statusSchema.safeParse(properties.status);
      if (status.success && (status.data.type === 'busy' || status.data.type === 'retry') && !startedAt.has(sessionID)) {
        startedAt.set(sessionID, created);
      }
      return;
    }
    if (type === 'session.deleted') {
      startedAt.delete(sessionID);
      return;
    }
    if (type !== 'session.idle' && type !== 'session.error') return;
    const start = startedAt.get(sessionID);
    startedAt.delete(sessionID);
    if (start !== undefined) record(sessionID, start, created, directory);
  };

  return { processPayload };
};
