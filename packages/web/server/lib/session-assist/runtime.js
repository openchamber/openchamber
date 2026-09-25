// Background session assistance. Only live idle events arm generation; there
// is no backfill. A new turn deletes the assist this process wrote; clients
// retire any other payload older than the session's `time.idle`.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { OpenCode } from '@opencode/client';
import { readMergedSettingsSync } from '../opencode/settings-files.js';
import { loadAssistContext, newestContentId } from './context.js';
import { buildAssistPrompt, buildAssistSystemPrompt } from './prompt.js';

const OPENCHAMBER_SETTINGS_FILE = path.join(
  process.env.OPENCHAMBER_DATA_DIR
    ? path.resolve(process.env.OPENCHAMBER_DATA_DIR)
    : path.join(os.homedir(), '.config', 'openchamber'),
  'settings.json',
);

const getSessionAssistTargets = () => {
  const settings = readMergedSettingsSync({ fs, path, settingsFilePath: OPENCHAMBER_SETTINGS_FILE });
  return {
    recap: settings.sessionRecapEnabled !== false,
    suggestion: settings.sessionSuggestionEnabled !== false,
  };
};

const IDLE_QUIET_MS = 60_000;
const RECAP_CHAR_LIMIT = 320;
const SUGGESTION_CHAR_LIMIT = 500;
const FETCH_TIMEOUT_MS = 5_000;
const GENERATION_TIMEOUT_MS = 120_000;
// Enough records to look past the idle marker and a couple of switches.
const TAIL_RECHECK_LIMIT = 8;
const QUIET_FAILURE_CODES = new Set(['context-too-small', 'output-exhausted']);

const extractJsonObject = (value) => {
  const text = String(value ?? '').trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced?.[1] ?? text).trim();
  const start = candidate.indexOf('{');
  if (start < 0) return null;
  for (let end = candidate.length; end > start; end -= 1) {
    if (candidate[end - 1] !== '}') continue;
    try {
      const parsed = JSON.parse(candidate.slice(start, end));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      // keep scanning — models wrap JSON in prose sometimes
    }
  }
  return null;
};

const extractSessionStatus = (payload) => {
  if (!payload || payload.type !== 'session.status') return null;
  const properties = payload.properties && typeof payload.properties === 'object' ? payload.properties : {};
  const status = properties.status && typeof properties.status === 'object' ? properties.status : {};
  const info = properties.info && typeof properties.info === 'object' ? properties.info : {};
  const sessionId = typeof properties.sessionID === 'string' ? properties.sessionID.trim() : '';
  const type = typeof status.type === 'string'
    ? status.type.trim()
    : (typeof info.type === 'string' ? info.type.trim() : '');
  if (!sessionId || !type) return null;
  const directory = typeof properties.directory === 'string' && properties.directory
    ? properties.directory
    : (typeof info.directory === 'string' ? info.directory : '');
  return { sessionId, type, directory };
};

const extractUserMessage = (payload) => {
  if (!payload || payload.type !== 'message.updated') return null;
  const info = payload.properties?.info;
  if (!info || typeof info !== 'object' || info.role !== 'user') return null;
  if (typeof info.sessionID !== 'string' || !info.sessionID) return null;
  return {
    sessionId: info.sessionID,
    createdAt: typeof info.time?.created === 'number' ? info.time.created : 0,
  };
};

/**
 * The recap and the suggestion live in OpenChamber's own session metadata
 * store: OpenCode 2.x accepts session metadata only when a session is created.
 * `persistSessionAssist(sessionID, directory, assist)` writes it; without that
 * seam the runtime stays inert rather than generating text it cannot save.
 */
