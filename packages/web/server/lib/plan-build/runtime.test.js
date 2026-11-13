import { test, expect } from 'bun:test';
import express from 'express';
import request from 'supertest';
import { createPlanBuildRuntime, preferredBuildAgent, planBuildFields, PLAN_BUILD_FORM_PREFIX, registerPlanBuildRoutes } from './runtime.js';

const sessionID = 'ses_test';
const assistantID = 'msg_finished_plan';
const formID = `${PLAN_BUILD_FORM_PREFIX}${assistantID}`;
const models = [
  { providerID: 'opencode', id: 'planning-model', name: 'Planning Model', enabled: true },
  { providerID: 'opencode', id: 'build-model', name: 'Build Model', enabled: true },
  { providerID: 'other', id: 'offline', name: 'Offline', enabled: false },
];

const fixture = () => {
  const calls = [];
  let fail = null;
  let form = null;
  let routedModel = null;
  let record = { id: sessionID, agent: 'plan', model: { providerID: 'opencode', id: 'planning-model' }, outcome: 'succeeded', location: { directory: '/test/repo' } };
  let messages = [
    { id: 'idle_1', type: 'idle', time: { created: 21 } },
    { id: assistantID, type: 'assistant', agent: 'plan', finish: 'stop', time: { completed: 20 } },
    { id: 'user_1', type: 'user', text: 'Plan an implementation' },
  ];
  const invoke = async (name, output) => {
    calls.push(name);
    if (fail === name) { fail = null; throw new Error(`injected ${name} failure`); }
    return output;
  };
  const api = {
    session: {
      get: async () => invoke('get', record),
      switchAgent: async ({ agent }) => { await invoke(`switchAgent:${agent}`); record = { ...record, agent }; },
      switchModel: async ({ model }) => { await invoke(`switchModel:${model.providerID}/${model.id}`); record = { ...record, model }; },
      prompt: async ({ text }) => invoke('prompt', text),
      form: {
        list: async () => invoke('form.list', form ? [form] : []),
        create: async (input) => { await invoke('form.create'); form = { ...input, id: input.id ?? `frm_retry_${calls.length}`, state: { status: 'pending' } }; return form; },
        get: async () => invoke('form.get', form),
        reply: async ({ answer }) => { await invoke(`form.reply:${answer.decision}`); form = { ...form, state: { status: 'replied' } }; },
      },
    },
    message: { list: async () => invoke('message.list', { data: messages, cursor: {} }) },
    agent: { list: async () => invoke('agent.list', { location: {}, data: [{ id: 'plan', name: 'Plan', mode: 'primary' }, { id: 'build', name: 'Build', mode: 'primary' }] }) },
    model: { list: async () => invoke('model.list', { location: {}, data: models }) },
  };
  const runtime = createPlanBuildRuntime({ clientFor: (directory) => { if (directory && directory !== '/test/repo') throw Error('wrong directory'); return api; }, resolveAutoModel: async () => { if (!routedModel) return null; calls.push('routeAutoModel'); return routedModel; }, logger: { warn: () => {} } });
  return { runtime, calls, get form() { return form; }, set form(value) { form = value; }, get record() { return record; }, set record(value) { record = value; }, set messages(value) { messages = value; }, failAt(value) { fail = value; }, routeTo(model) { routedModel = model; } };
};
const succeeded = { type: 'session.idle', properties: { sessionID } };

test('the completed plan produces exactly one native form, even on duplicate events', async () => {
  const ctx = fixture();
  await ctx.runtime.onEvent(succeeded);
  expect(ctx.form.id).toBe(formID);
  expect(ctx.form.title).toBe('Ready to implement this plan?');
  expect(ctx.form.metadata.openchamber.messageID).toBe(assistantID);
  expect(ctx.form.metadata.openchamber.planAgent).toBe('plan');
  expect(ctx.form.fields).toHaveLength(2);
  expect(ctx.form.fields[0].options.map((o) => o.value)).toEqual(['implement', 'keep_planning']);
  expect(ctx.form.fields[1]).toMatchObject({ key: 'changes', type: 'string', required: true, when: [{ key: 'decision', op: 'eq', value: 'keep_planning' }] });
  await ctx.runtime.onEvent(succeeded);
  expect(ctx.calls.filter((call) => call === 'form.create')).toHaveLength(1);
});

