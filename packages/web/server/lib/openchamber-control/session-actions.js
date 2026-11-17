/**
 * Session management actions for the `openchamber` control tool: the things a
 * user does to one existing session from its header and composer — rename it,
 * change its model, effort or agent, run it as a goal, retry or stop its turn,
 * and pin context into it.
 *
 * Dependencies, with the identifier in `server/index.js` to pass:
 *
 * - `sessionService` — `openChamberSessionService`. Its `getMetadata` and
 *   `setMetadata` are the metadata read and write path; `setMetadata` goes
 *   through `persistSessionMetadataPatch`, so every write is broadcast to the
 *   UI and a goal change arms the goal loop (`notifyGoalChanged`).
 * - `sessionKnowledgeRuntime` — `sessionKnowledgeRuntime`; optional. Without
 *   it, pinning a project note or plan answers 503.
 * - `createSessionGoal`, `readObjective`, `deleteObjective` — optional
 *   overrides for tests; the defaults are the session-goal modules.
 *
 * Every v2 call is directory-scoped (`ctx.getClient(directory)`): a session
 * addressed through another directory's instance is not found, and an
 * interrupt sent there stops nothing while still answering success.
 */
import { asNonEmptyString, isRecord } from '../shared/guards.js';
import { isAutoModel } from '../routing/defaults.js';
import { createSessionGoal as createSessionGoalDefault } from '../session-goal/create.js';
import {
  deleteObjective as deleteObjectiveDefault,
  readObjective as readObjectiveDefault,
} from '../session-goal/objectives.js';
import { OpenChamberControlError } from './error.js';

export const SESSION_EXTRA_ACTION_DEFINITIONS = Object.freeze([
  { action: 'session.rename', title: 'Rename a session', description: 'Set the title of sessionId (defaults to the current session); an empty title asks OpenCode to generate one from the conversation' },
  { action: 'session.subagentPolicy', title: 'Set a session\'s subsession model policy', description: 'Replace the subagentPolicy of sessionId (defaults to the current session): { models, excludedModels, agentOverrides } limits the models its subsessions may run. The whole policy is replaced, and the change applies to subsessions started after it. Use only when the user asks' },
  { action: 'session.model', title: 'Change a session\'s model or effort', description: 'Switch sessionId (defaults to the current session) to model (provider/model) and/or variant, the model\'s effort or thinking level. variant alone keeps the current model; model without variant uses the model\'s default effort. Takes effect from the next turn. Use only when the user asks' },
  { action: 'session.agent', title: 'Change a session\'s agent', description: 'Switch sessionId (defaults to the current session) to the primary agent named by agent; takes effect from the next turn. Use only when the user asks' },
  { action: 'session.goal', title: 'Manage a session\'s goal', description: 'Goal Mode for sessionId (defaults to the current session), chosen by goalAction: get shows the goal and its objective; set starts a goal from objective, or rewrites the objective of the current one keeping its progress (goalTokenBudget optional); pause stops the goal and the running turn; resume restarts it with a fresh turn allowance; complete marks it done; clear removes it and stops the running turn. The goal of the session you are running in is settled by its progress check or by the user: pause, complete and clear are refused there' },
  { action: 'session.retry', title: 'Retry a session\'s last prompt', description: 'Run the last prompt of sessionId again: its turn and everything after it are reverted (file changes included) and the same prompt is sent on the session\'s current model and agent. messageId picks an earlier user message instead. A running turn is stopped first. Not available for the session you are running in' },
  { action: 'session.pin', title: 'Pin context into a session', description: 'Pin messageId of sessionId (defaults to the current session) so it is re-sent to the agent after every compaction; pinned false unpins it. With pinKind note or plan, pins the project note or plan pinId instead, so it rides along with the session\'s context' },
  { action: 'session.abort', title: 'Stop a running session', description: 'Stop the running turn of sessionId. Queued prompts stay queued. Not available for the session you are running in' },
]);

