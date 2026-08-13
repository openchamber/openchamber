import { createOpencodeClient } from '@opencode-ai/sdk/v2';
import { OpenChamberControlError } from '../openchamber-control/error.js';

const MAX_RUN_TIMEOUT_SECONDS = 86_400;
const WAIT_POLL_INTERVAL_MS = 500;
const MAX_RESULT_CHARS = 60_000;

export const asNonEmptyString = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

export const splitModel = (value) => {
  const model = asNonEmptyString(value);
  if (!model) return null;
  const slashIndex = model.indexOf('/');
  if (slashIndex <= 0 || slashIndex === model.length - 1) return null;
  return { providerID: model.slice(0, slashIndex), modelID: model.slice(slashIndex + 1) };
};

// Undefined means "no deadline": runs end when the model answers or the run is
// aborted, exactly like opencode's Task tool. An explicit value is still
// honored (and bounded) when a caller passes one.
export const normalizeTimeoutSeconds = (value) => {
  if (value === undefined || value === null) return null;
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > MAX_RUN_TIMEOUT_SECONDS) {
    throw new OpenChamberControlError(`timeout must be from 1 to ${MAX_RUN_TIMEOUT_SECONDS} seconds`, 400);
  }
  return seconds;
};

const truncateResult = (text) => {
  if (text.length <= MAX_RESULT_CHARS) return { text, truncated: false };
  return { text: `${text.slice(0, MAX_RESULT_CHARS)}\n… (truncated)`, truncated: true };
};

const providerModels = (provider) => {
  if (Array.isArray(provider?.models)) return provider.models;
  if (provider?.models && typeof provider.models === 'object') return Object.values(provider.models);
  return [];
};

/**
 * Shared runner for model fusion: creates child sessions and drives runs
 * against OpenCode with per-prompt model overrides. All children are real
 * sessions, so they stream through the normal session event pipeline and
 * appear in the UI like subagent sessions.
 */
