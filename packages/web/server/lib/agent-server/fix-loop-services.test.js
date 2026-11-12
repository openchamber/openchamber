import { Readable } from 'node:stream';
import { expect, test, vi } from 'vitest';
import { createAgentFixLoopServices } from './fix-loop-services.js';
import { FIX_LOOP_BYTES, FIX_LOOP_OPERATIONS, FIX_LOOP_SERVICE_ROUTE } from './fix-loop-contract.js';
import { AUTHORITY, BINDING, CONTEXT, FEEDBACK, HEAD, PULL, REF, RESULT, TARGET } from './fix-loop-test-fixture.js';

const loop = { ...TARGET, directory: CONTEXT.directory, readContext: CONTEXT };
const published = { ...AUTHORITY, directory: '/repo', operation: 'push', sourceRef: REF, destinationRef: 'refs/heads/fix',
  forceWithLease: { expectedRemoteSha: HEAD } };
const review = { loop, receipt: { commit: RESULT, destination: { ref: 'refs/heads/fix' } },
  operation: { kind: 'comment', body: 'Fixed', idempotencyKey: 'fix-review:turn:0' }, replayOnly: true };
const read = { octokit: { accountId: 'account' }, directory: '/repo', ...TARGET };
const { number: _number, ...repositoryRead } = read;
const cases = [
  ['admit', (service) => service.admit({ context: CONTEXT, ...TARGET }), { context: CONTEXT, pull: PULL }],
  ['feedback', (service) => service.readFeedback(read), FEEDBACK],
  ['author-permission', (service) => service.readAuthorPermission({ ...repositoryRead, username: 'reviewer' }), { permitted: true }],
  ['failed-checks', (service) => service.readFailedChecks({ ...repositoryRead, contexts: [] }), []],
  ['read-binding', (service) => service.readBinding('/repo'), BINDING],
  ['fetch-head', (service) => service.fetchHead(loop, { headSha: HEAD }), { head: HEAD }],
  ['capture-ref', (service) => service.captureRef({ directory: '/repo', commit: RESULT, expectedHead: HEAD, localRef: REF }), { commit: RESULT, localRef: REF }],
  ['publish', (service) => service.publish(published, RESULT), { state: 'succeeded' }],
  ['review-operation', (service) => service.applyReviewOperation(review), { ok: true }],
  ['head-metadata', (service) => service.readHead({ directory: '/repo', head: HEAD }), { head: HEAD, objectFormat: 'sha1', shallow: [] }],
];
const rawResponse = (text, statusCode = 200) => Object.assign(Readable.from([Buffer.from(text)]), { statusCode });
const response = (body, statusCode = 200) => rawResponse(JSON.stringify(body), statusCode);
test.each(cases)('%s adapter reconstructs a bounded operation without loop or Space authority', async (operation, invoke, reply) => {
  const request = vi.fn(async () => response(Array.isArray(reply) ? reply : { ...reply, token: 'private', spaceId: 'forged', loopId: 'forged' }));
  const value = await invoke(createAgentFixLoopServices({ request }));
  const call = request.mock.calls[0][0];
  expect(call.path).toBe(`${FIX_LOOP_SERVICE_ROUTE}/${operation}`);
  expect(call.timeoutMs).toBeGreaterThan(0); expect(call.method).toBe('POST');
  expect(FIX_LOOP_OPERATIONS[operation].input.safeParse(JSON.parse(call.body)).success).toBe(true);
  expect(call.body).not.toMatch(/spaceId|loopId|sessionId|token/);
  expect(JSON.stringify(value) ?? '').not.toMatch(/private|forged/);
});
test.each(cases)('%s adapter refuses malformed, oversized, unreachable and free-form error replies', async (_operation, invoke, reply) => {
  await invoke(createAgentFixLoopServices({ request: async () => response(reply) }));
  for (const body of ['{', '{}', 'a'.repeat(FIX_LOOP_BYTES + 1)]) {
    await expect(invoke(createAgentFixLoopServices({ request: async () => rawResponse(body) }))).rejects.toMatchObject({
      code: body.length > FIX_LOOP_BYTES ? 'agent_response_too_large' : 'agent_fix_loop_invalid_response',
    });
  }
  await expect(invoke(createAgentFixLoopServices({ request: async () => { throw Object.assign(new Error('private'), { code: 'agent_unreachable' }); } })))
    .rejects.toMatchObject({ code: 'agent_unreachable' });
  await expect(invoke(createAgentFixLoopServices({ request: async () => response({ code: 'private', message: 'credential' }, 403) })))
    .rejects.toMatchObject({ message: 'agent_fix_loop_operation_failed', statusCode: 403 });
});
test('opaque account handles never carry credentials or fall back when an account is absent', async () => {
  const service = createAgentFixLoopServices({ request: async () => { throw new Error('unexpected'); } });
  expect(await service.getOctokit('account')).toEqual({ accountId: 'account' });
  expect(await service.getOctokit(null)).toBeNull();
  await expect(service.readFeedback({ ...read, octokit: null })).rejects.toMatchObject({ code: 'agent_fix_loop_invalid_request' });
});
test('admission rejects substituted accounts, project coordinates, session directories and closed PRs', async () => {
  for (const change of [
    { context: { ...CONTEXT, accountId: 'other' }, pull: PULL },
    { context: { ...CONTEXT, directory: '/other' }, pull: PULL },
    { context: CONTEXT, pull: { ...PULL, owner: 'other' } },
    { context: CONTEXT, pull: { ...PULL, number: 8 } },
    { context: CONTEXT, pull: { ...PULL, snapshot: { ...PULL.snapshot, state: 'closed' } } },
  ]) await expect(createAgentFixLoopServices({ request: async () => response(change) }).admit({ context: CONTEXT, ...TARGET }))
    .rejects.toMatchObject({ code: 'agent_fix_loop_invalid_response' });
});
test('head and capture acknowledgments cannot substitute commits or front-door receipt refs', async () => {
  const service = createAgentFixLoopServices({ request: async () => response({ head: RESULT, commit: HEAD, localRef: REF,
    objectFormat: 'sha1', shallow: [] }) });
  await expect(service.fetchHead(loop, { headSha: HEAD })).rejects.toMatchObject({ code: 'agent_fix_loop_invalid_response' });
  await expect(service.readHead({ directory: '/repo', head: HEAD })).rejects.toMatchObject({ code: 'agent_fix_loop_invalid_response' });
  await expect(service.captureRef({ directory: '/repo', commit: RESULT, expectedHead: HEAD, localRef: REF }))
    .rejects.toMatchObject({ code: 'agent_fix_loop_invalid_response' });
});
test('review pre-dispatch refusal survives transport while an unknown write cannot acquire retry authority', async () => {
  const invoke = (body) => createAgentFixLoopServices({ request: async () => response(body, 403) }).applyReviewOperation(review);
  await expect(invoke({ code: 'agent_fix_loop_operation_failed', reviewNotDispatched: true })).rejects.toMatchObject({ fixLoopReviewNotDispatched: true });
  try { await invoke({ code: 'agent_fix_loop_operation_failed' }); } catch (error) { expect(error.fixLoopReviewNotDispatched).toBeUndefined(); }
});
test('host-session reads reconstruct exact id and directory and reject invalid authority or transport failure', async () => {
  const json = vi.fn(async () => ({ data: { id: 'ses_host', location: { directory: '/repo', spaceId: 'forged' }, token: 'private' } }));
  const service = createAgentFixLoopServices({ json });
  expect(await service.readHostSession('ses_host')).toEqual({ id: 'ses_host', location: { directory: '/repo' } });
  expect(json).toHaveBeenCalledExactlyOnceWith('/api/session/ses_host');
  for (const data of [{ id: 'ses_other', location: { directory: '/repo' } }, { id: 'ses_host', location: { directory: '/spaces/123/repo' } },
    { id: 'ses_host', location: { directory: 'a'.repeat(4097) } }]) {
    json.mockResolvedValue({ data });
    await expect(service.readHostSession('ses_host')).rejects.toMatchObject({ code: 'agent_fix_loop_invalid_response' });
  }
  json.mockRejectedValue(Object.assign(new Error('private'), { code: 'agent_response_too_large' }));
  await expect(service.readHostSession('ses_host')).rejects.toMatchObject({ code: 'agent_response_too_large' });
  json.mockRejectedValue(Object.assign(new Error('private'), { code: 'agent_unreachable' }));
  await expect(service.readHostSession('ses_host')).rejects.toMatchObject({ code: 'agent_unreachable' });
});
test('a failed-checks read gets the long deadline, since the agent downloads job logs for it', async () => {
  const request = vi.fn(async () => response([]));
  await createAgentFixLoopServices({ request }).readFailedChecks({ ...repositoryRead, contexts: [] });
  await createAgentFixLoopServices({ request }).readFeedback(read).catch(() => {});
  expect(request.mock.calls.map(([call]) => call.timeoutMs)).toEqual([600_000, 30_000]);
});
