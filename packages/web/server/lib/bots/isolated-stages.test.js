import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Readable } from 'node:stream';
import { afterEach, expect, it } from 'vitest';
import { createBotIsolatedStages } from './isolated-stages.js';
import { botDefinitionSchema } from './config.js';
import { digestMutationInput } from '../source-control/mutation-executor.js';

const roots = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
const setup = async (options = {}) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'isolated-bot-')); roots.push(dataDir);
  const bot = botDefinitionSchema.parse({ id: 'b', name: 'Bot', mission: 'Fix', isolated: true, space: options.space });
  const request = { projectId: 'p', itemId: 'i', directory: '/host/worktree', bot, stage: 'investigation', prompt: 'Inspect',
    selection: { providerID: 'chosen', modelID: 'model', agent: 'build', variant: 'high' }, dispatchedAt: 12, afterIdleId: null };
  const calls = []; const sessions = new Map(); let stopped = false; let removed = false; let granted = true; let available = true; let toolRequests = []; let failSettlement = false;
  const host = { journey: {
    createBotSpace: async (value, options) => { calls.push(['space', value, options.sourceDirectory]); await options.onAllocated({ id: 'abcdef123456', directory: '/spaces/abcdef123456/worktree' }); },
    listSpaces: async () => removed ? [] : [{ id: 'abcdef123456', state: stopped ? 'exited' : 'running', access: granted ? 'granted' : 'needs_access', grants: [{ provider: 'chosen' }], damaged: false }],
    stopSpace: async () => { calls.push(['stop']); if (removed) throw Object.assign(new Error('Removed'), { code: 'space_not_found' }); stopped = true; granted = false; },
    startSpace: async (id) => { calls.push(['start', id]); if (removed) throw new Error('Removed'); stopped = false; return { networkRestored: true }; },
    grantAccess: async (id, grant) => { calls.push(['grant', id, grant]); granted = true; },
    removeSpace: async (id) => { calls.push(['remove', id]); removed = true; return { removed: true, failures: [] }; },
    readHostLogins: async () => ({ logins: [{ provider: 'chosen', state: 'usable' }] }),
    readHostCustomProviders: async () => ({ providers: [] }),
  }, manager: { listAllSpaces: async () => ({ spaces: await host.journey.listSpaces(), unavailable: [] }), verify: async () => [], exec: async (id, argv, options) => {
    calls.push(['exec', id, argv, options]);
    const input = JSON.parse(options.stdin);
    return { code: 0, stdout: JSON.stringify({ status: 'passed', testSha: input.testSha, fixSha: input.fixSha, command: input.command, args: input.args, testExitCode: 1, fixExitCode: 0 }) };
  } }, dispatcher: { requestInside: async (_space, value) => {
    calls.push(['request', value]);
    const body = value.body ? JSON.parse(String(value.body)) : null;
    let result = {};
    if (value.path === '/api/session' && value.method === 'POST') {
      const id = body.id; result = { ...body, id }; sessions.set(id, result);
    } else if (/\/api\/session\/ses_[^/]+$/.test(value.path) && value.method === 'GET') result = sessions.get(value.path.split('/').at(-1));
    if (value.path.startsWith('/api/openchamber/bots/isolated-tools?')) result = { requests: toolRequests };
    if (value.path.endsWith('/isolated-tools/settle')) { if (!failSettlement) toolRequests = []; result = { settled: !failSettlement }; }
    const wire = value.path.includes('/isolated-tools') ? result : options.nestedRecords ? { data: { data: result } } : { data: result };
    const response = Readable.from([Buffer.from(JSON.stringify(wire))]);
    response.statusCode = value.method === 'PATCH' || /\/(?:model|agent)$/.test(value.path) || value.path.includes('/instructions/entry/') ? 204 : 200; response.complete = true;
    if (value.path.endsWith('/isolated-tools/settle') && failSettlement) response.statusCode = 503;
    return response;
  } } };
  const build = (create = createBotIsolatedStages) => create({ dataDir, getSpacesHost: () => available ? host : null,
    resolveProject: async () => ({ id: 'p', path: '/host/project' }), resolveSpaceOptions: options.resolveSpaceOptions,
    sessionKnowledgeRuntime: { collect: async () => ({ notes: [], plans: [], memory: { global: [], project: [], enabled: false, complete: true } }) },
    handleTool: async (request) => { calls.push(['host-tool', request]); return { receipt: { id: 'receipt' } }; },
  });
  return { request, dataDir, calls, build, host, disable: () => { available = false; }, tools: (value) => { toolRequests = value; }, failSettlement: (value) => { failSettlement = value; } };
};

