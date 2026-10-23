import { z } from 'zod';
import { readDispatchOutcome } from '../dispatch-results/runtime.js';
import { scanPermissions } from '../suggested-tasks/runtime.js';
import { mcpToolAliasName } from '../agent-tool/mcp-alias.js';
import { unwrapOpenCodeResponse } from '../opencode/response-envelope.js';

const selectionSchema = z.object({ providerID: z.string().min(1), modelID: z.string().min(1), variant: z.string().optional(), agent: z.string().optional() });
const pageSchema = z.object({ data: z.array(z.json()) });
const createdSchema = z.object({ sessionId: z.string().min(1), directory: z.string().min(1) });

export const botStagePermissions = (stage, bot) => {
  if (stage !== 'fixing') return scanPermissions(bot.web, bot.mcp);
  const rules = [
    { action: '*_*', resource: '*', effect: 'deny' },
    { action: 'apply_patch', resource: '*', effect: 'allow' },
    { action: 'openchamber_bot', resource: '*', effect: 'allow' },
  ];
  for (const { server, tools } of bot.correctionMcp) {
    for (const [tool, effect] of Object.entries(tools)) {
      const action = `${server.replace(/[^A-Za-z0-9_-]/g, '_')}_${tool.replace(/[^A-Za-z0-9_-]/g, '_')}`;
      if (!action.startsWith('openchamber_')) rules.push(
        { action, resource: '*', effect },
        { action: mcpToolAliasName(action), resource: '*', effect },
      );
    }
  }
  return [...rules,
    { action: 'shell', resource: 'gh *', effect: 'deny' },
    { action: 'shell', resource: 'git push*', effect: 'deny' },
  ];
};

const requireFunction = (value, name) => { if (!(value instanceof Function)) throw new TypeError(`${name} is required`); };

/** Session creation and dispatch are separate durable coordinator effects. */
export const createBotStageSessions = ({ sessionService, clientFor, permissionAutoAcceptRuntime, sessionKnowledgeRuntime, activityProbe, readSessionDefaults, readTokenSnapshot, isolated }) => {
  for (const [name, value] of Object.entries({ create: sessionService?.create, send: sessionService?.send, clientFor, setSessionPolicy: permissionAutoAcceptRuntime?.setSessionPolicy, sync: sessionKnowledgeRuntime?.sync, fetchActiveSessionStatuses: activityProbe?.fetchActiveSessionStatuses, hasWorkingChildren: activityProbe?.hasWorkingChildren, readSessionDefaults, readTokenSnapshot, isolatedCreate: isolated?.create, isolatedDispatch: isolated?.dispatch, isolatedOutcome: isolated?.outcome, isolatedReconcile: isolated?.reconcile, isolatedStop: isolated?.stop })) requireFunction(value, name);
  const select = async (projectId, bot, stage) => selectionSchema.parse(bot.models[stage].useDefaults ? await readSessionDefaults(projectId) : bot.models[stage]);
  const configure = async ({ bot, stage, sessionId, directory }) => {
    await clientFor(directory).session.update({ sessionID: sessionId, permissions: botStagePermissions(stage, bot) });
    if (stage !== 'fixing' || bot.permissionMode !== 'default') await permissionAutoAcceptRuntime.setSessionPolicy(sessionId, stage === 'fixing' ? bot.permissionMode : 'ask', directory);
    await sessionKnowledgeRuntime.sync(sessionId, directory, { includeMemorySaveRule: stage === 'fixing' });
  };
  const create = async (request, onCreated) => {
    if (request.bot.isolated) return isolated.create(request, onCreated);
    const result = await sessionService.create({ directory: request.directory, title: `${request.bot.name}: ${request.stage}` }, {
      metadata: { openchamber: { kind: 'scheduled', automation: { source: 'bot', projectId: request.projectId, botId: request.bot.id, itemId: request.itemId, stage: request.stage, notify: request.bot.notify } } },
      onSessionCreated: async (created) => {
        const parsed = createdSchema.parse(created);
        await onCreated(parsed);
        await configure({ ...request, ...parsed });
      },
    });
    return createdSchema.parse(result);
  };
  const dispatch = async (request) => {
    if (request.bot.isolated) return isolated.dispatch(request);
    // Reinstall policy on restart before a previously prepared prompt may send.
    await configure(request);
    const { providerID, modelID, agent, variant } = selectionSchema.parse(request.selection);
    const input = { directory: request.directory, prompt: request.prompt, model: `${providerID}/${modelID}` };
    if (agent) input.agent = agent;
    if (variant) input.variant = variant;
    if (request.stage === 'fixing' && request.bot.goalTokenBudget) {
      input.goal = true;
      input.goalTokenBudget = request.bot.goalTokenBudget;
    }
    const result = await sessionService.send(request.sessionId, input);
    if (!result.promptDispatched) throw new Error('Bot prompt admission was not confirmed');
    return { id: request.sessionId, sessionId: request.sessionId };
  };
  const outcome = async (request) => {
    if (request.bot.isolated) return isolated.outcome(request);
    const statuses = await activityProbe.fetchActiveSessionStatuses();
    if (statuses === null) throw new Error('Bot session activity is unavailable');
    if (statuses[request.sessionId]) return null;
    const children = await activityProbe.hasWorkingChildren(request.sessionId, statuses);
    if (children === null) throw new Error('Bot child session activity is unavailable');
    if (children) return null;
    const records = pageSchema.parse(await clientFor(request.directory).message.list({ sessionID: request.sessionId, limit: 100, order: 'desc' })).data;
    const result = readDispatchOutcome(records, request.dispatchedAt, request.afterIdleId);
    if (!result) return null;
    const tokens = z.number().int().nonnegative().parse(await readTokenSnapshot(request.sessionId, request.directory, { since: 0 }));
    return { ...result, tokens };
  };
  const reconcile = async (kind, request, recordedSessionId) => {
    if (request.bot.isolated) return isolated.reconcile(kind, request, recordedSessionId);
    if (kind === 'session.create' && recordedSessionId) {
      const info = unwrapOpenCodeResponse(await clientFor(request.directory).session.get({ sessionID: recordedSessionId }));
      const marker = info.metadata?.openchamber?.automation;
      if (marker?.source === 'bot' && marker.itemId === request.itemId && marker.stage === request.stage && marker.botId === request.bot.id) return { state: 'succeeded', result: { id: recordedSessionId, sessionId: recordedSessionId } };
    }
    if (kind === 'session.prompt') {
      const result = await outcome(request);
      if (result) return { state: 'succeeded', result: { id: request.sessionId, sessionId: request.sessionId } };
    }
    return { state: 'outcome-unknown' };
  };
  const stop = async (request) => {
    if (request.bot.isolated) return isolated.stop(request);
    await clientFor(request.directory).session.interrupt({ sessionID: request.sessionId });
    const statuses = await activityProbe.fetchActiveSessionStatuses();
    if (statuses === null || statuses[request.sessionId] || await activityProbe.hasWorkingChildren(request.sessionId, statuses) !== false) throw new Error('Bot session has not authoritatively stopped');
  };
  // This hook is exclusive to the coordinator's explicit Resume transition.
  // Host stages need no container recovery; ordinary dispatch never calls it.
  const resume = async (request) => {
    if (request.bot.isolated) {
      requireFunction(isolated.resume, 'isolatedResume');
      await isolated.resume(request);
    }
  };
  return { select, create, dispatch, outcome, reconcile, stop, resume };
};
