/**
 * "In work": a session goes into work when the user sends a message in it,
 * and Jev says when a turn looks like the end of that work, or handed over
 * changes worth a look. The user closes; this runtime never does. See
 * DOCUMENTATION.md.
 *
 * - A user message was sent (`message.updated`, role user): the session opens,
 *   or reopens if the user closed it before sending. No Jev. A shell command
 *   the user ran (`session.shell.started`) does the same. An open that failed
 *   is retried a bounded number of times, and one for a session archived at
 *   the time waits for `session.unarchived`.
 * - A turn ended: session assist calls `evaluateTurnEnd` before it arms its
 *   quiet window, and one Jev call answers both this runtime's questions and
 *   whether the Small Model is worth waking.
 *
 * Every failure leaves things as they were: nothing opens, no hint appears,
 * and session assist behaves as it did without Jev.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { OpenCode } from '@opencode/client';
import { z } from 'zod';
import { readMergedSettingsSync } from '../opencode/settings-files.js';
import { loadAssistContext } from '../session-assist/context.js';
import { turnsToHistory, excerptHead, excerptHeadTail } from '../routing/history.js';
import { buildTurnEndRequest, decideAssist, decideReviewReady, decideWrapUp } from './questions.js';
import { clearSuggestionPatch, offerReviewPatch, openPatch, readWork, suggestDonePatch } from './state.js';

const OPENCHAMBER_SETTINGS_FILE = path.join(
  process.env.OPENCHAMBER_DATA_DIR
    ? path.resolve(process.env.OPENCHAMBER_DATA_DIR)
    : path.join(os.homedir(), '.config', 'openchamber'),
  'settings.json',
);

/** In work defaults on, the review offer off; read at every use so a change applies without a restart. */
const readSessionWorkSettings = () => {
  const settings = readMergedSettingsSync({ fs, path, settingsFilePath: OPENCHAMBER_SETTINGS_FILE });
  return {
    enabled: settings.sessionWorkEnabled !== false,
    reviewOffer: settings.sessionReviewOfferEnabled === true,
  };
};

const READ_TIMEOUT_MS = 5_000;
const REQUEST_CHARS = 1_500;
/** Head and tail of the turn's answer: what was changed sits early, the outcome late. */
const ANSWER_EDGE_CHARS = 500;
const SEEN_MESSAGES_LIMIT = 500;
/** Waits before each new try at an open that failed; after the last one it gives up. */
const OPEN_RETRY_DELAYS_MS = [2_000, 10_000, 60_000];

const errorMessage = (error) => (error instanceof Error ? error.message : String(error));

const userMessageSchema = z.object({
  type: z.literal('message.updated'),
  properties: z.object({
    sessionID: z.string().min(1),
    info: z.object({
      id: z.string().min(1),
      role: z.literal('user'),
      time: z.object({ created: z.number() }).partial().optional(),
    }),
  }),
});

/** A shell command the user ran from the composer; only the user starts one. */
const shellSchema = z.object({
  type: z.literal('session.shell.started'),
  id: z.string().min(1),
  created: z.number(),
  properties: z.object({ sessionID: z.string().min(1) }),
});

/** OpenCode restored an archived session (`event-stream/translate-v2.js`). */
const unarchivedSchema = z.object({
  type: z.literal('session.unarchived'),
  properties: z.object({ sessionID: z.string().min(1) }),
});

const busySchema = z.object({
  type: z.literal('session.status'),
  properties: z.object({ sessionID: z.string().min(1), status: z.object({ type: z.literal('busy') }) }),
});

/**
 * Sessions that are not the user's own work: a review of another session, a
 * `/btw` side question forked off one, a run of a scheduled task.
 */
const notWorkSessionSchema = z.object({ openchamber: z.object({ kind: z.enum(['review', 'btw', 'scheduled']) }) });