it('creates one recorded space with code-in and selected grants, then uses its SDK transport', async () => {
  const fixture = await setup(); const adapter = fixture.build();
  const created = await adapter.create(fixture.request, async (value) => { fixture.calls.push(['recorded', value]); });
  await adapter.dispatch({ ...fixture.request, sessionId: created.sessionId });
  expect(fixture.calls.find(([name]) => name === 'space')).toMatchObject(['space', { projectDirectory: '/host/project', start: 'clean', grants: [{ kind: 'login', provider: 'chosen' }] }, '/host/worktree']);
  const switched = fixture.calls.find(([name, value]) => name === 'request' && value.path.includes('/model'));
  expect(JSON.parse(String(switched[1].body))).toEqual({ model: { providerID: 'chosen', id: 'model', variant: 'high' } });
  const prompt = fixture.calls.findIndex(([name, value]) => name === 'request' && value.path.includes('/prompt'));
  expect(prompt).toBeGreaterThan(fixture.calls.findIndex(([name]) => name === 'recorded'));
  expect(fixture.calls.filter(([name]) => name === 'request').every(([, value]) => !value.headers.authorization)).toBe(true);
  const restarted = fixture.build();
  expect(await restarted.reconcile('session.create', fixture.request, created.sessionId)).toMatchObject({ state: 'succeeded' });
  expect(fixture.calls.filter(([name]) => name === 'space')).toHaveLength(1);
});

it('executes proof snapshots only inside the recorded space and confirms container stop', async () => {
  const fixture = await setup(); const adapter = fixture.build();
  const created = await adapter.create(fixture.request, async () => {});
  const input = { directory: '/host/worktree', isolated: true, testSha: 'a'.repeat(40), fixSha: 'b'.repeat(40), command: 'node', args: ['--test', '{files}'] };
  expect(await adapter.executeIsolatedProof(input)).toMatchObject({ status: 'passed', testExitCode: 1, fixExitCode: 0 });
  const exec = fixture.calls.find(([name]) => name === 'exec');
  expect(exec[1]).toBe('abcdef123456');
  expect(JSON.parse(exec[3].stdin).directory).toBe('/spaces/abcdef123456/worktree');
  await adapter.stop({ sessionId: created.sessionId });
  await expect(adapter.dispatch({ ...fixture.request, sessionId: created.sessionId })).rejects.toMatchObject({ code: 'BOT_ISOLATED_CREATE_UNKNOWN' });
});