export const createSessionAssistRuntime = ({
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  getSmallModelService,
  getTargets = getSessionAssistTargets,
  quietMs = IDLE_QUIET_MS,
  persistSessionAssist = null,
  // Archive state is OpenChamber's own in v2 (no OpenCode route sets it), so
  // the runtime asks rather than reading `time.archived` off the record.
  isSessionArchived = async () => false,
}) => {
  const timers = new Map();
  const inflight = new Map();
  const ready = new Map();
  // Sessions holding an assist this process wrote, keyed to their directory.
  const persisted = new Map();
  let stopped = false;

  const clearTimer = (sessionId) => {
    const existing = timers.get(sessionId);
    if (existing) {
      clearTimeout(existing.timer);
      timers.delete(sessionId);
    }
  };

  const invalidate = (sessionId) => {
    clearTimer(sessionId);
    ready.delete(sessionId);
    inflight.get(sessionId)?.controller.abort();
  };

  // A new turn makes the stored recap and suggestion describe an older turn:
  // delete them so "has a suggestion" in metadata means the same everywhere.
  const retireStored = (sessionId, directory) => {
    if (!persisted.has(sessionId)) return;
    const storedDirectory = persisted.get(sessionId);
    persisted.delete(sessionId);
    Promise.resolve(persistSessionAssist(sessionId, directory || storedDirectory, null))
      .catch(() => console.warn('[session-assist] failed to retire a stale assist'));
  };

  const generateAssist = async (sessionId, directory, signal) => {
    const targets = getTargets();
    if (!targets.recap && !targets.suggestion) return;
    const baseUrl = buildOpenCodeUrl('/', '').replace(/\/$/, '');
    const client = OpenCode.make({
      baseUrl,
      headers: {
        ...getOpenCodeAuthHeaders(),
        // v2 scopes by header and rejects non-ASCII header values.
        ...(directory ? { 'x-opencode-directory': encodeURIComponent(directory) } : {}),
      },
    });
    const requestOptions = () => ({ signal: AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]) });
    const checkCurrent = () => {
      signal.throwIfAborted();
      if (buildOpenCodeUrl('/', '').replace(/\/$/, '') !== baseUrl) throw new Error('Session assist runtime changed');
    };
    const session = await client.session.get({ sessionID: sessionId }, requestOptions());
    checkCurrent();
    // Reverted history is not the active conversation. A new prompt clears
    // the revert boundary before its next idle event.
    if (session?.id !== sessionId || session.parentID || session.revert?.messageID) return;
    // An archived session is put away: no recap or suggestion is generated for it.
    if (await isSessionArchived(sessionId)) return;
    const context = await loadAssistContext({
      signal,
      readPage: ({ limit, cursor }) => client.message.list(
        { sessionID: sessionId, limit, ...(cursor ? { cursor } : { order: 'desc' }) },
        requestOptions(),
      ),
    });
    checkCurrent();
    if (!context) return;
    const { last, turns } = context;
    const { describeSmallModel, generateSmallModelText } = await getSmallModelService();
    const preferredProviderID = last.providerID;
    const preferredModelID = last.modelID;
    const described = await describeSmallModel({ directory, preferredProviderID, preferredModelID });
    checkCurrent();
    if (!described) return;
    const system = buildAssistSystemPrompt(targets);
    const prompt = buildAssistPrompt(turns, targets, described.inputCharBudget - system.length - 512);
    if (!prompt) return;
    let generated;
    try {
      generated = await generateSmallModelText({
        prompt: prompt.text, system, directory, sessionID: sessionId,
        preferredProviderID, preferredModelID, restrictToPreferredProvider: true,
        onOverflow: 'error', timeoutMs: GENERATION_TIMEOUT_MS, signal,
      });
    } catch (error) {
      if (!signal.aborted && Number(error?.statusCode) !== 404 && !QUIET_FAILURE_CODES.has(error?.code)) {
        console.warn('[session-assist] generation failed');
      }
      return;
    }
    checkCurrent();
    const structured = extractJsonObject(generated?.text);
    let recap = targets.recap && typeof structured?.recap === 'string' ? structured.recap.trim().slice(0, RECAP_CHAR_LIMIT) : '';
    let suggestion = targets.suggestion && typeof structured?.suggestion === 'string' ? structured.suggestion.trim().slice(0, SUGGESTION_CHAR_LIMIT) : '';
    const hasCyrillic = (text) => /[\u0400-\u04FF]/.test(text);
    const hasCjk = (text) => /[\u3040-\u30FF\u4E00-\u9FFF\uAC00-\uD7AF]/.test(text);
    // Quoted source and assistant replies cannot authorize a different script.
    // With no authored language sample, leave the decision to the prompt.
    const scriptMismatch = (text) => prompt.language && ((hasCyrillic(text) && !hasCyrillic(prompt.language))
      || (hasCjk(text) && !hasCjk(prompt.language)));
    if (recap && scriptMismatch(recap)) recap = '';
    if (suggestion && scriptMismatch(suggestion)) suggestion = '';
    if (!recap && !suggestion) return;
    // v2 lists newest first. The answer is followed by its `idle` marker and
    // possibly a model or agent switch, so read a short tail and compare the
    // newest content record rather than the newest record.
    const latestPage = await client.message.list({ sessionID: sessionId, limit: TAIL_RECHECK_LIMIT, order: 'desc' }, requestOptions());
    checkCurrent();
    if (newestContentId(latestPage?.data) !== last.id) return;
    // Never fall back to the pre-generation metadata snapshot after a failed
    // fresh read: doing so overwrites dismissals and unrelated metadata.
    const freshSession = await client.session.get({ sessionID: sessionId }, requestOptions());
    checkCurrent();
    if (freshSession?.id !== sessionId || freshSession.revert?.messageID || freshSession.location?.directory !== session.location?.directory) return;
    if (await isSessionArchived(sessionId)) return;
    const enabled = getTargets();
    if (!enabled.recap) recap = '';
    if (!enabled.suggestion) suggestion = '';
    if (!recap && !suggestion) return;
    await persistSessionAssist(sessionId, directory, {
      recap,
      suggestion,
      forMessageID: last.id,
      generatedAt: Date.now(),
    });
    persisted.set(sessionId, directory);
  };

  const startGeneration = (sessionId, directory, armedAt) => {
    if (stopped) return;
    if (inflight.has(sessionId)) {
      ready.set(sessionId, { directory, armedAt });
      return;
    }
    const controller = new AbortController();
    inflight.set(sessionId, { controller, armedAt });
    generateAssist(sessionId, directory, controller.signal)
      .catch(() => {
        if (!controller.signal.aborted) console.warn('[session-assist] failed to read or save assistance');
      })
      .finally(() => {
        inflight.delete(sessionId);
        if (ready.has(sessionId)) {
          const next = ready.get(sessionId);
          ready.delete(sessionId);
          startGeneration(sessionId, next.directory, next.armedAt);
        }
      });
  };

  const armTimer = (sessionId, directory) => {
    clearTimer(sessionId);
    const armedAt = Date.now();
    const timer = setTimeout(() => {
      timers.delete(sessionId);
      startGeneration(sessionId, directory, armedAt);
    }, quietMs);
    timer.unref?.();
    timers.set(sessionId, { timer, armedAt });
  };

  let parkedNoticeLogged = false;
  const processPayload = (payload, directoryHint = '') => {
    if (stopped) return;
    if (typeof persistSessionAssist !== 'function') {
      if (!parkedNoticeLogged) {
        parkedNoticeLogged = true;
        console.log('[session-assist] parked: no session metadata store is wired, so a recap could not be saved');
      }
      return;
    }
    const status = extractSessionStatus(payload);
    if (status) {
      if (status.type === 'idle') armTimer(status.sessionId, status.directory || directoryHint);
      else {
        invalidate(status.sessionId);
        retireStored(status.sessionId, status.directory || directoryHint);
      }
      return;
    }
    const userMessage = extractUserMessage(payload);
    if (userMessage) {
      // Ignore old message.updated events re-emitted after completion.
      const since = timers.get(userMessage.sessionId)?.armedAt ?? inflight.get(userMessage.sessionId)?.armedAt;
      if (since !== undefined && userMessage.createdAt >= since) invalidate(userMessage.sessionId);
    }
  };

  const stop = () => {
    stopped = true;
    for (const sessionId of timers.keys()) clearTimer(sessionId);
    ready.clear();
    for (const { controller } of inflight.values()) controller.abort();
  };
  return { processPayload, stop };
};
