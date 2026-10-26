/**
 * How long each session's last turn ran, kept on the session itself.
 *
 * The sidebar shows the length of a finished turn while the session is unread.
 * A page can measure it only while it is open, and the unread mark outlives the
 * page, so the server measures every turn from the event stream it always
 * holds and writes the result into the session's metadata,
 * `openchamber.turn = { endedAt, durationMs }`. Both stamps are OpenCode's own
 * event times, so `endedAt` is the `time.idle` OpenCode records for the turn,
 * which is how a reader tells the record of this turn from one of an older turn
 * (`packages/ui/src/lib/sessionTurnMetadata.ts`).
 *
 * Only a turn watched from its start is recorded. Starts live in memory: a
 * server restart or a reconnect of the event stream may have missed an end, so
 * both forget them rather than measure the next turn from a stale start.
 */
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
  /** sessionID → OpenCode's time of the event that started the running turn. */
  const startedAt = new Map();

  const record = (sessionID, start, endedAt, directory) => {
    // A subsession's turns roll up into its parent, which is what is shown.
    if (isChildSession(sessionID) === true) return;
    const turn = { endedAt, durationMs: Math.max(0, endedAt - start) };
    void Promise.resolve(persistSessionMetadataPatch(sessionID, { openchamber: { turn } }, { directory }))
      .catch((error) => console.warn('[turn-duration] could not record a turn length:', error?.message ?? error));
  };

  /** Takes the server's translated events (`event-stream/translate-v2.js`). */
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
      // Busy repeats at every step of a turn; only the first one starts it.
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
