/**
 * "In work": Jev moves a session into work when real work starts in it, and
 * says when a turn looks like the end of that work, or handed over changes
 * worth a look. The user closes; this runtime never does. See
 * DOCUMENTATION.md.
 *
 * Two moments ask Jev:
 * - a user message was sent (`message.updated`, role user): only while the
 *   session is not in work, so an open session costs no call here;
 * - a turn ended: session assist calls `evaluateTurnEnd` before it arms its
 *   quiet window, and one call answers both this runtime's questions and
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
import { loadAssistContext, loadSettledTurns } from '../session-assist/context.js';
import { turnsToHistory, excerptHead, excerptHeadTail } from '../routing/history.js';
import {
  buildSendRequest,
  buildTurnEndRequest,
  decideAssist,
  decideOpen,
  decideReviewReady,
  decideWrapUp,
} from './questions.js';
import { clearSuggestionPatch, offerReviewPatch, openByJevPatch, readWork, suggestDonePatch } from './state.js';

const OPENCHAMBER_SETTINGS_FILE = path.join(
  process.env.OPENCHAMBER_DATA_DIR
    ? path.resolve(process.env.OPENCHAMBER_DATA_DIR)
    : path.join(os.homedir(), '.config', 'openchamber'),
  'settings.json',
);

/** In work and auto-open default on, the review offer off; read at every use so a change applies without a restart. */
const readSessionWorkSettings = () => {
  const settings = readMergedSettingsSync({ fs, path, settingsFilePath: OPENCHAMBER_SETTINGS_FILE });
  return {
    enabled: settings.sessionWorkEnabled !== false,
    autoOpen: settings.sessionWorkAutoOpen !== false,
    reviewOffer: settings.sessionReviewOfferEnabled === true,
  };
};

const READ_TIMEOUT_MS = 5_000;
const REQUEST_CHARS = 1_500;
/** Head and tail of the turn's answer: what was changed sits early, the outcome late. */
const ANSWER_EDGE_CHARS = 500;
const SEEN_MESSAGES_LIMIT = 500;

const errorMessage = (error) => (error instanceof Error ? error.message : String(error));

const userMessageSchema = z.object({
  type: z.literal('message.updated'),
  properties: z.object({
    sessionID: z.string().min(1),
    info: z.object({
      id: z.string().min(1),
      role: z.literal('user'),
      text: z.string(),
      time: z.object({ created: z.number() }).partial().optional(),
    }),
  }),
});

const busySchema = z.object({
  type: z.literal('session.status'),
  properties: z.object({ sessionID: z.string().min(1), status: z.object({ type: z.literal('busy') }) }),
});

const reviewSessionSchema = z.object({ openchamber: z.object({ kind: z.literal('review') }) });

export function createSessionWorkRuntime({
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  /** `{ enabled, autoOpen, reviewOffer }` as currently saved. */
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
}) {
  const resolvedChatRoots = chatRoots.filter(Boolean).map((root) => path.resolve(root));
  const isChatDirectory = (directory) => {
    if (!directory) return false;
    const resolved = path.resolve(directory);
    return resolvedChatRoots.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`));
  };
  let stopped = false;
  const seenMessages = new Set();
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
   * The session record when it is one this feature serves: a top-level,
   * unarchived project session that is not a review of another one. Chats
   * are plain conversations and never in work. Null otherwise.
   */
  const eligibleSession = async (client, sessionId, signal) => {
    const session = await client.session.get({ sessionID: sessionId }, { signal });
    if (session?.id === sessionId) lineage?.remember(sessionId, session.parentID ?? null);
    if (session?.id !== sessionId || session.parentID) return null;
    if (isChatDirectory(session.location?.directory ?? session.directory)) return null;
    if (reviewSessionSchema.safeParse(session.metadata).success) return null;
    if (await isSessionArchived(sessionId)) return null;
    return session;
  };

  const markSuggested = (sessionId, directory) => {
    suggested.delete(sessionId);
    suggested.set(sessionId, directory);
    while (suggested.size > SEEN_MESSAGES_LIMIT) suggested.delete(suggested.keys().next().value);
  };

  const onUserMessage = async ({ sessionId, directory, messageId, text, createdAt }) => {
    const settings = getSettings();
    if (!settings.enabled || !settings.autoOpen || !text.trim()) return;
    if (seenMessages.has(messageId)) return;
    seenMessages.add(messageId);
    while (seenMessages.size > SEEN_MESSAGES_LIMIT) seenMessages.delete(seenMessages.values().next().value);

    const endpoint = await classifierEndpoint();
    if (!endpoint) return;
    const signal = AbortSignal.timeout(READ_TIMEOUT_MS);
    const client = openCodeClient(directory);
    const session = await eligibleSession(client, sessionId, signal);
    if (!session) return;
    if (readWork(await readMetadata(sessionId, directory))?.state === 'open') return;

    const turns = await loadSettledTurns({ readPage: readPages(client, sessionId, signal), signal });
    const { answers } = await jev.ask(
      buildSendRequest({ history: turnsToHistory(turns), request: excerptHead(text.trim(), REQUEST_CHARS) }),
      endpoint,
    );
    if (stopped || !decideOpen(answers)) return;
    await updateMetadata(sessionId, (metadata) => openByJevPatch(metadata, { requestAt: createdAt, now: now() }), { directory });
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
    const message = userMessageSchema.safeParse(payload);
    if (!message.success) return;
    const { sessionID, info } = message.data.properties;
    // A subsession is never in work: no read, no Jev.
    if (lineage?.isChild(sessionID) === true) return;
    if (!seenMessages.has(info.id)) advanceTurn(sessionID);
    const directory = payload.properties?.directory || directoryHint;
    void onUserMessage({
      sessionId: sessionID,
      directory,
      messageId: info.id,
      text: info.text,
      createdAt: info.time?.created ?? now(),
    }).catch((error) => console.warn('[session-work] could not check a sent message:', errorMessage(error)));
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
        open: settings.enabled && settings.autoOpen && work?.state !== 'open',
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
      if (ask.open && decideOpen(answers)) {
        const requestAt = turn.user.created ?? now();
        await updateMetadata(sessionId, (metadata) => openByJevPatch(metadata, { requestAt, now: now() }), { directory });
      }
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
    suggested.clear();
    turnGenerations.clear();
  };

  return { processPayload, evaluateTurnEnd, stop };
}