export const SESSION_EXTRA_PARAMETERS = {
  subagentPolicy: {
    type: 'object',
    description: 'session.subagentPolicy: the whole policy, { models, excludedModels, agentOverrides }; models and excludedModels are model selectors such as provider/model or provider/*',
    properties: {
      models: { type: 'array', items: { type: 'string' } },
      excludedModels: { type: 'array', items: { type: 'string' } },
      agentOverrides: { type: 'object' },
    },
  },
  goalAction: { type: 'string', enum: ['get', 'set', 'pause', 'resume', 'complete', 'clear'], description: 'session.goal: what to do with the goal' },
  objective: { type: 'string', description: 'session.goal set: what the goal must achieve, written as completion criteria; text over the goal length limit in Settings (5000 characters unless changed) is condensed' },
  pinned: { type: 'boolean', description: 'session.pin: false unpins; default true' },
  pinKind: { type: 'string', enum: ['message', 'note', 'plan'], description: 'session.pin: what to pin; default message (needs messageId), note or plan need pinId' },
  pinId: { type: 'string', description: 'session.pin: id of the project note or plan to pin' },
};

const MIN_GOAL_TOKEN_BUDGET = 1_000;
const MAX_GOAL_TOKEN_BUDGET = 100_000_000;
const GOAL_ACTIONS = new Set(['get', 'set', 'pause', 'resume', 'complete', 'clear']);
const RETRY_MESSAGE_WINDOW = 100;

const parseModel = (value) => {
  const model = asNonEmptyString(value);
  const slashIndex = model ? model.indexOf('/') : -1;
  if (slashIndex <= 0 || slashIndex === model.length - 1) {
    throw new OpenChamberControlError('model must be in provider/model format', 400);
  }
  return { providerID: model.slice(0, slashIndex), modelID: model.slice(slashIndex + 1) };
};

const asList = (value) => (Array.isArray(value) ? value : []);

// v2 client errors carry a tagged name rather than an HTTP status.
const isNotFound = (error) => Number(error?.status) === 404
  || Number(error?.statusCode) === 404
  || /NotFound/.test(String(error?._tag ?? ''));

const readGoal = (metadata) => {
  const namespace = isRecord(metadata?.openchamber) ? metadata.openchamber : {};
  return isRecord(namespace.goal) ? namespace.goal : null;
};

const readPinnedMessages = (metadata) => {
  const namespace = isRecord(metadata?.openchamber) ? metadata.openchamber : {};
  return asList(namespace.context_obligatory_messages)
    .filter((entry) => isRecord(entry) && asNonEmptyString(entry.id));
};

/**
 * The store applies an RFC 7386 merge, so a goal written over another one
 * keeps every key the new record lacks (the old accounting cursors, the last
 * checker). Those keys are deleted explicitly, the way the UI's
 * `buildMetadataMergePatch` does.
 */
const replaceGoalPatch = (previous, next) => {
  const goal = { ...next };
  for (const key of Object.keys(previous ?? {})) {
    if (!(key in goal)) goal[key] = null;
  }
  return { openchamber: { goal } };
};

/** `target` with those of `keys` that `source` sets. */
const withPresent = (target, source, keys) => {
  for (const key of keys) {
    if (source?.[key]) target[key] = source[key];
  }
  return target;
};

/** A user message's prompt, in the shape `session.prompt` takes it back. */
const promptFromUserMessage = (message) => {
  // A stored attachment is inline bytes or a reference; the prompt takes a uri.
  const files = asList(message.files).map((file) => withPresent({
    uri: file?.source?.type === 'uri' ? file.source.uri : `data:${file.mime};base64,${file.data}`,
  }, file, ['name', 'description', 'mention']));
  const agents = asList(message.agents).map((agent) => withPresent({ name: agent.name }, agent, ['mention']));
  const skills = asList(message.skills).map((skill) => withPresent({ id: skill.id }, skill, ['mention']));
  const prompt = { text: String(message.text ?? '') };
  if (files.length > 0) prompt.files = files;
  if (agents.length > 0) prompt.agents = agents;
  if (skills.length > 0) prompt.skills = skills;
  if (isRecord(message.metadata)) prompt.metadata = message.metadata;
  return prompt;
};

