import { z } from 'zod';
import type { JsonValue } from './contracts.js';
import type { Application } from '../shared/http-contracts.js';
import type { SessionClient } from '../openchamber-sessions/opencode-client-contract.js';

const PENDING_MS = 30 * 1000;
const READ_TIMEOUT_MS = 5 * 1000;
type CompactionState = 'pending' | 'running' | 'done' | 'failed';
const COMPACTION_STATES = new Map<string, CompactionState>([['session.compaction.started', 'running'], ['session.compaction.ended', 'done'], ['session.compaction.failed', 'failed']]);
const TERMINAL_TYPES = new Set(['session.execution.succeeded', 'session.execution.failed', 'session.execution.interrupted']);

const wireSchema = z.object({
  type: z.string(),
  created: z.number().optional().catch(undefined),
  data: z.object({
    sessionID: z.string().min(1),
    inboxID: z.string().optional().catch(undefined),
    item: z.object({ type: z.string() }).optional().catch(undefined),
  }),
  location: z.json().optional(),
});
const sessionTimeSchema = z.object({ time: z.object({ idle: z.number().optional().catch(undefined), viewed: z.number().optional().catch(undefined) }) });
const activeMapSchema = z.record(z.string(), z.unknown());
const activeAnswerSchema = z.object({ data: activeMapSchema }).passthrough();

interface Before {
  read: boolean;
  idle: number | undefined;
}

interface QuietCompactionOptions {
  client: () => Pick<SessionClient, 'session'>;
  unreadSince?: () => Promise<number | null>;
  onSettled?: (sessionId: string) => void;
  now?: () => number;
  warn?: (...args: unknown[]) => void;
}

