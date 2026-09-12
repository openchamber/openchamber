// Background session assistance. Only live idle events arm generation; there
// is no backfill. Clients hide results whose forMessageID is no longer current.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createOpencodeClient } from '@opencode-ai/sdk/v2';
import { readMergedSettingsSync } from '../opencode/settings-files.js';
import { loadAssistContext } from './context.js';
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

export const createSessionAssistRuntime = ({
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  getSmallModelService,
  getTargets = getSessionAssistTargets,
  quietMs = IDLE_QUIET_MS,
}) => {
  const timers = new Map();
  const inflight = new Map();
  const ready = new Map();
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

  const generateAssist = async (sessionId, directory, signal) => {
    const targets = getTargets();
    if (!targets.recap && !targets.suggestion) return;
    const baseUrl = buildOpenCodeUrl('/', '').replace(/\/$/, '');
    const client = createOpencodeClient({ baseUrl, headers: getOpenCodeAuthHeaders(), throwOnError: true });
    const requestOptions = () => ({ signal: AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]) });
    const checkCurrent = () => {
      signal.throwIfAborted();
      if (buildOpenCodeUrl('/', '').replace(/\/$/, '') !== baseUrl) throw new Error('Session assist runtime changed');
    };
    const { data: session } = await client.session.get({ sessionID: sessionId, directory }, requestOptions());
    checkCurrent();
    // Reverted history is not the active conversation. A new prompt clears
    // the revert boundary before its next idle event.
    if (session?.id !== sessionId || session.parentID || session.revert?.messageID || session.time?.archived) return;
    const context = await loadAssistContext({
      signal,
      readPage: (page) => client.session.messages({ sessionID: sessionId, directory, ...page }, requestOptions()),
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
    const { data: latest } = await client.session.messages({ sessionID: sessionId, directory, limit: 1 }, requestOptions());
    checkCurrent();
    if (latest?.at(-1)?.info.id !== last.id) return;
    // Never fall back to the pre-generation metadata snapshot after a failed
    // fresh read: doing so overwrites dismissals and unrelated metadata.
    const { data: freshSession } = await client.session.get({ sessionID: sessionId, directory }, requestOptions());
    checkCurrent();
    if (freshSession?.id !== sessionId || freshSession.revert?.messageID || freshSession.time?.archived || freshSession.directory !== session.directory) return;
    const enabled = getTargets();
    if (!enabled.recap) recap = '';
    if (!enabled.suggestion) suggestion = '';
    if (!recap && !suggestion) return;
    const currentMetadata = freshSession.metadata ?? {};
    const currentNamespace = currentMetadata.openchamber ?? {};
    await client.session.update({
      sessionID: sessionId, directory,
      metadata: {
        ...currentMetadata,
        openchamber: {
          ...currentNamespace,
          assist: { recap, suggestion, forMessageID: last.id, generatedAt: Date.now() },
        },
      },
    }, requestOptions());
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

  const processPayload = (payload, directoryHint = '') => {
    if (stopped) return;
    const status = extractSessionStatus(payload);
    if (status) {
      if (status.type === 'idle') armTimer(status.sessionId, status.directory || directoryHint);
      else invalidate(status.sessionId);
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