export const createSessionRunner = (dependencies) => {
  const {
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    waitForOpenCodeReady,
    createClient = createOpencodeClient,
    sleep = (duration) => new Promise((resolve) => setTimeout(resolve, duration)),
    now = Date.now,
  } = dependencies;

  const getClient = async () => {
    if (typeof waitForOpenCodeReady === 'function') await waitForOpenCodeReady(10_000, 250);
    return createClient({
      baseUrl: buildOpenCodeUrl('/', '').replace(/\/$/, ''),
      headers: getOpenCodeAuthHeaders(),
    });
  };

  const buildDirectoryHeaders = (directory) => ({
    ...(directory ? { 'x-opencode-directory': directory } : {}),
  });

  // An empty provider list means the lookup failed or returned nothing
  // authoritative; it must not turn a valid selection into a rejection.
  const validateModels = async (directory, models) => {
    if (models.length === 0) return;
    const url = new URL(buildOpenCodeUrl('/config/providers', ''));
    url.searchParams.set('directory', directory);
    const response = await fetch(url.toString(), {
      headers: { ...getOpenCodeAuthHeaders(), ...buildDirectoryHeaders(directory), accept: 'application/json' },
    });
    if (!response.ok) return;
    const body = await response.json().catch(() => null);
    const providers = Array.isArray(body?.providers) ? body.providers : [];
    if (providers.length === 0) return;
    const known = new Set();
    for (const provider of providers) {
      for (const model of providerModels(provider)) {
        if (provider?.id && model?.id) known.add(`${provider.id}/${model.id}`);
      }
    }
    const unknown = models.filter((model) => !known.has(model));
    if (unknown.length > 0) {
      throw new OpenChamberControlError(
        `Unknown model${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')} for ${directory}`,
        400,
      );
    }
  };

  // Creates a child session of `parentID` (like opencode's subagent sessions),
  // so the child is nested under the parent in the sidebar and work-status
  // panels. The title is set at creation: the Task-tool children that the UI
  // renders as subagents are created this way.
  //
  // NOTE: the v2 SDK client takes FLATTENED options — a nested `body: {...}`
  // is silently dropped, creating a plain auto-titled session without
  // parentID. `parentID`/`title`/`directory` must be top-level.
  //
  // Failures must surface the real cause (status + server message): a generic
  // "failed to create child session" hid e.g. an unknown parentID such as a
  // placeholder "current" the model invented.
  const createChildSession = async ({ client, parentID, directory, title }) => {
    const response = await client.session.create({
      directory,
      parentID,
      title,
    });
    const session = response?.data;
    if (session?.id) return session;
    const status = response?.response?.status;
    const error = response?.error;
    let detail = '';
    if (error && typeof error === 'object') {
      if (typeof error.message === 'string' && error.message.length > 0) detail = error.message;
      else if (typeof error.error?.message === 'string' && error.error.message.length > 0) detail = error.error.message;
      else detail = JSON.stringify(error).slice(0, 300);
    } else if (error) {
      detail = String(error).slice(0, 300);
    }
    throw new OpenChamberControlError(
      `failed to create child session${Number.isInteger(status) ? ` (HTTP ${status})` : ''}${detail ? `: ${detail}` : ''}`,
      Number.isInteger(status) && status >= 400 && status < 500 ? 400 : 500,
    );
  };

  const sessionStatus = async ({ client, sessionID, directory }) => {
    const response = await client.session.status({ directory });
    const statuses = response?.data;
    if (!statuses || typeof statuses !== 'object' || Array.isArray(statuses)) return { type: 'idle' };
    return statuses[sessionID] || { type: 'idle' };
  };

  const dispatchPrompt = async ({ baseUrl, sessionID, directory, prompt, model, agent }) => {
    const promptUrl = new URL(`${baseUrl}/session/${encodeURIComponent(sessionID)}/prompt_async`);
    promptUrl.searchParams.set('directory', directory);
    const response = await fetch(promptUrl.toString(), {
      method: 'POST',
      headers: {
        ...getOpenCodeAuthHeaders(),
        ...buildDirectoryHeaders(directory),
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        model,
        ...(agent ? { agent } : {}),
        parts: [{ type: 'text', text: prompt }],
      }),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`prompt_async failed (${response.status})${body ? `: ${body}` : ''}`);
    }
  };

  const latestAssistantMessage = async ({ client, sessionID, directory }) => {
    const response = await client.session.messages({ sessionID, directory, limit: 100 });
    const records = Array.isArray(response?.data) ? response.data : [];
    let latest = null;
    for (const record of records) {
      const info = record?.info;
      if (info?.role !== 'assistant' || !Number.isFinite(info?.time?.completed)) continue;
      if (!latest || (info.time.created || 0) >= (latest.time?.created || 0)) latest = record;
    }
    return latest;
  };

  const assistantText = (record) => {
    if (!record) return null;
    const text = Array.isArray(record.parts)
      ? record.parts
        .filter((part) => part?.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text)
        .join('\n')
        .trim()
      : '';
    return text || null;
  };

  // A dispatch that never produces a run (silent failure) should surface
  // quickly instead of waiting the full timeout for nothing.
  const SILENT_RUN_GRACE_MS = 15_000;

  // Waits until the run reports activity (busy) and then goes idle, or a new
  // completed assistant message appears. For a freshly created child session
  // there is no history, so the first completed assistant message IS the run
  // result — no baseline bookkeeping is needed. If the session stays idle
  // without producing a message the run died silently; fail fast after the
  // grace window instead of hanging the caller for the full timeout.
  const waitForIdle = async ({ client, sessionID, directory, timeoutMs, signal }) => {
    // No timeout means no deadline: like the Task tool, the wait ends when the
    // run produces a result or the caller aborts.
    const deadline = timeoutMs === null || timeoutMs === undefined ? null : now() + timeoutMs;
    let observedActivity = false;
    let idleSince = null;
    while (true) {
      if (signal?.aborted) throw new OpenChamberControlError('Agent capability run was cancelled', 499);
      const status = await sessionStatus({ client, sessionID, directory });
      if (status.type === 'busy' || status.type === 'retry') {
        observedActivity = true;
        idleSince = null;
      } else {
        const message = await latestAssistantMessage({ client, sessionID, directory });
        if (message?.info && Number.isFinite(message.info.time?.completed)) {
          return;
        }
        if (!observedActivity) {
          const nowMs = now();
          if (idleSince === null) idleSince = nowMs;
          if (nowMs - idleSince > SILENT_RUN_GRACE_MS) {
            throw new OpenChamberControlError('The run did not start; no assistant activity was recorded', 500);
          }
        }
      }
      if (deadline !== null) {
        const remaining = deadline - now();
        if (remaining <= 0) {
          throw new OpenChamberControlError(`Run did not complete within ${Math.ceil(timeoutMs / 1000)} seconds`, 500);
        }
        await sleep(Math.min(WAIT_POLL_INTERVAL_MS, remaining));
      } else {
        await sleep(WAIT_POLL_INTERVAL_MS);
      }
    }
  };

  // Runs one prompt on an existing session with an optional model/agent
  // override and returns the final assistant text.
  const runPromptOnSession = async ({
    client,
    sessionID,
    directory,
    prompt,
    model,
    agent,
    timeoutMs,
    signal,
  }) => {
    const startedAt = now();
    const baseUrl = buildOpenCodeUrl('/', '').replace(/\/$/, '');
    await dispatchPrompt({
      baseUrl,
      sessionID,
      directory,
      prompt,
      model,
      agent,
    });
    await waitForIdle({
      client,
      sessionID,
      directory,
      timeoutMs,
      signal,
    });
    const message = await latestAssistantMessage({ client, sessionID, directory });
    if (message?.info?.error) {
      // A failed run is still a completed assistant message, but with an error
      // record instead of parts. Surface the provider/API message so the
      // caller shows a real reason (e.g. Insufficient Balance) rather than a
      // generic "no output".
      const runError = message.info.error;
      const detail = typeof runError?.data?.message === 'string' && runError.data.message.length > 0
        ? runError.data.message
        : typeof runError?.message === 'string' && runError.message.length > 0
          ? runError.message
          : 'run failed';
      throw new Error(detail);
    }
    const text = assistantText(message);
    if (!text) {
      throw new Error('run produced no assistant output');
    }
    const truncated = truncateResult(text);
    return {
      text: truncated.text,
      truncated: truncated.truncated,
      durationMs: now() - startedAt,
      model: splitModel(message?.info?.model?.providerID && message.info.model?.modelID
        ? `${message.info.model.providerID}/${message.info.model.modelID}`
        : null) || null,
    };
  };

  const abortSessions = async ({ client, sessionIDs, directory }) => {
    const results = await Promise.allSettled(sessionIDs.map((sessionID) => (
      client.session.abort({ sessionID, directory })
    )));
    return results.filter((entry) => entry.status === 'fulfilled').length;
  };

  return {
    getClient,
    validateModels,
    createChildSession,
    runPromptOnSession,
    abortSessions,
  };
};