it('explicitly resumes the same interrupted binding and session through fresh stage owners', async () => {
  const fixture = await setup({ space: { grants: [{ kind: 'custom', provider: 'chosen' }] }, resolveSpaceOptions: async () => ({ grants: [{ kind: 'custom', provider: 'chosen' }] }) });
  const adapter = fixture.build();
  const created = await adapter.create(fixture.request, async () => {});
  const request = { ...fixture.request, sessionId: created.sessionId };
  await adapter.dispatch(request);
  await adapter.stop(request);
  const restarted = fixture.build();
  await expect(restarted.dispatch(request)).rejects.toMatchObject({ code: 'BOT_ISOLATED_CREATE_UNKNOWN' });
  expect(fixture.calls.filter(([name]) => name === 'start')).toHaveLength(0);
  fixture.host.journey.readHostLogins = fixture.host.journey.readHostCustomProviders = async () => { throw new Error('Ambient credentials must not be read'); };
  await expect(restarted.resume({ ...request, bot: { ...request.bot, space: { grants: [] } } })).rejects.toMatchObject({ code: 'BOT_ISOLATED_MODEL_GRANT_REQUIRED' });
  await expect(restarted.resume({ ...request, sessionId: 'ses_foreign' })).rejects.toMatchObject({ code: 'BOT_ISOLATED_SESSION_MISMATCH' });
  expect(fixture.calls.filter(([name]) => name === 'start')).toHaveLength(0);
  await restarted.resume(request);
  await restarted.dispatch(request);
  expect(fixture.calls.filter(([name]) => name === 'space')).toHaveLength(1);
  expect(fixture.calls.filter(([name]) => name === 'start')).toEqual([['start', 'abcdef123456']]);
  expect(fixture.calls.filter(([name]) => name === 'grant')).toEqual([['grant', 'abcdef123456', { kind: 'custom', provider: 'chosen' }]]);
  expect(await restarted.readBinding(request)).toMatchObject({ state: 'ready', spaceId: 'abcdef123456', sessions: { [digestMutationInput({ stage: request.stage, dispatchedAt: request.dispatchedAt, prompt: request.prompt })]: { id: created.sessionId } } });
  const prompts = fixture.calls.filter(([name, input]) => name === 'request' && input.path.endsWith('/prompt'));
  expect(prompts).toHaveLength(2);
  expect(prompts.every(([, input]) => input.path.includes(created.sessionId))).toBe(true);
});

it('keeps failed resume readiness, network, grant and verification closed until explicit retry', async () => {
  const fixture = await setup({ space: { grants: [{ kind: 'custom', provider: 'chosen' }] }, resolveSpaceOptions: async () => ({ grants: [{ kind: 'custom', provider: 'chosen' }] }) });
  const adapter = fixture.build(); const created = await adapter.create(fixture.request, async () => {});
  const request = { ...fixture.request, sessionId: created.sessionId };
  await adapter.stop(request);
  const start = fixture.host.journey.startSpace; const grant = fixture.host.journey.grantAccess;
  for (const failure of ['readiness', 'network', 'grant', 'verification']) {
    fixture.host.journey.startSpace = failure === 'readiness' ? async () => { throw new Error('Server not ready'); }
      : failure === 'network' ? async () => ({ networkRestored: false }) : start;
    fixture.host.journey.grantAccess = failure === 'grant' ? async () => { throw new Error('Selected grant unavailable'); } : grant;
    fixture.host.manager.verify = async () => failure === 'verification' ? [{ check: 'gatekeeper_missing' }] : [];
    await expect(fixture.build().resume(request)).rejects.toThrow();
    await expect(fixture.build().dispatch(request)).rejects.toMatchObject({ code: 'BOT_ISOLATED_CREATE_UNKNOWN' });
  }
  fixture.host.journey.startSpace = start; fixture.host.journey.grantAccess = grant; fixture.host.manager.verify = async () => [];
  await fixture.build().resume(request);
  await fixture.build().dispatch(request);
  expect(fixture.calls.filter(([name]) => name === 'space')).toHaveLength(1);
});

it('journals removal before the journey and read-reconciles a lost successful receipt before another Stop', async () => {
  const fixture = await setup(); const adapter = fixture.build();
  const created = await adapter.create(fixture.request, async () => {});
  const request = { project: { id: 'p' }, bot: fixture.request.bot, item: { id: 'i', worktree: '/host/worktree' } };
  await adapter.stop({ sessionId: created.sessionId });
  const remove = fixture.host.journey.removeSpace;
  fixture.host.journey.removeSpace = async (id) => {
    expect((await fixture.build().readBinding(fixture.request)).state).toBe('removing');
    await remove(id);
    throw new Error('Lost journey acknowledgement');
  };
  await expect(adapter.remove(request)).rejects.toThrow('Lost journey acknowledgement');
  expect((await fixture.build().readBinding(fixture.request)).state).toBe('removing');
  await fixture.build().stop({ sessionId: created.sessionId });
  await fixture.build().remove(request);
  await fixture.build().stop({ sessionId: created.sessionId });
  expect((await fixture.build().readBinding(fixture.request)).state).toBe('removed');
  expect(fixture.calls.filter(([name]) => name === 'stop')).toHaveLength(1);
  expect(fixture.calls.filter(([name]) => name === 'remove')).toHaveLength(1);
  await expect(fixture.build().resume({ ...fixture.request, sessionId: created.sessionId })).rejects.toThrow();
  fixture.disable();
  await fixture.build().stop({ sessionId: created.sessionId });
});

