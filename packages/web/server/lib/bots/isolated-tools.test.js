import fs from 'node:fs/promises';
import { afterEach, expect, it } from 'vitest';
import { createBotIsolatedToolInbox } from './isolated-tools.js';

const roots = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
const setup = async () => {
  const dataDir = await fs.mkdtemp('/tmp/opencode/bot-tool-inbox-'); roots.push(dataDir);
  let announce;
  const announced = new Promise((resolve) => { announce = resolve; });
  const build = () => createBotIsolatedToolInbox({ dataDir, onPending: async (event) => announce(event) });
  return { build, announced };
};
const request = { sessionId: 'ses_fixing', callId: 'call_one', action: 'jira.comment', input: { operationId: 'comment-1', body: 'Evidence' } };

it('persists before announcing, accepts host settlement and replays the same call after restart', async () => {
  const fixture = await setup(); const inbox = fixture.build();
  const waiting = inbox.request(request);
  const { requestId } = await fixture.announced;
  expect(await inbox.pending(request.sessionId)).toEqual({ requests: [{ id: requestId, request }] });
  const reply = { ok: true, result: { receipt: { id: 'comment-7' } } };
  await inbox.settle({ id: requestId, request, reply });
  expect(await waiting).toEqual(reply.result);
  expect(await fixture.build().request(request)).toEqual(reply.result);
  expect(await fixture.build().pending(request.sessionId)).toEqual({ requests: [] });
  await expect(inbox.settle({ id: requestId, request, reply: { ok: true, result: {} } })).rejects.toMatchObject({ code: 'BOT_ISOLATED_TOOL_CHANGED' });
  await expect(inbox.request({ ...request, input: { operationId: 'changed' } })).rejects.toMatchObject({ code: 'BOT_ISOLATED_TOOL_CHANGED' });
});

it('keeps an aborted request durable and preserves an unknown host outcome', async () => {
  const fixture = await setup(); const inbox = fixture.build(); const controller = new AbortController();
  const waiting = inbox.request(request, { signal: controller.signal });
  const { requestId } = await fixture.announced;
  controller.abort(new Error('stopped'));
  await expect(waiting).rejects.toThrow('stopped');
  const restarted = fixture.build();
  expect((await restarted.pending(request.sessionId)).requests).toHaveLength(1);
  await restarted.settle({ id: requestId, request, reply: { ok: false, error: { code: 'BOT_EFFECT_OUTCOME_UNKNOWN', status: 409, state: 'outcome-unknown' } } });
  await expect(restarted.request(request)).rejects.toMatchObject({ code: 'BOT_EFFECT_OUTCOME_UNKNOWN', state: 'outcome-unknown' });
});
