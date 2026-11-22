/**
 * "In work": how a session goes into work is the user's choice
 * (`sessionWorkEntry`): only by Track, on every sent message, or when Jev
 * says real work started. Jev also says when a turn looks like the end of
 * that work, or handed over changes worth a look. The user closes; this
 * runtime never does. See DOCUMENTATION.md.
 *
 * - A user message was sent (`message.updated`, role user): with every
 *   message, the session opens, or reopens if the user closed it before
 *   sending; a shell command the user ran (`session.shell.started`) does the
 *   same. With Jev deciding, Jev reads the message first.
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
import { readMergedSettingsSync } from '../settings/settings-files.js';
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
import { resolveSessionWorkEntry } from './settings.js';
import { clearSuggestionPatch, offerReviewPatch, openPatch, readWork, suggestDonePatch } from './state.js';
import { createWorkMembership } from './membership.js';
import { sessionParentId } from '../session-lineage.js';
import type { createSessionLineage } from '../session-lineage.js';
import type { SessionActivityProbe, RunningSessionJob } from '../opencode/session-activity.js';
import type { ClassifierEndpoint } from '../routing/classifier.js';
import type { createJevClient } from '../routing/jev.js';
import type { AssistTargets } from '../session-assist/contracts.js';
import type { WorkMetadataPatch } from './state.js';
import type { SessionMetadata } from '../openchamber-sessions/session-metadata-store.js';

type Client = ReturnType<typeof OpenCode.make>;
type Session = Awaited<ReturnType<Client['session']['get']>> & { directory?: string };

export interface SessionWorkOptions {
  buildOpenCodeUrl: (route: string, query: string) => string;
  getOpenCodeAuthHeaders: () => Record<string, string>;
  // `entry` is how sessions go into work (settings.js): off, every-message or jev.
  getSettings?: () => { enabled: boolean; reviewOffer: boolean; entry?: string };
  classifierEndpoint: () => Promise<ClassifierEndpoint | null>;
  jev: Pick<ReturnType<typeof createJevClient>, 'ask'>;
  readMetadata: (sessionId: string, directory: string) => Promise<SessionMetadata | null | undefined>;
  updateMetadata: (
    sessionId: string,
    decide: (metadata: SessionMetadata | null | undefined) => WorkMetadataPatch | null,
    options: { directory: string | undefined },
  ) => Promise<{ changed: boolean }>;
  isSessionArchived?: (sessionId: string) => Promise<boolean>;
  isWorktreePinned?: (directory: string) => Promise<boolean>;
  chatRoots?: string[];
  lineage?: Pick<ReturnType<typeof createSessionLineage>, 'remember' | 'isChild'> | null;
  activityProbe?: SessionActivityProbe | null;
  now?: () => number;
  openRetryDelaysMs?: number[];
  doneHintDelayMs?: number;
}

interface OpenRequest {
  sessionId: string;
  directory: string;
  createdAt: number;
}

interface PendingOpen extends OpenRequest {
  text?: string;
  failures: number;
  timer: ReturnType<typeof setTimeout> | null;
  inFlight: boolean;
  restored: boolean;
}

interface HintRequest {
  sessionId: string;
  directory: string;
  generation: number;
}

export interface WorkEvent {
  properties?: { directory?: string | undefined };
}

export interface TurnEndInput {
  sessionId: string;
  directory: string;
  assist: AssistTargets;
}

const isSessionNotFound = (error: unknown): error is { _tag: 'SessionNotFoundError' } =>
  error != null && (typeof error === 'object' || typeof error === 'function')
  && '_tag' in error && error._tag === 'SessionNotFoundError';

const OPENCHAMBER_SETTINGS_FILE = path.join(
  process.env.OPENCHAMBER_DATA_DIR
    ? path.resolve(process.env.OPENCHAMBER_DATA_DIR)
    : path.join(os.homedir(), '.config', 'openchamber'),
  'settings.json',
);

/** In work defaults on, entry off, the review offer off; read at every use so a change applies without a restart. */
const readSessionWorkSettings = () => {
  const settings = readMergedSettingsSync({ fs, path, settingsFilePath: OPENCHAMBER_SETTINGS_FILE });
  return {
    enabled: settings.sessionWorkEnabled !== false,
    entry: resolveSessionWorkEntry(settings),
    reviewOffer: settings.sessionReviewOfferEnabled === true,
  };
};

const READ_TIMEOUT_MS = 5_000;
const REQUEST_CHARS = 1_500;
const ANSWER_EDGE_CHARS = 500;
const SEEN_MESSAGES_LIMIT = 500;
const OPEN_RETRY_DELAYS_MS = [2_000, 10_000, 60_000];
const DONE_HINT_DELAY_MS = 10 * 60_000;
const BACKGROUND_SHELL_WAIT_MS = 30 * 60_000;

