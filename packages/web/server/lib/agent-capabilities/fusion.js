import { randomUUID } from 'node:crypto';
import { OpenChamberControlError } from '../openchamber-control/error.js';
import {
  asNonEmptyString,
  normalizeTimeoutSeconds,
  splitModel,
} from './session-runner.js';

const DEFAULT_MAX_FUSION_MODELS = 4;
const FUSED_TITLE_PREFIX = 'Fused: ';

const normalizeModels = (value, maxModels) => {
  if (!Array.isArray(value)) {
    throw new OpenChamberControlError('models must contain at least 2 models in provider/model format', 400);
  }
  const seen = new Set();
  const models = [];
  for (const entry of value) {
    const model = splitModel(entry);
    if (!model) {
      throw new OpenChamberControlError(`Invalid model '${String(entry)}' — expected provider/model format`, 400);
    }
    const key = `${model.providerID}/${model.modelID}`;
    if (seen.has(key)) continue;
    seen.add(key);
    models.push(key);
  }
  if (models.length < 2) {
    throw new OpenChamberControlError('models must contain at least 2 models in provider/model format', 400);
  }
  if (models.length > maxModels) {
    throw new OpenChamberControlError(`models must contain at most ${maxModels} models`, 400);
  }
  return models;
};

/**
 * Model fusion: creates one isolated child session of the calling session per
 * model and dispatches the same prompt in parallel with a per-prompt model
 * override, returning every run's final assistant output. Callers resolve
 * presets to model lists before calling; `preset` is only echoed back in the
 * result envelope. Children are real sessions and surface in the UI like
 * subagent sessions.
 */
export const createFusionRuntime = (dependencies) => {
  const {
    runner,
    maxFusionModels = DEFAULT_MAX_FUSION_MODELS,
    fusedTitlePrefix = FUSED_TITLE_PREFIX,
    now = Date.now,
    createRunId = randomUUID,
    emitChildrenCreated,
  } = dependencies;

  if (!runner?.getClient || !runner?.createChildSession) {
    throw new Error('createFusionRuntime requires a session runner');
  }

  const execute = async ({ sessionId, directory, prompt, models, preset, agent, timeoutSeconds, signal, runId: requestedRunId }) => {
    const parentSessionID = asNonEmptyString(sessionId);
    const sessionDirectory = asNonEmptyString(directory);
    if (!parentSessionID) throw new OpenChamberControlError('sessionId is required', 400);
    if (!sessionDirectory) throw new OpenChamberControlError('directory is required', 400);
    const text = asNonEmptyString(prompt);
    if (!text) throw new OpenChamberControlError('prompt is required', 400);
    const requestedAgent = asNonEmptyString(agent) || undefined;
    const modelList = normalizeModels(models, maxFusionModels);
    const resolvedTimeoutSeconds = normalizeTimeoutSeconds(timeoutSeconds);
    const timeoutMs = resolvedTimeoutSeconds === null ? null : resolvedTimeoutSeconds * 1000;
    const runId = asNonEmptyString(requestedRunId) || createRunId();

    await runner.validateModels(sessionDirectory, modelList);

    const client = await runner.getClient();
    const children = [];
    try {
      for (const model of modelList) {
        const child = await runner.createChildSession({
          client,
          parentID: parentSessionID,
          directory: sessionDirectory,
          title: `${fusedTitlePrefix}${model}`,
        });
        children.push({ model, sessionID: child.id });
      }
    } catch (error) {
      // Partial creation must not leak live children: abort whatever was
      // already created before surfacing the real cause.
      if (children.length > 0) {
        await runner.abortSessions({
          client,
          sessionIDs: children.map((child) => child.sessionID),
          directory: sessionDirectory,
        }).catch(() => undefined);
      }
      throw error;
    }

    // Publish the child session ids as soon as they exist so the UI can bind
    // the tool card to the children and stream their messages live (the same
    // join the Task tool publishes through part metadata). Best effort: the
    // UI still discovers children from the live session list as a fallback.
    if (typeof emitChildrenCreated === 'function') {
      try {
        emitChildrenCreated({
          runId,
          sessionId: parentSessionID,
          directory: sessionDirectory,
          preset: asNonEmptyString(preset) || undefined,
          children: children.map(({ model, sessionID }) => ({ model, sessionId: sessionID })),
        });
      } catch {
        // The event channel must never fail a fusion run.
      }
    }

    const successfulChildren = new Set();
    let abortIncompletePromise = null;
    const abortIncompleteChildren = () => {
      const live = children
        .filter((child) => child.sessionID && !successfulChildren.has(child.sessionID))
        .map((child) => child.sessionID);
      if (live.length === 0) return Promise.resolve();
      abortIncompletePromise ??= runner.abortSessions({
        client,
        sessionIDs: live,
        directory: sessionDirectory,
      }).catch(() => undefined);
      return abortIncompletePromise;
    };
    const onAbort = () => {
      void abortIncompleteChildren();
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      throw new OpenChamberControlError('Fusion run was cancelled', 499);
    }

    try {
      const runs = await Promise.all(children.map(async ({ model, sessionID }) => {
        const startedAt = now();
        try {
          const output = await runner.runPromptOnSession({
            client,
            sessionID,
            directory: sessionDirectory,
            prompt: text,
            model: splitModel(model),
            agent: requestedAgent,
            timeoutMs,
            signal,
          });
          successfulChildren.add(sessionID);
          return {
            model,
            sessionId: sessionID,
            status: 'ok',
            result: output.text,
            truncated: output.truncated === true,
            durationMs: output.durationMs,
          };
        } catch (error) {
          if (signal?.aborted) throw error;
          await abortIncompleteChildren();
          return {
            model,
            sessionId: sessionID,
            status: 'error',
            error: error instanceof Error ? error.message : String(error),
            durationMs: now() - startedAt,
          };
        }
      }));
      return {
        runId,
        ...(asNonEmptyString(preset) ? { preset: preset.trim() } : {}),
        runs,
        allOk: runs.every((run) => run.status === 'ok'),
      };
    } finally {
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  };

  return {
    execute,
  };
};