it('recovers a failed removal receipt write and refuses absence without a durable removal intent', async () => {
  const fixture = await setup(); const adapter = fixture.build();
  const created = await adapter.create(fixture.request, async () => {});
  const request = { project: { id: 'p' }, bot: fixture.request.bot, item: { id: 'i', worktree: '/host/worktree' } };
  const file = path.join(fixture.dataDir, 'bots/isolated-stages', `${digestMutationInput({ projectId: 'p', itemId: 'i' })}.json`);
  const remove = fixture.host.journey.removeSpace;
  fixture.host.journey.removeSpace = async (id) => {
    const result = await remove(id);
    await fs.rename(file, `${file}.saved`); await fs.mkdir(file);
    return result;
  };
  await expect(adapter.remove(request)).rejects.toThrow();
  await fs.rmdir(file); await fs.rename(`${file}.saved`, file);
  expect((await fixture.build().readBinding(fixture.request)).state).toBe('removing');
  fixture.host.manager.listAllSpaces = async () => ({ spaces: [], unavailable: [{ placeId: 'offline' }] });
  await expect(fixture.build().stop({ sessionId: created.sessionId })).rejects.toMatchObject({ code: 'BOT_ISOLATED_REMOVE_UNCONFIRMED' });
  fixture.host.manager.listAllSpaces = async () => ({ spaces: [], unavailable: [] });
  await fixture.build().stop({ sessionId: created.sessionId });
  await fixture.build().remove(request);
  expect((await fixture.build().readBinding(fixture.request)).state).toBe('removed');
  const binding = await fixture.build().readBinding(fixture.request);
  await fs.writeFile(file, JSON.stringify({ ...binding, state: 'stopped' }));
  await expect(fixture.build().stop({ sessionId: created.sessionId })).rejects.toMatchObject({ code: 'BOT_ISOLATED_STOP_UNCONFIRMED' });
});

it('records interruption before stopping and retries it after a lost stop acknowledgement', async () => {
  const fixture = await setup(); const adapter = fixture.build();
  const created = await adapter.create(fixture.request, async () => {});
  const stop = fixture.host.journey.stopSpace;
  fixture.host.journey.stopSpace = async (id) => { await stop(id); throw new Error('Lost stop acknowledgement'); };
  await expect(adapter.stop({ sessionId: created.sessionId })).rejects.toThrow('Lost stop acknowledgement');
  expect((await fixture.build().readBinding(fixture.request)).state).toBe('stopping');
  await expect(fixture.build().dispatch({ ...fixture.request, sessionId: created.sessionId })).rejects.toMatchObject({ code: 'BOT_ISOLATED_CREATE_UNKNOWN' });
  fixture.host.journey.stopSpace = stop;
  await fixture.build().stop({ sessionId: created.sessionId });
  expect((await fixture.build().readBinding(fixture.request)).state).toBe('stopped');
});

it('refuses disabled Docker/spaces before any host fallback or session operation', async () => {
  const fixture = await setup(); fixture.disable();
  await expect(fixture.build().create(fixture.request, async () => {})).rejects.toMatchObject({ code: 'BOT_ISOLATION_UNAVAILABLE', state: 'needs-you' });
  expect(fixture.calls).toEqual([]);
});

it('can retry a missing grant before allocation after its existing owner is repaired', async () => {
  const fixture = await setup(); const adapter = fixture.build();
  fixture.host.journey.readHostLogins = async () => ({ logins: [] });
  await expect(adapter.create(fixture.request, async () => {})).rejects.toMatchObject({ code: 'BOT_ISOLATED_MODEL_GRANT_REQUIRED' });
  expect(fixture.calls).toEqual([]);
  fixture.host.journey.readHostLogins = async () => ({ logins: [{ provider: 'chosen', state: 'usable' }] });
  expect(await adapter.create(fixture.request, async () => {})).toMatchObject({ sessionId: expect.any(String) });
  expect(fixture.calls.filter(([name]) => name === 'space')).toHaveLength(1);
});

