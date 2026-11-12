import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { readBoundedBody } from './agent-upstream.js';
import { FIX_LOOP_INPUT_BYTES, FIX_LOOP_OPERATIONS, FIX_LOOP_SERVICE_ROUTE, FIX_LOOP_BYTES } from './fix-loop-contract.js';
import { cleanupFixLoops, FEEDBACK, HEAD, RESULT, fixLoopServiceFixture } from './fix-loop-test-fixture.js';
import { isAgentText } from '../pr-fix-loop/agent-marker.js';

afterEach(cleanupFixLoops);
const answer = async (response) => ({ status: response.statusCode, body: JSON.parse(await readBoundedBody(response, 8192)) });
const operations = Object.keys(FIX_LOOP_OPERATIONS);
test.each(operations)('%s requires API authentication and agent mode with an allowed positive control', async (operation) => {
  const active = await fixLoopServiceFixture();
  expect((await answer(await active.send(operation))).status).toBe(200);
  const refused = await fetch(`${active.origin}${FIX_LOOP_SERVICE_ROUTE}/${operation}`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(active.requests[operation]) });
  expect(refused.status).toBe(401);
  const inactive = await fixLoopServiceFixture({ agentServer: false });
  const response = await inactive.send(operation);
  expect(response.statusCode).toBe(404); response.destroy();
});
test.each(operations)('%s rejects additional authority and oversized parameters before execution', async (operation) => {
  const fixture = await fixLoopServiceFixture();
  expect((await answer(await fixture.send(operation))).status).toBe(200);
  for (const field of ['loopId', 'spaceId', 'sessionId', 'destination']) {
    const result = await answer(await fixture.send(operation, { ...fixture.requests[operation], [field]: 'forged' }));
    expect(result).toMatchObject({ status: 400, body: { code: 'agent_fix_loop_invalid_request' } });
  }
  const large = await answer(await fixture.send(operation, { ...fixture.requests[operation], padding: 'a'.repeat(FIX_LOOP_INPUT_BYTES) }));
  expect(large).toMatchObject({ status: 400, body: { code: 'agent_fix_loop_invalid_request' } });
});
test.each(operations)('%s requires exact canonical registered project matching', async (operation) => {
  const fixture = await fixLoopServiceFixture();
  const other = path.join(fixture.directory, 'child'); await fs.mkdir(other);
  const input = structuredClone(fixture.requests[operation]);
  if (input.context) input.context.directory = other;
  else if (input.input) input.input.directory = other;
  else input.directory = other;
  expect(await answer(await fixture.send(operation, input))).toMatchObject({ status: 403, body: { code: 'agent_project_unregistered' } });
  const alias = path.join(fixture.root, 'alias'); await fs.symlink(fixture.directory, alias);
  if (input.context) input.context.directory = alias;
  else if (input.input) input.input.directory = alias;
  else input.directory = alias;
  expect((await answer(await fixture.send(operation, input))).status).toBe(200);
});
test('agent provider reads resolve only the named account and reconstruct replies without authority fields', async () => {
  const fixture = await fixLoopServiceFixture();
  fixture.deps.readFeedback.mockResolvedValue({ ...FEEDBACK, spaceId: 'forged', loopId: 'forged', credential: 'private' });
  expect((await answer(await fixture.send('feedback'))).body).toEqual(FEEDBACK);
  expect(fixture.deps.getOctokit).toHaveBeenCalledExactlyOnceWith('account');
  fixture.deps.getOctokit.mockResolvedValue(null);
  expect(await answer(await fixture.send('feedback'))).toMatchObject({ status: 403, body: { code: 'agent_fix_loop_account_unavailable' } });
  expect(fixture.deps.readFeedback).toHaveBeenCalledOnce();
});
test('agent services preserve exact Git/ref/review parameters and only return compact success', async () => {
  const fixture = await fixLoopServiceFixture();
  expect((await answer(await fixture.send('publish'))).body).toEqual({ state: 'succeeded' });
  expect(fixture.git.publish).toHaveBeenCalledExactlyOnceWith(fixture.requests.publish.input, RESULT);
  expect((await answer(await fixture.send('review-operation'))).body).toEqual({ ok: true });
  expect(fixture.git.applyReviewOperation.mock.calls[0][0]).toEqual({
    loop: { readContext: fixture.context, owner: 'upstream', repo: 'app', number: 7 },
    receipt: { commit: RESULT, destination: { ref: 'refs/heads/fix' } },
    operation: fixture.requests['review-operation'].operation, replayOnly: false,
  });
  await fixture.send('fetch-head').then(answer);
  expect(fixture.git.fetchHead.mock.calls[0][0]).not.toHaveProperty('id');
  expect(fixture.git.fetchHead.mock.calls[0][1]).toEqual({ headSha: HEAD });
});
test('agent services reject malformed or oversized provider answers and sanitize dispatch failures', async () => {
  const fixture = await fixLoopServiceFixture();
  fixture.deps.readAuthorPermission.mockResolvedValue('yes');
  expect((await answer(await fixture.send('author-permission'))).body.code).toBe('agent_fix_loop_invalid_response');
  fixture.git.applyReviewOperation.mockRejectedValue(Object.assign(new Error('credential=private'), { status: 403, fixLoopReviewNotDispatched: true }));
  expect(await answer(await fixture.send('review-operation'))).toEqual({ status: 403,
    body: { code: 'agent_fix_loop_operation_failed', reviewNotDispatched: true } });
});
test('head bundle uses authenticated agent-only exact-head parameters and canonical registration', async () => {
  const fixture = await fixLoopServiceFixture();
  const route = `${FIX_LOOP_SERVICE_ROUTE}/head-bundle?${new URLSearchParams({ directory: fixture.directory, head: HEAD })}`;
  expect((await fetch(`${fixture.origin}${route}`)).status).toBe(401);
  const response = await fixture.upstream.request({ path: route });
  expect(response.statusCode).toBe(200); expect(await readBoundedBody(response, 1024)).toBe('bundle');
  expect(fixture.project.exportHead.mock.calls[0][0]).toEqual({ directory: fixture.directory, head: HEAD });
  expect((await answer(await fixture.upstream.request({ path: `${route}&ref=refs/heads/main` }))).status).toBe(400);
  expect((await answer(await fixture.upstream.request({ path: route.replace(HEAD, 'bad') }))).status).toBe(400);
  expect((await answer(await fixture.upstream.request({ path: `${route}&head=${HEAD}` }))).status).toBe(400);
  const other = path.join(fixture.directory, 'child'); await fs.mkdir(other);
  expect((await answer(await fixture.upstream.request({ path: route.replace(encodeURIComponent(fixture.directory), encodeURIComponent(other)) }))).status).toBe(403);
  const inactive = await fixLoopServiceFixture({ agentServer: false });
  const refused = await inactive.upstream.request({ path: route }); expect(refused.statusCode).toBe(404); refused.destroy();
});
test.each([
  ['admit', (input) => { input.number = 2147483648; }],
  ['feedback', (input) => { input.accountId = 'a'.repeat(257); }],
  ['author-permission', (input) => { input.username = 'a'.repeat(257); }],
  ['failed-checks', (input) => { input.contexts = Array.from({ length: 101 }, () => ({ __typename: 'StatusContext', context: 'check', state: 'FAILURE', targetUrl: null, description: null })); }],
  ['read-binding', (input) => { input.directory = '/spaces/aabbccddeeff/repo'; }],
  ['fetch-head', (input) => { input.head = 'refs/heads/main'; }],
  ['capture-ref', (input) => { input.localRef = 'refs/heads/main'; }],
  ['publish', (input) => { input.input.forceWithLease.expectedRemoteSha = 'HEAD'; }],
  ['review-operation', (input) => { input.operation.body = 'a'.repeat(8193); }],
  ['head-metadata', (input) => { input.head = 'HEAD'; }],
])('%s refuses bounded operation fields that could widen project/provider authority', async (operation, corrupt) => {
  const fixture = await fixLoopServiceFixture();
  expect((await answer(await fixture.send(operation))).status).toBe(200);
  const input = structuredClone(fixture.requests[operation]); corrupt(input);
  expect(await answer(await fixture.send(operation, input))).toMatchObject({ status: 400, body: { code: 'agent_fix_loop_invalid_request' } });
});
test('agent project operations consume the checked canonical path even when a registered alias changes', async () => {
  const fixture = await fixLoopServiceFixture();
  const alias = path.join(fixture.root, 'alias'); const other = path.join(fixture.root, 'other');
  await fs.mkdir(other); await fs.symlink(fixture.directory, alias);
  fixture.git.readBinding.mockImplementation(async (directory) => {
    await fs.unlink(alias); await fs.symlink(other, alias);
    expect(directory).toBe(fixture.directory);
    return { revision: 0, repository: { repositoryId: 'repo', configRevision: 'config', remotes: [] }, binding: null };
  });
  expect((await answer(await fixture.send('read-binding', { directory: alias }))).status).toBe(200);
  expect(fixture.git.readBinding).toHaveBeenCalledExactlyOnceWith(fixture.directory);
  expect((await answer(await fixture.send('read-binding', { directory: alias }))).status).toBe(403);
});
const comment = (id, body) => ({ id, body, url: '', createdAt: null, author: { login: 'reviewer', bot: false } });
const feedbackWith = (comments, threadComments = []) => ({ ...structuredClone(FEEDBACK), comments,
  reviews: comments.map((entry) => ({ ...entry, state: 'COMMENTED' })),
  threads: threadComments.map((comments, index) => ({ id: `T${index}`, resolved: false, outdated: false, path: 'a', line: 1, comments })) });