const userMessageSchema = z.object({
  type: z.literal('message.updated'),
  properties: z.object({
    sessionID: z.string().min(1),
    info: z.object({
      id: z.string().min(1),
      role: z.literal('user'),
      text: z.string().optional(),
      time: z.object({ created: z.number() }).partial().optional(),
    }),
  }),
});

const shellSchema = z.object({
  type: z.literal('session.shell.started'),
  id: z.string().min(1),
  created: z.number(),
  properties: z.object({ sessionID: z.string().min(1) }),
});

const unarchivedSchema = z.object({
  type: z.literal('session.unarchived'),
  properties: z.object({ sessionID: z.string().min(1) }),
});

const busySchema = z.object({
  type: z.literal('session.status'),
  properties: z.object({ sessionID: z.string().min(1), status: z.object({ type: z.literal('busy') }) }),
});

export function createSessionWorkRuntime({
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  /** `{ enabled, entry, reviewOffer }` as currently saved; `entry` is `off`, `every-message` or `jev`. */
  getSettings = readSessionWorkSettings,
  classifierEndpoint,
  jev,
  readMetadata,
  updateMetadata,
  isSessionArchived = async () => false,
  isWorktreePinned = async () => false,
  chatRoots = [],
  lineage = null,
  activityProbe = null,
  now = Date.now,
  openRetryDelaysMs = OPEN_RETRY_DELAYS_MS,
  doneHintDelayMs = DONE_HINT_DELAY_MS,
}: SessionWorkOptions) {
  const { canBeInWork } = createWorkMembership({ chatRoots });
  let stopped = false;
  const seenMessages = new Set<string>();
  const pendingOpens = new Map<string, PendingOpen>();
  const suggested = new Map<string, string>();
  const turnGenerations = new Map<string, number>();
  let lastTurnGeneration = 0;
  const pendingDoneHints = new Map<string, ReturnType<typeof setTimeout>>();
  const cancelDoneHint = (sessionId: string) => {
    clearTimeout(pendingDoneHints.get(sessionId));
    pendingDoneHints.delete(sessionId);
  };
  const turnGeneration = (sessionId: string) => turnGenerations.get(sessionId) ?? 0;
  const advanceTurn = (sessionId: string) => {
    cancelDoneHint(sessionId);
    lastTurnGeneration += 1;
    turnGenerations.delete(sessionId);
    turnGenerations.set(sessionId, lastTurnGeneration);
    while (turnGenerations.size > SEEN_MESSAGES_LIMIT) {
      const oldest = turnGenerations.keys().next();
      if (!oldest.done) turnGenerations.delete(oldest.value);
    }
  };

  const openCodeClient = (directory: string) => {
    const headers = { ...getOpenCodeAuthHeaders() };
    if (directory) headers['x-opencode-directory'] = encodeURIComponent(directory);
    return OpenCode.make({ baseUrl: buildOpenCodeUrl('/', '').replace(/\/$/, ''), headers });
  };

  const readPages = (client: Client, sessionId: string, signal: AbortSignal) => ({ limit, cursor }: { limit: number; cursor: string | undefined }) => client.message.list(
    { sessionID: sessionId, limit, ...(cursor ? { cursor } : { order: 'desc' }) },
    { signal },
  );

  const workSession = async (client: Client, sessionId: string, signal: AbortSignal) => {
    const session: Session = await client.session.get({ sessionID: sessionId }, { signal });
    if (session?.id === sessionId) lineage?.remember(sessionId, sessionParentId(session));
    return session?.id === sessionId && canBeInWork(session) ? session : null;
  };

  const eligibleSession = async (client: Client, sessionId: string, signal: AbortSignal) => {
    const session = await workSession(client, sessionId, signal);
    return session && !(await isSessionArchived(sessionId)) ? session : null;
  };

  const markSuggested = (sessionId: string, directory: string) => {
    suggested.delete(sessionId);
    suggested.set(sessionId, directory);
    while (suggested.size > SEEN_MESSAGES_LIMIT) {
      const oldest = suggested.keys().next();
      if (!oldest.done) suggested.delete(oldest.value);
    }
  };

  const takeMessage = (messageId: string) => {
    if (seenMessages.has(messageId)) return false;
    seenMessages.add(messageId);
    while (seenMessages.size > SEEN_MESSAGES_LIMIT) {
      const oldest = seenMessages.values().next();
      if (!oldest.done) seenMessages.delete(oldest.value);
    }
    return true;
  };

  const tryOpen = async ({ sessionId, directory, createdAt, text = '' }: OpenRequest & { text?: string }) => {
    const { enabled, entry } = getSettings();
    if (stopped || !enabled || entry === 'off') return 'settled';
    // Jev judges words, so it reads only messages with text.
    if (entry === 'jev' && !text.trim()) return 'settled';
    // A session already in work costs no read of OpenCode and no Jev call.
    if (readWork(await readMetadata(sessionId, directory))?.state === 'open') return 'settled';
    // Without a classification provider Jev cannot decide: settle before
    // reading anything from OpenCode.
    const endpoint = entry === 'jev' ? await classifierEndpoint() : null;
    if (entry === 'jev' && !endpoint) return 'settled';
    const signal = AbortSignal.timeout(READ_TIMEOUT_MS);
    const client = openCodeClient(directory);
    const session = await workSession(client, sessionId, signal);
    if (!session) return 'settled';
    if (await isWorktreePinned(session.location?.directory ?? session.directory ?? directory)) return 'settled';
    if (await isSessionArchived(sessionId)) return 'archived';
    if (stopped) return 'settled';
    let by: 'auto' | 'jev' = 'auto';
    if (entry === 'jev' && endpoint) {
      const turns = await loadSettledTurns({ readPage: readPages(client, sessionId, signal), signal });
      const { answers } = await jev.ask(
        buildSendRequest({ history: turnsToHistory(turns), request: excerptHead(text.trim(), REQUEST_CHARS) }),
        endpoint,
      );
      if (stopped || !decideOpen(answers)) return 'settled';
      by = 'jev';
    }
    await updateMetadata(sessionId, (metadata) => openPatch(metadata, { requestAt: createdAt, now: now(), by }), { directory });
    return 'settled';
  };

  const dropPending = (pending: PendingOpen) => {
    clearTimeout(pending.timer ?? undefined);
    if (pendingOpens.get(pending.sessionId) === pending) pendingOpens.delete(pending.sessionId);
  };

  const attemptOpen = async (pending: PendingOpen) => {
    pending.timer = null;
    pending.restored = false;
    pending.inFlight = true;
    let outcome: unknown;
    try {
      outcome = await tryOpen(pending);
    } catch (error) {
      outcome = error;
    }
    pending.inFlight = false;
    if (pendingOpens.get(pending.sessionId) !== pending) return;
    if (outcome === 'settled') {
      dropPending(pending);
      return;
    }
    if (outcome === 'archived') {
      if (pending.restored) void attemptOpen(pending);
      return;
    }
    const gone = isSessionNotFound(outcome);
    if (gone || pending.failures >= openRetryDelaysMs.length) {
      dropPending(pending);
      console.warn('[session-work] gave up opening a session for a sent message:', outcome instanceof Error ? outcome.message : String(outcome));
      return;
    }
    const delay = openRetryDelaysMs[pending.failures];
    pending.failures += 1;
    pending.timer = setTimeout(() => void attemptOpen(pending), delay);
    pending.timer.unref?.();
  };

  const onUserMessage = ({ sessionId, directory, createdAt, text = '' }: OpenRequest & { text?: string }) => {
    const { enabled, entry } = getSettings();
    if (!enabled || entry === 'off') return;
    if (entry === 'jev' && !text.trim()) return;
    const previous = pendingOpens.get(sessionId);
    if (previous) dropPending(previous);
    const pending: PendingOpen = { sessionId, directory, createdAt, text, failures: 0, timer: null, inFlight: false, restored: false };
    pendingOpens.set(sessionId, pending);
    while (pendingOpens.size > SEEN_MESSAGES_LIMIT) {
      const oldest = pendingOpens.values().next();
      if (!oldest.done) dropPending(oldest.value);
    }
    void attemptOpen(pending);
  };

  const onSessionRestored = (sessionId: string) => {
    const pending = pendingOpens.get(sessionId);
    if (!pending || pending.timer) return;
    if (pending.inFlight) pending.restored = true;
    else void attemptOpen(pending);
  };

  const retireSuggestion = (sessionId: string) => {
    if (!suggested.has(sessionId)) return;
    const directory = suggested.get(sessionId);
    suggested.delete(sessionId);
    Promise.resolve(updateMetadata(sessionId, clearSuggestionPatch, { directory }))
      .catch((error) => console.warn('[session-work] could not retire a hint:', error instanceof Error ? error.message : String(error)));
  };

  const processPayload = (payload: WorkEvent, directoryHint = '') => {
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
        text: '',
        createdAt: shell.data.created,
      });
      return;
    }
    const message = userMessageSchema.safeParse(payload);
    if (!message.success) return;
    const { sessionID, info } = message.data.properties;
    if (lineage?.isChild(sessionID) === true || !takeMessage(info.id)) return;
    advanceTurn(sessionID);
    onUserMessage({
      sessionId: sessionID,
      directory: payload.properties?.directory || directoryHint,
      text: info.text ?? '',
      createdAt: info.time?.created ?? now(),
    });
  };

  const writeHint = async ({ sessionId, directory, generation, patch }: HintRequest & { patch: typeof suggestDonePatch }) => {
    const { changed } = await updateMetadata(
      sessionId,
      (metadata) => (turnGeneration(sessionId) === generation ? patch(metadata, { now: now() }) : null),
      { directory },
    );
    if (changed) markSuggested(sessionId, directory);
  };

  const scheduleDoneHint = ({ sessionId, directory, generation }: HintRequest) => {
    if (turnGeneration(sessionId) !== generation) return;
    cancelDoneHint(sessionId);
    const timer = setTimeout(() => {
      pendingDoneHints.delete(sessionId);
      if (stopped) return;
      writeHint({ sessionId, directory, generation, patch: suggestDonePatch })
        .catch((error) => console.warn('[session-work] could not write a done hint:', error instanceof Error ? error.message : String(error)));
    }, doneHintDelayMs);
    timer.unref?.();
    pendingDoneHints.set(sessionId, timer);
  };

  const waitsOnBackground = async (sessionId: string, turnStartedAt: number) => {
    if (!activityProbe) return null;
    const jobs = await activityProbe.fetchRunningBackgroundJobs(sessionId);
    const waitedOn = (job: RunningSessionJob) => job.kind !== 'shell'
      || (job.startedAt >= turnStartedAt && now() - job.startedAt < BACKGROUND_SHELL_WAIT_MS);
    if (jobs?.some(waitedOn)) return true;
    const statuses = await activityProbe.fetchActiveSessionStatuses();
    const children = statuses ? await activityProbe.hasWorkingChildren(sessionId, statuses) : null;
    if (children === true) return true;
    return Array.isArray(jobs) && children === false ? false : null;
  };

  const evaluateTurnEnd = async ({ sessionId, directory, assist }: TurnEndInput) => {
    if (stopped || lineage?.isChild(sessionId) === true) return null;
    const settings = getSettings();
    if (!settings.enabled && !settings.reviewOffer && !assist.recap && !assist.suggestion) return null;
    if (!turnGenerations.has(sessionId)) advanceTurn(sessionId);
    const generation = turnGeneration(sessionId);
    let background = null;
    try {
      const endpoint = await classifierEndpoint();
      if (!endpoint) return null;
      const signal = AbortSignal.timeout(READ_TIMEOUT_MS);
      const client = openCodeClient(directory);
      const session = await eligibleSession(client, sessionId, signal);
      if (!session || session.revert?.messageID) return null;
      const work = settings.enabled ? readWork(await readMetadata(sessionId, directory)) : null;
      const context = await loadAssistContext({ readPage: readPages(client, sessionId, signal), signal });
      if (!context) return null;
      const turn = context.turns.at(-1);
      const changedFiles = turn.changedFiles ? turn.changedFiles.size > 0 : null;
      const ask = {
        open: settings.enabled && settings.entry === 'jev' && work?.state !== 'open',
        wrapUp: settings.enabled && work?.state === 'open',
        reviewReady: settings.reviewOffer && changedFiles !== false,
        recap: assist.recap,
        nextStep: assist.suggestion,
      };
      background = ask.wrapUp || ask.nextStep ? await waitsOnBackground(sessionId, turn.user.created ?? 0) : null;
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
        await updateMetadata(sessionId, (metadata) => openPatch(metadata, { requestAt, now: now(), by: 'jev' }), { directory });
      }
      if (ask.reviewReady && decideReviewReady(answers)) {
        await writeHint({ sessionId, directory, generation, patch: offerReviewPatch });
      }
      if (ask.wrapUp && background !== true && decideWrapUp(answers)) scheduleDoneHint({ sessionId, directory, generation });
      if (!ask.recap && !ask.nextStep) return null;
      const gate = decideAssist(answers);
      return background === true ? { ...gate, suggestion: false } : gate;
    } catch (error) {
      console.warn('[session-work] turn-end check failed:', error instanceof Error ? error.message : String(error));
      return background === true && assist.suggestion ? { recap: true, suggestion: false } : null;
    }
  };

  const stop = () => {
    stopped = true;
    seenMessages.clear();
    for (const pending of pendingOpens.values()) clearTimeout(pending.timer ?? undefined);
    pendingOpens.clear();
    for (const timer of pendingDoneHints.values()) clearTimeout(timer);
    pendingDoneHints.clear();
    suggested.clear();
    turnGenerations.clear();
  };

  return { processPayload, evaluateTurnEnd, stop };
}