test('no form is offered for non-Plan, child, failed, or unfinished turns', async () => {
  for (const modify of [
    (ctx) => { ctx.record = { ...ctx.record, agent: 'build' }; },
    (ctx) => { ctx.record = { ...ctx.record, parentID: 'ses_parent' }; },
    (ctx) => { ctx.record = { ...ctx.record, outcome: 'interrupted' }; },
    (ctx) => { ctx.messages = [{ id: 'user-last', type: 'user' }]; },
    (ctx) => { ctx.messages = [{ id: assistantID, type: 'assistant', agent: 'plan', finish: 'tool-calls', time: { completed: 1 } }]; },
  ]) {
    const ctx = fixture(); modify(ctx);
    await ctx.runtime.onEvent(succeeded);
    expect(ctx.form).toBeNull();
  }
});

test('failed form creation may be retried; existing questions suppress duplicates', async () => {
  const ctx = fixture();
  ctx.failAt('form.create');
  await ctx.runtime.onEvent(succeeded);
  expect(ctx.form).toBeNull();
  await ctx.runtime.onEvent(succeeded);
  expect(ctx.form?.id).toBe(formID);
  const other = fixture();
  other.form = { id: 'frm_other', sessionID };
  await other.runtime.onEvent(succeeded);
  expect(other.form.id).toBe('frm_other');
});

test('one answer switches to Build using existing model and starts the prompt', async () => {
  const ctx = fixture();
  await ctx.runtime.onEvent(succeeded);
  ctx.calls.length = 0;
  await ctx.runtime.reply({ sessionID, formID, answer: { decision: 'implement' } });
  expect(ctx.record.agent).toBe('build');
  expect(ctx.record.model.id).toBe('planning-model');
  expect(ctx.calls).toEqual(['form.get', 'get', 'agent.list', 'switchAgent:build', 'form.reply:implement', 'prompt']);
  expect(ctx.form.state.status).toBe('replied');
});

test('native picker model and thinking level selected before approval are used for Build', async () => {
  const ctx = fixture();
  await ctx.runtime.onEvent(succeeded);
  // Stock clients apply their composer selection before submitting a form.
  ctx.record = { ...ctx.record, model: { providerID: 'opencode', id: 'build-model', variant: 'max' } };
  ctx.calls.length = 0;
  await ctx.runtime.reply({ sessionID, formID, answer: { decision: 'implement' } });
  expect(ctx.record.agent).toBe('build');
  expect(ctx.record.model).toEqual({ providerID: 'opencode', id: 'build-model', variant: 'max' });
  expect(ctx.calls).toEqual(['form.get', 'get', 'agent.list', 'switchAgent:build', 'form.reply:implement', 'prompt']);
});

test('invalid decisions do not switch the agent or settle the form', async () => {
  const ctx = fixture();
  await ctx.runtime.onEvent(succeeded);
  await expect(ctx.runtime.reply({ sessionID, formID, answer: { decision: 'change_model' } })).rejects.toThrow('Select how to continue');
  expect(ctx.form.state.status).toBe('pending');
  expect(ctx.record.agent).toBe('plan');
});

test('No requires feedback and sends it as the next Plan turn', async () => {
  const ctx = fixture();
  await ctx.runtime.onEvent(succeeded);
  ctx.calls.length = 0;
  await ctx.runtime.reply({ sessionID, formID, answer: { decision: 'keep_planning', changes: '  Add an accessibility check  ' } });
  expect(ctx.calls).toEqual(['form.get', 'get', 'form.reply:keep_planning', 'prompt']);
  expect(ctx.record.agent).toBe('plan');
  expect(ctx.form.state.status).toBe('replied');
});

test('No without typed changes leaves the form pending', async () => {
  for (const changes of [undefined, '', '   ', 25]) {
    const ctx = fixture();
    await ctx.runtime.onEvent(succeeded);
    ctx.calls.length = 0;
    await expect(ctx.runtime.reply({ sessionID, formID, answer: { decision: 'keep_planning', changes } })).rejects.toThrow('Describe what to change');
    expect(ctx.calls).toEqual(['form.get']);
    expect(ctx.record.agent).toBe('plan');
    expect(ctx.form.state.status).toBe('pending');
  }
});