export function createSessionWorkRuntime({
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  /** `{ enabled, reviewOffer }` as currently saved. */
  getSettings = readSessionWorkSettings,
  /** The classification provider's endpoint, or null when there is no Jev. */
  classifierEndpoint,
  jev,
  readMetadata,
  /** `(sessionID, decide, { directory }) => { metadata, changed }`, decided against the record at write time. */
  updateMetadata,
  isSessionArchived = async () => false,
  /** Roots of managed Chats: plain conversations, never work. */
  chatRoots = [],
  /** `../session-lineage.js`: known subsessions are skipped without reading them. */
  lineage = null,
  now = Date.now,
  openRetryDelaysMs = OPEN_RETRY_DELAYS_MS,
}) {
  const resolvedChatRoots = chatRoots.filter(Boolean).map((root) => path.resolve(root));
  const isChatDirectory = (directory) => {
    if (!directory) return false;
    const resolved = path.resolve(directory);
    return resolvedChatRoots.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`));
  };
  let stopped = false;
  // Messages already taken: each starts its turn and its open once, however
  // often the stream delivers it.
  const seenMessages = new Set();
  // An open a sent message still owes, at most one per session: the newest
  // message's. A failed try waits on a timer, a session archived at the time
  // waits for its restore. Neither starts another turn.
  const pendingOpens = new Map();
  // Sessions where this process wrote a hint, so a new turn can retire it
  // without reading every session's metadata at every turn start.
  const suggested = new Map();
  // A turn counter per session, moved by every turn start and every new user
  // message. A turn-end check captures it before asking Jev and writes the
  // hint only if no newer turn began in the meantime: a late answer about
  // the previous turn must not land on the next one.
  // Values come from one process-wide counter, so they never repeat: a session
  // evicted from the bounded map reads 0, which no pending check captured
  // after a turn start, and its late answer is dropped rather than accepted.
  const turnGenerations = new Map();
  let lastTurnGeneration = 0;
  const turnGeneration = (sessionId) => turnGenerations.get(sessionId) ?? 0;
  const advanceTurn = (sessionId) => {
    lastTurnGeneration += 1;
    turnGenerations.delete(sessionId);
    turnGenerations.set(sessionId, lastTurnGeneration);
    while (turnGenerations.size > SEEN_MESSAGES_LIMIT) turnGenerations.delete(turnGenerations.keys().next().value);
  };

  const openCodeClient = (directory) => {
    const headers = { ...getOpenCodeAuthHeaders() };
    // v2 scopes by header and rejects non-ASCII header values.
    if (directory) headers['x-opencode-directory'] = encodeURIComponent(directory);
    return OpenCode.make({ baseUrl: buildOpenCodeUrl('/', '').replace(/\/$/, ''), headers });
  };

  const readPages = (client, sessionId, signal) => ({ limit, cursor }) => client.message.list(
    { sessionID: sessionId, limit, ...(cursor ? { cursor } : { order: 'desc' }) },
    { signal },
  );

  /**
   * The session record when it is one this feature serves, archived or not: a
   * top-level project session that is not a review, a `/btw` side question or
   * a scheduled task's run. Chats are plain conversations and never in work.
   * Null otherwise.
   */
  const workSession = async (client, sessionId, signal) => {
    const session = await client.session.get({ sessionID: sessionId }, { signal });
    if (session?.id === sessionId) lineage?.remember(sessionId, session.parentID ?? null);
    if (session?.id !== sessionId || session.parentID) return null;
    if (isChatDirectory(session.location?.directory ?? session.directory)) return null;
    if (notWorkSessionSchema.safeParse(session.metadata).success) return null;
    return session;
  };

  /** `workSession`, and only while it is not archived. */
  const eligibleSession = async (client, sessionId, signal) => {
    const session = await workSession(client, sessionId, signal);
    return session && !(await isSessionArchived(sessionId)) ? session : null;
  };

  const markSuggested = (sessionId, directory) => {
    suggested.delete(sessionId);
    suggested.set(sessionId, directory);
    while (suggested.size > SEEN_MESSAGES_LIMIT) suggested.delete(suggested.keys().next().value);
  };

  /** True the first time a message id is seen. */
  const takeMessage = (messageId) => {
    if (seenMessages.has(messageId)) return false;
    seenMessages.add(messageId);
    while (seenMessages.size > SEEN_MESSAGES_LIMIT) seenMessages.delete(seenMessages.values().next().value);
    return true;
  };

  /**
   * One try at the open a message owes. `archived` when the session has to be
   * restored first, `settled` when nothing more is owed: it opened, was
   * already open, the user closed it after the message, it can never be in
   * work, or In work is off. Throws when a read or the write failed.
   */
  const tryOpen = async ({ sessionId, directory, createdAt }) => {
    if (stopped || !getSettings().enabled) return 'settled';
    // A session already in work costs no read of OpenCode.
    if (readWork(await readMetadata(sessionId, directory))?.state === 'open') return 'settled';
    const session = await workSession(openCodeClient(directory), sessionId, AbortSignal.timeout(READ_TIMEOUT_MS));
    if (!session) return 'settled';
    if (await isSessionArchived(sessionId)) return 'archived';
    if (stopped) return 'settled';
    await updateMetadata(sessionId, (metadata) => openPatch(metadata, { requestAt: createdAt, now: now() }), { directory });
    return 'settled';
  };

  const dropPending = (pending) => {
    clearTimeout(pending.timer);
    if (pendingOpens.get(pending.sessionId) === pending) pendingOpens.delete(pending.sessionId);
  };

  const attemptOpen = async (pending) => {
    pending.timer = null;
    pending.restored = false;
    pending.inFlight = true;
    let outcome;
    try {
      outcome = await tryOpen(pending);
    } catch (error) {
      outcome = error;
    }
    pending.inFlight = false;
    // A newer message for the session took over.
    if (pendingOpens.get(pending.sessionId) !== pending) return;
    if (outcome === 'settled') {
      dropPending(pending);
      return;
    }
    if (outcome === 'archived') {
      // The restore landed while this try still read the session as archived.
      if (pending.restored) void attemptOpen(pending);
      return;
    }
    // A session OpenCode no longer has will not come back.
    const gone = outcome?._tag === 'SessionNotFoundError';
    if (gone || pending.failures >= openRetryDelaysMs.length) {
      dropPending(pending);
      console.warn('[session-work] gave up opening a session for a sent message:', errorMessage(outcome));
      return;
    }
    const delay = openRetryDelaysMs[pending.failures];
    pending.failures += 1;
    pending.timer = setTimeout(() => void attemptOpen(pending), delay);
    pending.timer.unref?.();
  };

  // Any sent message counts: one with only files or attached context has empty
  // text. A shell command from the composer counts as one too.
  const onUserMessage = ({ sessionId, directory, createdAt }) => {
    if (!getSettings().enabled) return;
    const previous = pendingOpens.get(sessionId);
    if (previous) dropPending(previous);
    const pending = { sessionId, directory, createdAt, failures: 0, timer: null, inFlight: false, restored: false };
    pendingOpens.set(sessionId, pending);
    while (pendingOpens.size > SEEN_MESSAGES_LIMIT) dropPending(pendingOpens.values().next().value);
    void attemptOpen(pending);
  };

  const onSessionRestored = (sessionId) => {
    const pending = pendingOpens.get(sessionId);
    if (!pending || pending.timer) return;
    if (pending.inFlight) pending.restored = true;
    else void attemptOpen(pending);
  };

  const retireSuggestion = (sessionId) => {
    if (!suggested.has(sessionId)) return;
    const directory = suggested.get(sessionId);
    suggested.delete(sessionId);
    Promise.resolve(updateMetadata(sessionId, clearSuggestionPatch, { directory }))
      .catch((error) => console.warn('[session-work] could not retire a hint:', errorMessage(error)));
  };

  const processPayload = (payload, directoryHint = '') => {
    if (stopped) return;
    const busy = busySchema.safeParse(payload);
    if (busy.success) {
      advanceTurn(busy.data.properties.sessionID);
      retireSuggestion(busy.data.properties.sessionID);
      return;
    }
    const unarchived = unarchivedSchema.safeParse(payload);
    if (unarchived.success) {
      onSessionRestored(unarchived.data.properties.sessionID);
      return;
    }
    const shell = shellSchema.safeParse(payload);
    if (shell.success) {
      const { sessionID } = shell.data.properties;
      if (lineage?.isChild(sessionID) === true || !takeMessage(shell.data.id)) return;
      onUserMessage({
        sessionId: sessionID,
        directory: payload.properties?.directory || directoryHint,
        createdAt: shell.data.created,
      });
      return;
    }
    const message = userMessageSchema.safeParse(payload);
    if (!message.success) return;
    const { sessionID, info } = message.data.properties;
    // A subsession is never in work: nothing to read.
    if (lineage?.isChild(sessionID) === true || !takeMessage(info.id)) return;
    advanceTurn(sessionID);
    onUserMessage({
      sessionId: sessionID,
      directory: payload.properties?.directory || directoryHint,
      createdAt: info.time?.created ?? now(),
    });
  };

  /**
   * One Jev call when a turn ended. `assist` says which assist fields the user
   * has on. Resolves which of them are worth the Small Model, or null when Jev
   * was not asked about them (no Jev, a failure, an ineligible session): the
   * caller then behaves as it always did.
   */
  const evaluateTurnEnd = async ({ sessionId, directory, assist }) => {
    if (stopped || lineage?.isChild(sessionId) === true) return null;
    const settings = getSettings();
    if (!settings.enabled && !settings.reviewOffer && !assist.recap && !assist.suggestion) return null;
    // Never capture 0: an evicted session also reads 0.
    if (!turnGenerations.has(sessionId)) advanceTurn(sessionId);
    const generation = turnGeneration(sessionId);
    try {
      const endpoint = await classifierEndpoint();
      if (!endpoint) return null;
      const signal = AbortSignal.timeout(READ_TIMEOUT_MS);
      const client = openCodeClient(directory);
      const session = await eligibleSession(client, sessionId, signal);
      if (!session || session.revert?.messageID) return null;
      const work = settings.enabled ? readWork(await readMetadata(sessionId, directory)) : null;
      const ask = {
        wrapUp: settings.enabled && work?.state === 'open',
        reviewReady: settings.reviewOffer,
        recap: assist.recap,
        nextStep: assist.suggestion,
      };
      const context = await loadAssistContext({ readPage: readPages(client, sessionId, signal), signal });
      if (!context) return null;
      const turn = context.turns.at(-1);
      const request = buildTurnEndRequest({
        history: turnsToHistory(context.turns.slice(0, -1)),
        request: excerptHead(turn.user.text, REQUEST_CHARS),
        answer: excerptHeadTail(turn.assistant.text, ANSWER_EDGE_CHARS, ANSWER_EDGE_CHARS),
        ask,
      });
      if (!request) return null;
      const { answers } = await jev.ask(request, endpoint);
      if (stopped) return null;
      // Looks done wins over a review offer from the same turn.
      const suggest = ask.wrapUp && decideWrapUp(answers)
        ? suggestDonePatch
        : ask.reviewReady && decideReviewReady(answers) ? offerReviewPatch : null;
      if (suggest) {
        // Decided at write time: a turn that started while Jev was answering
        // makes this answer about an older turn.
        const { changed } = await updateMetadata(
          sessionId,
          (metadata) => (turnGeneration(sessionId) === generation ? suggest(metadata, { now: now() }) : null),
          { directory },
        );
        if (changed) markSuggested(sessionId, directory);
      }
      return ask.recap || ask.nextStep ? decideAssist(answers) : null;
    } catch (error) {
      console.warn('[session-work] turn-end check failed:', errorMessage(error));
      return null;
    }
  };

  const stop = () => {
    stopped = true;
    seenMessages.clear();
    for (const pending of pendingOpens.values()) clearTimeout(pending.timer);
    pendingOpens.clear();
    suggested.clear();
    turnGenerations.clear();
  };

  return { processPayload, evaluateTurnEnd, stop };
}