it('unwraps SDK record envelopes for isolated create and reconciliation', async () => {
  const fixture = await setup({ nestedRecords: true }); const adapter = fixture.build();
  const created = await adapter.create(fixture.request, async () => {});
  expect(await adapter.reconcile('session.create', fixture.request, created.sessionId)).toMatchObject({ state: 'succeeded', result: { sessionId: created.sessionId } });
});

it('forwards only the recorded fixing space/session and replays its receipt after a lost child acknowledgement', async () => {
  const fixture = await setup(); const adapter = fixture.build(); const request = { ...fixture.request, stage: 'fixing' };
  const created = await adapter.create(request, async () => {});
  const tool = { sessionId: created.sessionId, callId: 'call-1', action: 'discord.send', input: { operationId: 'send-1', body: 'Evidence' } };
  const id = digestMutationInput({ sessionId: tool.sessionId, callId: tool.callId }); fixture.tools([{ id, request: tool }]);
  await expect(adapter.forwardTools({ spaceId: '000000000000', sessionId: created.sessionId })).rejects.toMatchObject({ code: 'BOT_ISOLATED_TOOL_SESSION_REQUIRED' });
  expect(fixture.calls.filter(([name]) => name === 'host-tool')).toHaveLength(0);
  fixture.failSettlement(true);
  await expect(adapter.forwardTools({ spaceId: 'abcdef123456', sessionId: created.sessionId })).rejects.toMatchObject({ code: 'BOT_ISOLATED_REQUEST_FAILED' });
  fixture.failSettlement(false);
  expect(await fixture.build().forwardTools({ spaceId: 'abcdef123456', sessionId: created.sessionId })).toEqual({ forwarded: 1 });
  expect(fixture.calls.filter(([name]) => name === 'host-tool')).toEqual([['host-tool', { sessionId: created.sessionId, action: tool.action, input: tool.input }]]);
  const settlement = fixture.calls.find(([name, value]) => name === 'request' && value.path.endsWith('/isolated-tools/settle'))[1];
  expect(JSON.parse(String(settlement.body))).toEqual({ id, request: tool, reply: { ok: true, result: { receipt: { id: 'receipt' } } } });
});

it('refuses a child inbox that claims another session without running a host tool', async () => {
  const fixture = await setup(); const adapter = fixture.build();
  const created = await adapter.create({ ...fixture.request, stage: 'fixing' }, async () => {});
  const request = { sessionId: 'ses_foreign', callId: 'call-1', action: 'git.push', input: { operationId: 'push' } };
  const valid = { ...request, sessionId: created.sessionId };
  fixture.tools([
    { id: digestMutationInput({ sessionId: valid.sessionId, callId: valid.callId }), request: valid },
    { id: digestMutationInput({ sessionId: request.sessionId, callId: request.callId }), request },
  ]);
  await expect(adapter.forwardTools({ spaceId: 'abcdef123456', sessionId: created.sessionId })).rejects.toMatchObject({ code: 'BOT_ISOLATED_TOOL_SESSION_REQUIRED' });
  expect(fixture.calls.filter(([name]) => name === 'host-tool')).toHaveLength(0);
});

it('does not repeat a host action whose dispatching receipt survived a crash', async () => {
  const fixture = await setup(); const adapter = fixture.build();
  const created = await adapter.create({ ...fixture.request, stage: 'fixing' }, async () => {});
  const request = { sessionId: created.sessionId, callId: 'call-one', action: 'git.push', input: { operationId: 'push' } };
  const entry = { id: digestMutationInput({ sessionId: request.sessionId, callId: request.callId }), request };
  fixture.tools([entry]);
  const key = { spaceId: 'abcdef123456', sessionId: created.sessionId, id: entry.id };
  const directory = path.join(fixture.dataDir, 'bots/isolated-tool-receipts');
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, `${digestMutationInput(key)}.json`), JSON.stringify({ ...entry, state: 'dispatching' }));
  await expect(fixture.build().forwardTools(key)).rejects.toMatchObject({ code: 'BOT_ISOLATED_TOOL_OUTCOME_UNKNOWN' });
  expect(fixture.calls.filter(([name]) => name === 'host-tool')).toHaveLength(0);
});

