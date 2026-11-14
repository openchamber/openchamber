import { randomUUID } from 'node:crypto';

/**
 * A completed Plan turn becomes an OpenCode native form. Forms are owned by
 * OpenCode, so web, desktop and mobile all see the same pending question.
 * The server handles the special answer before the OpenCode proxy: stock
 * clients need no new action or bundled UI to transition to Build.
 */
export const PLAN_BUILD_FORM_PREFIX = 'frm_ocplan_';
const recoveryFormID = () => `${PLAN_BUILD_FORM_PREFIX}${randomUUID()}`;
const PROMPT = 'Implement the plan from the preceding Plan turn in this session. Follow its steps, make the changes, and verify the result.';
const MAX_SEEN = 2_000;

const planningAgent = (name) => /^plan(?:$|[\s_-])/i.test(name?.trim() ?? '');
const primaryAgent = (agent) => !agent.mode || agent.mode === 'primary' || agent.mode === 'all';

export const preferredBuildAgent = (agents, planningName = 'plan') => {
  const primary = agents.filter((agent) => primaryAgent(agent) && agent.id);
  const suffix = /^plan[\s_-]+(.+)$/i.exec(planningName)?.[1]?.toLowerCase();
  if (suffix) {
    const match = primary.find((agent) => /^build[\s_-]+(.+)$/i.exec(agent.id)?.[1]?.toLowerCase() === suffix);
    if (match) return match.id;
  }
  return primary.find((agent) => agent.id === 'build')?.id
    ?? primary.find((agent) => /^build[\s_-]/i.test(agent.id))?.id
    ?? null;
};

export const planBuildFields = () => [{
  key: 'decision', type: 'string', title: 'Implement this plan?', required: true,
  options: [
    { value: 'implement', label: 'Yes, implement this plan', description: 'Use the model and thinking level selected in the chat.' },
    { value: 'keep_planning', label: 'No, tell me what to change', description: 'Describe what you want changed in the plan.' },
  ],
}, {
  key: 'changes', type: 'string', title: 'What should change?', required: true,
  placeholder: 'Describe what to change in the plan...',
  when: [{ key: 'decision', op: 'eq', value: 'keep_planning' }],
}];

const formMetadata = (messageID, planAgent) => ({ openchamber: { kind: 'plan-build', messageID, planAgent } });
const isOurForm = (form, sessionID, formID) => form?.id === formID
  && form.sessionID === sessionID && form.metadata?.openchamber?.kind === 'plan-build';