test('No restores Plan before sending feedback when the native composer agent changed', async () => {
  const ctx = fixture();
  await ctx.runtime.onEvent(succeeded);
  ctx.record = { ...ctx.record, agent: 'build', model: { providerID: 'opencode', id: 'build-model', variant: 'high' } };
  ctx.calls.length = 0;
  await ctx.runtime.reply({ sessionID, formID, answer: { decision: 'keep_planning', changes: 'Revise the acceptance tests' } });
  expect(ctx.record.agent).toBe('plan');
  expect(ctx.record.model).toEqual({ providerID: 'opencode', id: 'build-model', variant: 'high' });
  expect(ctx.calls).toEqual(['form.get', 'get', 'switchAgent:plan', 'form.reply:keep_planning', 'prompt']);
});

test('No feedback failure does not lose the native question', async () => {
  const ctx = fixture();
  await ctx.runtime.onEvent(succeeded);
  ctx.failAt('form.reply:keep_planning');
  await expect(ctx.runtime.reply({ sessionID, formID, answer: { decision: 'keep_planning', changes: 'Simplify the plan' } })).rejects.toThrow('injected');
  expect(ctx.form.state.status).toBe('pending');
  ctx.failAt('prompt');
  await expect(ctx.runtime.reply({ sessionID, formID, answer: { decision: 'keep_planning', changes: 'Simplify the plan' } })).rejects.toThrow('injected');
  expect(ctx.form.state.status).toBe('pending');
  expect(ctx.form.id).not.toBe(formID);
  expect(ctx.record.agent).toBe('plan');
});

test('No uses the native Auto selection to revise Plan with a routed model', async () => {
  const ctx = fixture();
  await ctx.runtime.onEvent(succeeded);
  ctx.routeTo({ providerID: 'opencode', id: 'build-model', variant: 'max' });
  ctx.calls.length = 0;
  await ctx.runtime.reply({ sessionID, formID, answer: { decision: 'keep_planning', changes: 'Add a review step' } });
  expect(ctx.record.agent).toBe('plan');
  expect(ctx.record.model).toEqual({ providerID: 'opencode', id: 'build-model', variant: 'max' });
  expect(ctx.calls).toEqual(['form.get', 'get', 'routeAutoModel', 'switchModel:opencode/build-model', 'form.reply:keep_planning', 'prompt']);
});

test('Auto chosen in the native picker resolves Build model before approval', async () => {
  const ctx = fixture();
  await ctx.runtime.onEvent(succeeded);
  ctx.routeTo({ providerID: 'opencode', id: 'build-model', variant: 'high' });
  ctx.calls.length = 0;
  await ctx.runtime.reply({ sessionID, formID, answer: { decision: 'implement' } });
  expect(ctx.record.model).toEqual({ providerID: 'opencode', id: 'build-model', variant: 'high' });
  expect(ctx.calls).toEqual(['form.get', 'get', 'agent.list', 'routeAutoModel', 'switchModel:opencode/build-model', 'switchAgent:build', 'form.reply:implement', 'prompt']);
});

test('Auto model switch failure preserves the pending question and old model', async () => {
  const ctx = fixture();
  await ctx.runtime.onEvent(succeeded);
  ctx.routeTo({ providerID: 'opencode', id: 'build-model', variant: 'max' });
  ctx.failAt('form.reply:implement');
  await expect(ctx.runtime.reply({ sessionID, formID, answer: { decision: 'implement' } })).rejects.toThrow('injected');
  expect(ctx.record.model).toEqual({ providerID: 'opencode', id: 'planning-model' });
  expect(ctx.record.agent).toBe('plan');
  expect(ctx.form.state.status).toBe('pending');
});

test('switch or submit failure leaves a usable form and restores Plan agent', async () => {
  const ctx = fixture();
  await ctx.runtime.onEvent(succeeded);
  ctx.failAt('form.reply:implement');
  await expect(ctx.runtime.reply({ sessionID, formID, answer: { decision: 'implement' } })).rejects.toThrow('injected');
  expect(ctx.record.agent).toBe('plan');
  expect(ctx.form.state.status).toBe('pending');
  ctx.failAt('prompt');
  await expect(ctx.runtime.reply({ sessionID, formID, answer: { decision: 'implement' } })).rejects.toThrow('injected');
  expect(ctx.record.agent).toBe('plan');
  expect(ctx.form.state.status).toBe('pending');
  expect(ctx.form.id).not.toBe(formID);
});