const readFeedbackReply = async (fixture) => {
  const response = await fixture.send('feedback', { ...fixture.requests.feedback, mentionText: '@openchamber' });
  return { status: response.statusCode, body: JSON.parse(await readBoundedBody(response, FIX_LOOP_BYTES)) };
};
test('feedback bodies over the cap are clipped to what the runtime reads, keeping the marker and the mention', async () => {
  // Given a pull request whose comments are 64 KiB each, a mention and a marker at their very end.
  const fixture = await fixLoopServiceFixture();
  const long = (tail) => `${'a'.repeat(65_000)} ${tail}`;
  const huge = feedbackWith([comment(1, long('@OpenChamber please')), comment(2, long('<!-- openchamber-agent:v1 -->')),
    ...Array.from({ length: 48 }, (_, index) => comment(index + 3, long('plain')))]);
  expect(Buffer.byteLength(JSON.stringify(huge))).toBeGreaterThan(FIX_LOOP_BYTES);
  fixture.deps.readFeedback.mockResolvedValue(huge);
  // When the front door reads it.
  const reply = await readFeedbackReply(fixture);
  // Then the read succeeds, each check gives the full body's answer, and the prompt text is the runtime's own clip.
  expect(reply.status).toBe(200);
  const [mentioned, marked, plain] = reply.body.comments;
  expect(mentioned.body.toLowerCase()).toContain('@openchamber');
  expect(isAgentText(marked.body)).toBe(true);
  expect(isAgentText(plain.body) || plain.body.toLowerCase().includes('@openchamber')).toBe(false);
  expect(plain.body).toBe(`${'a'.repeat(4_000)}…`);
  expect(reply.body.reviews[0].body).toBe(mentioned.body);
});
test('a feedback reply that still does not fit is clipped shorter instead of failing', async () => {
  // Given 100 threads of 30 comments of 4,500 characters: over the cap even at 4,000 characters each.
  const fixture = await fixLoopServiceFixture();
  const threads = Array.from({ length: 100 }, (_, thread) => Array.from({ length: 30 }, (_, index) => comment(thread * 30 + index + 1, 'b'.repeat(4_500))));
  fixture.deps.readFeedback.mockResolvedValue(feedbackWith([comment(1, `@openchamber ${'c'.repeat(4_500)}`)], threads));
  // When the front door reads it, then it gets every comment, shorter, with the mention still found.
  const reply = await readFeedbackReply(fixture);
  expect(reply.status).toBe(200);
  expect(reply.body.threads.flatMap((thread) => thread.comments)).toHaveLength(3_000);
  expect(reply.body.threads[0].comments[0].body).toBe(`${'b'.repeat(1_000)}…`);
  expect(reply.body.comments[0].body.startsWith('@openchamber')).toBe(true);
});
test('a short comment padded with whitespace still reads, as its trimmed text', async () => {
  // Given a comment whose text is short and whose body carries thousands of trailing blanks.
  const fixture = await fixLoopServiceFixture();
  fixture.deps.readFeedback.mockResolvedValue(feedbackWith([comment(1, `please fix${' '.repeat(5_000)}`), comment(2, `\n${'\n'.repeat(5_000)}`)]));
  // When the front door reads it, then the read succeeds with the text the runtime reads anyway.
  const reply = await readFeedbackReply(fixture);
  expect(reply.status).toBe(200);
  expect(reply.body.comments.map((entry) => entry.body)).toEqual(['please fix', '']);
});