export function createPlanBuildRuntime({ clientFor, resolveAutoModel = async () => null, logger = console }) {
  const seen = new Map();
  const inFlight = new Set();
  const replying = new Set();

  const remember = (id) => {
    seen.delete(id);
    seen.set(id, true);
    while (seen.size > MAX_SEEN) seen.delete(seen.keys().next().value);
  };

  const onEvent = async (payload) => {
    // The OpenChamber watcher delivers translated events, not raw v2 events.
    // Only a successful execution emits an idle without `aborted`.
    if (payload?.type !== 'session.idle' || payload.properties?.aborted === true) return;
    const sessionID = payload.properties?.sessionID;
    if (!sessionID || inFlight.has(sessionID)) return;
    inFlight.add(sessionID);
    try {
      const rootClient = clientFor();
      const session = await rootClient.session.get({ sessionID });
      if (!session || session.parentID || !planningAgent(session.agent) || session.outcome !== 'succeeded') return;
      const client = clientFor(session.location?.directory);
      const { data: messages } = await client.message.list({ sessionID, order: 'desc', limit: 10 });
      const last = messages.find((item) => item.type === 'assistant' || item.type === 'user');
      if (last?.type !== 'assistant' || !planningAgent(last.agent) || !last.time?.completed || last.finish !== 'stop') return;
      if (seen.has(last.id)) return;
      const formID = `${PLAN_BUILD_FORM_PREFIX}${last.id}`;
      const pending = await client.session.form.list({ sessionID });
      if (pending.length) return;
      // Mark this turn only after OpenCode created the form. A failed request
      // can be retried on a duplicate event without losing the question.
      await client.session.form.create({
        sessionID, id: formID, title: 'Ready to implement this plan?',
        metadata: formMetadata(last.id, session.agent), fields: planBuildFields(),
      });
      remember(last.id);
    } catch (error) {
      logger.warn('[plan-build] could not offer native question:', error?.message ?? error);
    } finally {
      inFlight.delete(sessionID);
    }
  };

  const answerForm = async ({ sessionID, formID, answer }) => {
    const client = clientFor();
    const form = await client.session.form.get({ sessionID, formID }).catch((error) => {
      if (/form not found/i.test(String(error?.message))) error.status = 404;
      throw error;
    });
    if (!isOurForm(form, sessionID, formID) || form.state?.status !== 'pending') {
      const error = new Error('Plan handoff is no longer pending'); error.status = 409; throw error;
    }
    const decision = answer?.decision;
    if (decision === 'keep_planning') {
      const changes = answer?.changes?.trim?.() ?? '';
      if (!changes) {
        const error = new Error('Describe what to change in the plan');
        error.status = 422;
        throw error;
      }
      const current = await client.session.get({ sessionID });
      if (!current) { const error = new Error('Session not found'); error.status = 404; throw error; }
      const scoped = clientFor(current.location?.directory);
      // A native agent pick is applied before form replies. Feedback stays in
      // the original Plan agent, including when the composer changed agents.
      const planned = form.metadata.openchamber.planAgent;
      const agent = planningAgent(planned) ? planned : current.agent;
      let settled = false;
      let autoModelSwitched = false;
      try {
        const routed = await resolveAutoModel({ sessionID, directory: current.location?.directory, agent, prompt: changes });
        if (routed) {
          await scoped.session.switchModel({ sessionID, model: routed });
          autoModelSwitched = true;
        }
        if (current.agent !== agent) await scoped.session.switchAgent({ sessionID, agent });
        await scoped.session.form.reply({ sessionID, formID, answer: { decision, changes } });
        settled = true;
        // Send the feedback as the next user turn so Plan can revise itself.
        await scoped.session.prompt({ sessionID, text: changes });
      } catch (error) {
        if (autoModelSwitched && current.model) {
          await scoped.session.switchModel({ sessionID, model: current.model }).catch(() => {});
        }
        // The original form stays pending if reply failed. If the reply was
        // accepted but the follow-up could not start, offer a fresh form.
        if (settled) {
          await scoped.session.form.create({
            sessionID, id: recoveryFormID(), title: form.title, metadata: form.metadata, fields: form.fields,
          }).catch((reofferError) => logger.warn('[plan-build] could not restore feedback question:', reofferError?.message ?? reofferError));
        }
        throw error;
      }
      return;
    }
    if (decision !== 'implement') {
      const error = new Error('Select how to continue the plan'); error.status = 400; throw error;
    }
    // The existing chat client applies any unsent native model and thinking
    // level selection before posting this reply (applyFormSelection). Read
    // the session now rather than capturing the model when the Plan ended.
    const session = await client.session.get({ sessionID });
    if (!session) { const error = new Error('Session not found'); error.status = 404; throw error; }
    const scoped = clientFor(session.location?.directory);
    const { data: agents } = await scoped.agent.list();
    const planAgent = planningAgent(form.metadata?.openchamber?.planAgent)
      ? form.metadata.openchamber.planAgent : session.agent;
    const build = preferredBuildAgent(agents, planAgent);
    if (!build) { const error = new Error('No Build agent is available'); error.status = 422; throw error; }
    const oldAgent = planAgent;
    let switched = false;
    let autoModelSwitched = false;
    let settled = false;
    try {
      // Auto is held by the server router, not stored as a session model.
      // Form replies use this handler before the normal Auto rewrite, so route
      // the Build request here when the composer selected Auto.
      const routed = await resolveAutoModel({ sessionID, directory: session.location?.directory, agent: build, prompt: PROMPT });
      if (routed) {
        await scoped.session.switchModel({ sessionID, model: routed });
        autoModelSwitched = true;
      }
      await scoped.session.switchAgent({ sessionID, agent: build });
      switched = true;
      await scoped.session.form.reply({ sessionID, formID, answer: { decision } });
      settled = true;
      await scoped.session.prompt({ sessionID, text: PROMPT });
    } catch (error) {
      // Before the reply the native form remains usable, so put the session
      // back in Plan. After a reply, re-offer it: the user must not lose the
      // action because an execution send failed.
      if (switched && oldAgent && !settled) {
        await scoped.session.switchAgent({ sessionID, agent: oldAgent }).catch(() => {});
      }
      if (autoModelSwitched && session.model) {
        await scoped.session.switchModel({ sessionID, model: session.model }).catch(() => {});
      }
      if (settled) {
        await scoped.session.switchAgent({ sessionID, agent: oldAgent }).catch(() => {});
        await scoped.session.form.create({
          sessionID, id: recoveryFormID(), title: form.title, metadata: form.metadata, fields: form.fields,
        }).catch((reofferError) => logger.warn('[plan-build] could not restore form:', reofferError?.message ?? reofferError));
      }
      throw error;
    }
  };

  // A pending native form is visible on every device. Two clients must not
  // execute the same answer concurrently after seeing the same question.
  const reply = async (input) => {
    const key = `${input.sessionID}/${input.formID}`;
    if (replying.has(key)) {
      const error = new Error('This plan handoff is already being submitted');
      error.status = 409;
      throw error;
    }
    replying.add(key);
    try { return await answerForm(input); }
    finally { replying.delete(key); }
  };

  return { onEvent, reply };
}

/** Installed before the generic /api proxy, including its Auto reply rewrite. */
export function registerPlanBuildRoutes(app, runtime, express) {
  app.post('/api/session/:sessionID/form/:formID/reply', (req, res, next) => {
    if (!req.params.formID.startsWith(PLAN_BUILD_FORM_PREFIX)) return next();
    express.json({ limit: '256kb' })(req, res, (error) => {
      if (error) return next(error);
      Promise.resolve(runtime.reply({ sessionID: req.params.sessionID, formID: req.params.formID, answer: req.body?.answer }))
        .then(() => res.status(204).end())
        .catch((failure) => res.status(Number.isInteger(failure?.status) ? failure.status : 502)
          .json({ error: failure?.message ?? 'Could not start Build' }));
    });
  });
}