test('custom Build agents keep their planning model counterpart', () => {
  expect(preferredBuildAgent([{ id: 'Plan - Gemini', name: 'Plan - Gemini', mode: 'primary' }, { id: 'Build - Gemini', name: 'Build - Gemini', mode: 'primary' }], 'Plan - Gemini')).toBe('Build - Gemini');
  expect(preferredBuildAgent([{ id: 'plan', name: 'Plan', mode: 'primary' }, { id: 'compaction', name: 'Compaction', mode: 'primary' }])).toBeNull();
  expect(preferredBuildAgent([{ id: 'plan', name: 'Plan', mode: 'primary' }, { id: 'ask', name: 'Ask', mode: 'primary' }])).toBeNull();
  expect(planBuildFields()).toHaveLength(2);
});

test('HTTP native form answers are handled before generic proxy; ordinary forms pass through', async () => {
  const ctx = fixture();
  await ctx.runtime.onEvent(succeeded);
  const app = express();
  registerPlanBuildRoutes(app, ctx.runtime, express);
  app.post('/api/session/:sessionID/form/:formID/reply', (_req, res) => res.json({ normal: true }));
  const ordinary = await request(app).post('/api/session/ses_test/form/frm_other/reply').send({ answer: { decision: 'implement' } });
  expect(ordinary.body).toEqual({ normal: true });
  const invalid = await request(app).post(`/api/session/${sessionID}/form/${formID}/reply`).send({ answer: { decision: 'invalid' } });
  expect(invalid.status).toBe(400);
  const ok = await request(app).post(`/api/session/${sessionID}/form/${formID}/reply`).send({ answer: { decision: 'implement' } });
  expect(ok.status).toBe(204);
  expect(ok.text).toBe('');
  expect(ctx.record.agent).toBe('build');
});

test('simultaneous replies from different devices run Build only once', async () => {
  const ctx = fixture();
  await ctx.runtime.onEvent(succeeded);
  ctx.calls.length = 0;
  const results = await Promise.allSettled([
    ctx.runtime.reply({ sessionID, formID, answer: { decision: 'implement' } }),
    ctx.runtime.reply({ sessionID, formID, answer: { decision: 'implement' } }),
  ]);
  expect(results.map((entry) => entry.status).sort()).toEqual(['fulfilled', 'rejected']);
  expect(ctx.calls.filter((call) => call === 'prompt')).toHaveLength(1);
});

test('model catalogue is unnecessary to show the question, even if it is unavailable', async () => {
  const ctx = fixture();
  ctx.failAt('model.list');
  await ctx.runtime.onEvent(succeeded);
  expect(ctx.form.fields).toHaveLength(2);
  expect(ctx.calls).not.toContain('model.list');
});

test('existing client shows feedback text only after No and requires its answer', async () => {
  const { initialFormValues, visibleFields, missingRequiredKeys, buildFormAnswer } = await import('../../../../ui/src/components/chat/formCardState.ts');
  const fields = planBuildFields();
  const values = initialFormValues(fields);
  expect(visibleFields(fields, values).map((field) => field.key)).toEqual(['decision']);
  values.decision.selected = ['implement'];
  expect(visibleFields(fields, values)).toHaveLength(1);
  expect(missingRequiredKeys(fields, values)).toEqual([]);
  expect(buildFormAnswer(fields, values)).toEqual({ decision: 'implement' });
  values.decision.selected = ['keep_planning'];
  expect(visibleFields(fields, values).map((field) => field.key)).toEqual(['decision', 'changes']);
  expect(missingRequiredKeys(fields, values)).toEqual(['changes']);
  expect(buildFormAnswer(fields, values)).toEqual({ decision: 'keep_planning' });
  values.changes.text = 'Make the plan simpler';
  expect(missingRequiredKeys(fields, values)).toEqual([]);
  expect(buildFormAnswer(fields, values)).toEqual({ decision: 'keep_planning', changes: 'Make the plan simpler' });
});