export const createQuietCompaction = ({
  client,
  unreadSince = async () => null,
  onSettled = () => {},
  now = Date.now,
  warn = (...args) => console.warn(...args),
}: QuietCompactionOptions) => {
  const running = new Set<string>();
  const pending = new Map<string, { at: number; before: Before }>();
  const quiet = new Map<string, { before: Before; compaction: CompactionState }>();
  const turnStarts = new Map<string, number>();
  const compactionInputs = new Set<string>();
  let synthetic = 0;

  const readBefore = async (sessionID: string): Promise<Before> => {
    const [{ time: { idle, viewed } }, since] = await Promise.all([
      client().session.get({ sessionID }, { signal: AbortSignal.timeout(READ_TIMEOUT_MS) }).then((session) => sessionTimeSchema.parse(session)),
      unreadSince(),
    ]);
    const read = idle === undefined || (viewed !== undefined && viewed >= idle) || (since !== null && idle <= since);
    return { read, idle };
  };

  const isPending = (sessionId: string) => {
    const entry = pending.get(sessionId);
    if (entry && now() - entry.at > PENDING_MS) pending.delete(sessionId);
    return pending.has(sessionId);
  };

  const mark = async (sessionId: string) => {
    if (running.has(sessionId) || quiet.has(sessionId)) return;
    const starts = turnStarts.get(sessionId);
    const before = await readBefore(sessionId).catch((error: Error) => {
      warn('[quiet-compaction] could not read whether the session was read:', error.message);
      return { read: false, idle: undefined };
    });
    if (running.has(sessionId) || quiet.has(sessionId) || turnStarts.get(sessionId) !== starts) return;
    pending.set(sessionId, { at: now(), before });
  };

  const unmark = (sessionId: string) => {
    pending.delete(sessionId);
  };

  const keepRead = async (sessionID: string, { read, idle }: Before, endedAt: number) => {
    if (read) await client().session.view({ sessionID, idle: Math.max(endedAt, (idle ?? -Infinity) + 1) });
  };

  const loud = (sessionID: string, location: JsonValue | undefined): JsonValue[] => {
    quiet.delete(sessionID);
    synthetic += 1;
    const busy: JsonValue = { id: `oc-quiet-${synthetic}`, type: 'session.status', data: { sessionID, status: { type: 'busy' } } };
    return [location === undefined ? busy : { ...busy, location }];
  };

  const admit = (payload: JsonValue): JsonValue[] => {
    const parsed = wireSchema.safeParse(payload);
    if (!parsed.success) return [payload];
    const { type, created, location, data: { sessionID, inboxID, item } } = parsed.data;
    if (type === 'session.execution.started') {
      running.add(sessionID);
      turnStarts.set(sessionID, (turnStarts.get(sessionID) ?? 0) + 1);
      quiet.delete(sessionID);
      const marked = isPending(sessionID) ? pending.get(sessionID) : undefined;
      pending.delete(sessionID);
      if (!marked) return [payload];
      quiet.set(sessionID, { before: marked.before, compaction: 'pending' });
      return [];
    }
    if (TERMINAL_TYPES.has(type)) {
      running.delete(sessionID);
      const turn = quiet.get(sessionID);
      quiet.delete(sessionID);
      const workAfterCompaction = turn?.compaction === 'done' && type !== 'session.execution.succeeded';
      if (!turn || turn.compaction === 'pending' || workAfterCompaction) return [payload];
      if (type === 'session.execution.failed') warn(`[quiet-compaction] a compaction of ${sessionID} failed`);
      void keepRead(sessionID, turn.before, created ?? now()).catch((error: Error) => warn('[quiet-compaction] could not keep the session read:', error.message));
      onSettled(sessionID);
      return [];
    }
    const compaction = COMPACTION_STATES.get(type);
    if (compaction) {
      const turn = quiet.get(sessionID);
      if (turn) turn.compaction = compaction;
      return [payload];
    }
    if (type === 'session.inbox.enqueued' && inboxID && item?.type === 'compaction') {
      compactionInputs.add(inboxID);
      return [payload];
    }
    if (type === 'session.inbox.delivered' && inboxID) {
      const compaction = compactionInputs.delete(inboxID);
      return quiet.has(sessionID) && !compaction ? [...loud(sessionID, location), payload] : [payload];
    }
    if (type === 'session.step.started' && quiet.has(sessionID)) return [...loud(sessionID, location), payload];
    if (type === 'session.deleted') {
      running.delete(sessionID);
      pending.delete(sessionID);
      quiet.delete(sessionID);
      turnStarts.delete(sessionID);
    }
    return [payload];
  };

  const isQuiet = (sessionId: string) => quiet.has(sessionId) || isPending(sessionId);
  const visibleActive = <Value>(map: Record<string, Value>) => Object.fromEntries(Object.entries(map).filter(([id]) => !isQuiet(id)));

  const filterActive = <Body>(body: Body) => {
    if (quiet.size === 0 && pending.size === 0) return body;
    const wrapped = activeAnswerSchema.safeParse(body);
    if (wrapped.success) return { ...wrapped.data, data: visibleActive(wrapped.data.data) };
    const bare = activeMapSchema.safeParse(body);
    return bare.success ? visibleActive(bare.data) : body;
  };

  const registerRoutes = (app: Application) => {
    app.post<unknown, { sessionID: string }>('/api/session/:sessionID/compact', async (req, res, next) => {
      const { sessionID } = req.params;
      await mark(sessionID);
      if (req.destroyed) {
        unmark(sessionID);
        return;
      }
      res.on('close', () => {
        if (!res.writableFinished || res.statusCode >= 400) unmark(sessionID);
      });
      next();
    });
    app.get('/api/session/active', (_req, res, next) => {
      const send = res.json.bind(res);
      res.json = (body) => send(filterActive(body));
      next();
    });
  };

  const reset = () => {
    running.clear();
    pending.clear();
  };

  return { mark, unmark, admit, isQuiet, filterActive, registerRoutes, reset };
};

export type QuietCompaction = ReturnType<typeof createQuietCompaction>;