it('exposes only the recorded current session owner, with a sensitive metadata identity check', async () => {
  const sourceUrl = new URL('./isolated-stages.js', import.meta.url);
  const source = await fs.readFile(sourceUrl, 'utf8');
  const protection = /if \(info\.id !== sessionId[\s\S]+?refuse\('BOT_ISOLATED_SESSION_MISMATCH'\);/;
  expect(protection.test(source)).toBe(true);
  const mutant = source.replace(protection, "if (false) refuse('BOT_ISOLATED_SESSION_MISMATCH');")
    .replace(/from '([^']+)'/g, (match, specifier) => specifier.startsWith('.') ? `from '${new URL(specifier, sourceUrl).href}'` : match);
  const fixture = await setup();
  const mutantPath = path.join(fixture.dataDir, 'isolated-owner-mutant.mjs');
  // Resolve packages from this checkout while keeping the copy outside it.
  await fs.writeFile(mutantPath, mutant.replace(/from '(zod|@opencode\/client)'/g,
    (_match, specifier) => `from '${import.meta.resolve(specifier)}'`));
  const createMutant = (await import(new URL(`file://${mutantPath}`).href)).createBotIsolatedStages;
  const adapter = fixture.build();
  const created = await adapter.create({ ...fixture.request, stage: 'fixing' }, async () => {});
  expect((await adapter.sessionOwner({ sessionId: created.sessionId })).binding.itemId).toBe('i');
  const original = fixture.host.dispatcher.requestInside;
  fixture.host.dispatcher.requestInside = async (spaceId, input) => {
    const response = await original(spaceId, input);
    if (input.method !== 'GET' || !input.path.endsWith(created.sessionId)) return response;
    const info = { id: created.sessionId, location: { directory: '/spaces/abcdef123456/worktree' },
      metadata: { openchamber: { automation: { source: 'bot', projectId: 'p', itemId: 'foreign', botId: 'b', stage: 'fixing' } } } };
    const changed = Readable.from([Buffer.from(JSON.stringify({ data: info }))]);
    changed.statusCode = 200; changed.complete = true; return changed;
  };
  const probe = async (owner) => expect(owner.sessionOwner({ sessionId: created.sessionId })).rejects.toMatchObject({ code: 'BOT_ISOLATED_SESSION_MISMATCH' });
  await probe(adapter);
  await expect(probe(fixture.build(createMutant))).rejects.toThrow();
  await probe(fixture.build());
});

it('cleans up only its recorded checkout through the archival journey and retains unconfirmed removal', async () => {
  const fixture = await setup(); const adapter = fixture.build();
  await adapter.create(fixture.request, async () => {});
  const request = { project: { id: 'p' }, bot: fixture.request.bot, item: { id: 'i', worktree: '/host/worktree' } };
  const removals = [];
  fixture.host.journey.removeSpace = async (spaceId) => { removals.push(spaceId); return { removed: false, failures: [{ code: 'archive_unavailable' }] }; };
  await expect(adapter.remove({ ...request, item: { ...request.item, worktree: '/user/checkout' } })).rejects.toMatchObject({ code: 'BOT_ISOLATED_BINDING_REQUIRED' });
  expect(removals).toEqual([]);
  await expect(adapter.remove(request)).rejects.toMatchObject({ code: 'BOT_ISOLATED_REMOVE_UNCONFIRMED' });
  expect((await adapter.bindings())[0].state).toBe('remove-failed');
  fixture.host.journey.removeSpace = async (spaceId) => { removals.push(spaceId); return { removed: true, failures: [] }; };
  await adapter.remove(request); await fixture.build().remove(request);
  expect(removals).toEqual(['abcdef123456', 'abcdef123456']);
  expect((await adapter.bindings())[0].state).toBe('removed');
});