export const createSessionExtraActions = (deps) => {
  const {
    sessionService,
    sessionKnowledgeRuntime = null,
    createSessionGoal = createSessionGoalDefault,
    readObjective = readObjectiveDefault,
    deleteObjective = deleteObjectiveDefault,
  } = deps;

  const readMetadata = async (sessionID, directory) => (await sessionService.getMetadata(sessionID, directory)).metadata;
  const writeMetadata = async (sessionID, directory, patch) => (await sessionService.setMetadata(sessionID, { patch, directory })).metadata;

  const isActive = async (client, sessionID) => {
    const statuses = await client.session.active();
    return Boolean(isRecord(statuses) && Object.hasOwn(statuses, sessionID) && statuses[sessionID]);
  };

  const interrupt = async (client, sessionID) => {
    const result = await client.session.interrupt({ sessionID });
    return result?.interrupted === true;
  };

  // An empty catalogue means the lookup failed, never that nothing exists, so
  // validation only refuses against a list that answered.
  const listCatalog = (call) => call().then((response) => asList(response?.data)).catch(() => []);

  const rename = async ({ client, sessionID, input }) => {
    if (input.title === undefined || input.title === null) {
      throw new OpenChamberControlError('title is required; pass an empty title to have one generated', 400);
    }
    const title = asNonEmptyString(input.title) ?? '';
    await client.session.update({ sessionID, title });
    return title ? { sessionId: sessionID, title } : { sessionId: sessionID, title: null, regenerating: true };
  };

  const setSubagentPolicy = async ({ client, sessionID, input }) => {
    if (!isRecord(input.subagentPolicy)) {
      throw new OpenChamberControlError('subagentPolicy must be an object with models, excludedModels, or agentOverrides', 400);
    }
    // Forwarded unchanged: OpenCode owns the policy shape and its checks.
    await client.session.update({ sessionID, subagentPolicy: input.subagentPolicy });
    return { sessionId: sessionID, subagentPolicy: input.subagentPolicy };
  };

  const switchModel = async ({ client, sessionID, input }) => {
    const requested = asNonEmptyString(input.model) ? parseModel(input.model) : null;
    const variantGiven = input.variant !== undefined && input.variant !== null;
    if (!requested && !variantGiven) throw new OpenChamberControlError('model or variant is required', 400);
    // The sentinel is resolved by the composer's proxy, never by OpenCode.
    if (requested && isAutoModel(requested)) {
      throw new OpenChamberControlError('Auto routing cannot be set on a session from here; choose a concrete model', 400);
    }
    let model = requested;
    if (!model) {
      const session = await client.session.get({ sessionID });
      const providerID = asNonEmptyString(session?.model?.providerID);
      const modelID = asNonEmptyString(session?.model?.id);
      if (!providerID || !modelID) {
        throw new OpenChamberControlError('The session has no model yet; pass model together with variant', 409);
      }
      model = { providerID, modelID };
    }
    // An empty variant is an explicit return to the model's default effort.
    const variant = asNonEmptyString(input.variant);

    const models = await listCatalog(() => client.model.list());
    if (models.length > 0) {
      const entry = models.find((candidate) => candidate?.providerID === model.providerID && candidate?.modelID === model.modelID);
      if (!entry) throw new OpenChamberControlError(`Unknown model '${model.providerID}/${model.modelID}'`, 400);
      const variants = asList(entry.variants).map((candidate) => candidate?.id).filter(Boolean);
      if (variant && !variants.includes(variant)) {
        throw new OpenChamberControlError(
          `Unknown variant '${variant}' for model '${model.providerID}/${model.modelID}'${variants.length > 0 ? `; use one of: ${variants.join(', ')}` : '; it has none'}`,
          400,
        );
      }
    }

    const selection = { id: model.modelID, providerID: model.providerID };
    if (variant) selection.variant = variant;
    await client.session.switchModel({ sessionID, model: selection });
    return { sessionId: sessionID, model: `${model.providerID}/${model.modelID}`, variant: variant ?? null };
  };

  const switchAgent = async ({ client, sessionID, input }) => {
    const agent = asNonEmptyString(input.agent);
    if (!agent) throw new OpenChamberControlError('agent is required', 400);
    const agents = await listCatalog(() => client.agent.list());
    if (agents.length > 0) {
      const entry = agents.find((candidate) => candidate?.id === agent);
      if (!entry) {
        const primary = agents.filter((candidate) => candidate?.mode !== 'subagent' && candidate?.hidden !== true).map((candidate) => candidate.id);
        throw new OpenChamberControlError(`Unknown agent '${agent}'; use one of: ${primary.join(', ')}`, 400);
      }
      if (entry.mode === 'subagent') {
        throw new OpenChamberControlError(`Agent '${agent}' is a subagent and cannot run a session`, 400);
      }
    }
    await client.session.switchAgent({ sessionID, agent });
    return { sessionId: sessionID, agent };
  };

  const goalResult = async (sessionID, goal) => {
    if (!goal) return { sessionId: sessionID, goal: null };
    const objective = goal.objectiveFile === true
      ? (await readObjective(sessionID)) ?? asNonEmptyString(goal.objective)
      : asNonEmptyString(goal.objective);
    return { sessionId: sessionID, goal: { ...goal, objective: objective ?? '' } };
  };

  const setGoal = async ({ client, sessionID, directory, input, current }) => {
    const objective = asNonEmptyString(input.objective);
    if (!objective) throw new OpenChamberControlError('objective is required for goalAction set', 400);
    const budget = input.goalTokenBudget;
    if (budget !== undefined && (!Number.isSafeInteger(budget) || budget < MIN_GOAL_TOKEN_BUDGET || budget > MAX_GOAL_TOKEN_BUDGET)) {
      throw new OpenChamberControlError(`goalTokenBudget must be an integer from ${MIN_GOAL_TOKEN_BUDGET} to ${MAX_GOAL_TOKEN_BUDGET}`, 400);
    }
    // Same rule as the goal dialog: a finished goal is replaced, any other is
    // edited in place so its id, usage and turn counters carry on.
    const editing = current && current.status !== 'complete';
    const session = await client.session.get({ sessionID }).catch(() => null);
    let written = null;
    // create.js owns fitting the objective (distilling an oversized one) and
    // the file-or-inline storage; an edit takes those and keeps the record.
    await createSessionGoal({
      sessionID,
      directory,
      objective,
      tokenBudget: budget ?? null,
      providerID: asNonEmptyString(session?.model?.providerID) ?? undefined,
      modelID: asNonEmptyString(session?.model?.id) ?? undefined,
      onWarning: (message, error) => console.warn(`[openchamber-control] ${message}:`, error?.message || error),
      persistSessionGoal: async (goalSessionID, goalDirectory, fresh) => {
        written = editing
          ? {
            ...current,
            objective: fresh.objective,
            objectiveFile: fresh.objectiveFile,
            tokenBudget: budget ?? current.tokenBudget ?? null,
            status: 'active',
            statusReason: 'resumed',
            blockedStreak: 0,
            updatedAt: fresh.updatedAt,
          }
          : fresh;
        await writeMetadata(goalSessionID, goalDirectory, editing ? { openchamber: { goal: written } } : replaceGoalPatch(current, fresh));
      },
    });
    return { ...(await goalResult(sessionID, written)), created: !editing };
  };

  const goal = async ({ client, sessionID, directory, input, isCallingSession }) => {
    const goalAction = asNonEmptyString(input.goalAction);
    if (!goalAction || !GOAL_ACTIONS.has(goalAction)) {
      throw new OpenChamberControlError('goalAction must be get, set, pause, resume, complete, or clear', 400);
    }
    // The progress check is the goal's only judge besides the user; an agent
    // that could stop its own goal could end the loop it is being held to.
    if (isCallingSession && (goalAction === 'pause' || goalAction === 'complete' || goalAction === 'clear')) {
      throw new OpenChamberControlError(`A goal cannot be ${goalAction === 'clear' ? 'cleared' : `${goalAction}d`} by the session it drives; its progress check or the user settles it`, 409);
    }
    const current = readGoal(await readMetadata(sessionID, directory));

    if (goalAction === 'get') return goalResult(sessionID, current);
    if (goalAction === 'set') return setGoal({ client, sessionID, directory, input, current });

    if (goalAction === 'clear') {
      await writeMetadata(sessionID, directory, { openchamber: { goal: null } });
      await deleteObjective(sessionID);
      // Removing a running goal is a stop too, as in the goal dialog.
      const interrupted = current?.status === 'active' ? await interrupt(client, sessionID) : false;
      return { sessionId: sessionID, goal: null, cleared: Boolean(current), interrupted };
    }

    if (!current) throw new OpenChamberControlError('The session has no goal', 404);
    // Pausing also stops the turn in flight, before the write, as the dialog does.
    const interrupted = goalAction === 'pause' ? await interrupt(client, sessionID) : false;
    const status = goalAction === 'pause' ? 'paused' : goalAction === 'resume' ? 'active' : 'complete';
    const next = {
      ...current,
      status,
      // 'resumed' is the loop's kickoff signal for an already idle session.
      statusReason: status === 'active' ? 'resumed' : status === 'complete' ? 'marked by user' : '',
      blockedStreak: 0,
      updatedAt: Date.now(),
    };
    // A fresh turn allowance, or a goal blocked on the turn cap re-blocks at once.
    if (status === 'active') next.turnsUsed = 0;
    await writeMetadata(sessionID, directory, { openchamber: { goal: next } });
    const result = await goalResult(sessionID, next);
    if (goalAction === 'pause') result.interrupted = interrupted;
    return result;
  };

  const findRetryTarget = async (client, sessionID, messageID) => {
    if (messageID) {
      let message;
      try {
        message = await client.session.message.get({ sessionID, messageID });
      } catch (error) {
        if (isNotFound(error)) throw new OpenChamberControlError(`Message not found: ${messageID}`, 404);
        throw error;
      }
      if (message?.type !== 'user') throw new OpenChamberControlError('messageId must be a user message', 400);
      return message;
    }
    const response = await client.message.list({ sessionID, limit: RETRY_MESSAGE_WINDOW, order: 'desc', type: 'user' });
    const latest = asList(response?.data)
      .filter((message) => message?.type === 'user')
      .sort((left, right) => (right.time?.created ?? 0) - (left.time?.created ?? 0))[0];
    if (!latest) throw new OpenChamberControlError('The session has no prompt to retry', 409);
    return latest;
  };

  /**
   * Revert to the prompt and send it again. The cut is the prompt itself, not
   * the synthetic context messages before it as the UI's revert cuts: those
   * carry the review comments and project context the prompt was sent with,
   * and a retry should run with them where a revert hands them back to the
   * composer. A goal reminder sent after the prompt is reverted with it.
   */
  const retry = async ({ client, sessionID, input }) => {
    const target = await findRetryTarget(client, sessionID, asNonEmptyString(input.messageId));
    const prompt = promptFromUserMessage(target);
    if (!prompt.text && !prompt.files) throw new OpenChamberControlError('That message has no text or files to send again', 409);

    // Retrying is an explicit request to replace the turn, so a running one is
    // stopped rather than refused, as the UI's revert does.
    const interrupted = await isActive(client, sessionID) ? await interrupt(client, sessionID) : false;
    await client.session.revert.stage({ sessionID, messageID: target.id });
    let sent;
    try {
      sent = await client.session.prompt({ sessionID, ...prompt });
    } catch (error) {
      // The staged revert would otherwise hide the turn with nothing replacing it.
      await client.session.revert.clear({ sessionID }).catch(() => undefined);
      throw error;
    }
    const messageID = asNonEmptyString(sent?.id);
    return {
      sessionId: sessionID,
      retriedMessageId: target.id,
      interrupted,
      promptDispatched: Boolean(messageID),
      ...(messageID ? { messageId: messageID } : { promptError: 'OpenCode accepted the prompt but returned no queued message' }),
    };
  };

  const pinMessage = async ({ client, sessionID, directory, input, pinned }) => {
    const messageID = asNonEmptyString(input.messageId);
    if (!messageID) throw new OpenChamberControlError('messageId is required to pin a message', 400);
    let entry = null;
    if (pinned) {
      let message;
      try {
        message = await client.session.message.get({ sessionID, messageID });
      } catch (error) {
        if (isNotFound(error)) throw new OpenChamberControlError(`Message not found: ${messageID}`, 404);
        throw error;
      }
      if (message?.type !== 'user' && message?.type !== 'assistant') {
        throw new OpenChamberControlError('Only user and assistant messages can be pinned', 400);
      }
      entry = { id: messageID, createdAt: Number(message.time?.created) || Date.now(), role: message.type };
    }
    const current = readPinnedMessages(await readMetadata(sessionID, directory));
    const next = [...current.filter((item) => item.id !== messageID), ...(entry ? [entry] : [])];
    // A merge patch replaces arrays whole, so the full list is written.
    await writeMetadata(sessionID, directory, { openchamber: { context_obligatory_messages: next } });
    return { sessionId: sessionID, pinKind: 'message', messageId: messageID, pinned, pinnedMessages: next.map((item) => item.id) };
  };

  const pin = async ({ client, sessionID, directory, input }) => {
    if (input.pinned !== undefined && input.pinned !== true && input.pinned !== false) {
      throw new OpenChamberControlError('pinned must be a boolean', 400);
    }
    const pinned = input.pinned !== false;
    const pinKind = asNonEmptyString(input.pinKind) ?? 'message';
    if (pinKind === 'message') return pinMessage({ client, sessionID, directory, input, pinned });
    if (pinKind !== 'note' && pinKind !== 'plan') {
      throw new OpenChamberControlError('pinKind must be message, note, or plan', 400);
    }
    const pinId = asNonEmptyString(input.pinId);
    if (!pinId) throw new OpenChamberControlError(`pinId is required to pin a ${pinKind}`, 400);
    if (!sessionKnowledgeRuntime) throw new OpenChamberControlError('Pinning project notes and plans is not available on this server', 503);
    const pins = await sessionKnowledgeRuntime.setPin(sessionID, directory, pinKind, pinId, pinned);
    return { sessionId: sessionID, pinKind, pinId, pinned, pins };
  };

  const abort = async ({ client, sessionID }) => ({ sessionId: sessionID, interrupted: await interrupt(client, sessionID) });

  const handlers = {
    'session.rename': rename,
    'session.subagentPolicy': setSubagentPolicy,
    'session.model': switchModel,
    'session.agent': switchAgent,
    'session.goal': goal,
    'session.retry': retry,
    'session.pin': pin,
    'session.abort': abort,
  };
  // Stopping or rewinding the session that made the call would cut off the
  // very turn waiting for this answer.
  const SELF_REFUSED = new Set(['session.retry', 'session.abort']);

  const execute = async (action, input = {}, ctx = {}) => {
    const handler = Object.hasOwn(handlers, action) ? handlers[action] : null;
    if (!handler) throw new OpenChamberControlError(`Unsupported OpenChamber action: ${action || 'missing'}`, 400);
    const contextSessionID = asNonEmptyString(ctx.contextSessionId);
    const sessionID = asNonEmptyString(input.sessionId) || contextSessionID;
    if (!sessionID) throw new OpenChamberControlError('sessionId is required', 400);
    const isCallingSession = sessionID === contextSessionID;
    if (isCallingSession && SELF_REFUSED.has(action)) {
      throw new OpenChamberControlError(`${action} cannot target the session you are running in; pass the sessionId of another session`, 400);
    }
    const directory = asNonEmptyString(await ctx.resolveSessionDirectory({ ...input, sessionId: sessionID }, ctx));
    if (!directory) throw new OpenChamberControlError(`Could not find the directory of session ${sessionID}; pass directory`, 404);
    const client = await ctx.getClient(directory);
    const result = await handler({ client, sessionID, directory, input, isCallingSession });
    return { ...result, directory };
  };

  return {
    actions: SESSION_EXTRA_ACTION_DEFINITIONS.map((definition) => definition.action),
    execute,
  };
};
