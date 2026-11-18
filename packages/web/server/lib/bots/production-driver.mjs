import assert from 'node:assert/strict';
import { productionFixture, commitFiles } from './production-test-support.js';
import { createProductionBotPullRequests } from './production-pull-requests.js';
import { createFixLoopRuntime } from '../pr-fix-loop/runtime.js';
import { readPullFeedback, readFeedbackAuthorPermission, readFailedChecks } from '../github/pr-feedback.js';

const fixture = await productionFixture();
let runtime;
try {
  const checkout = await fixture.makeWorktrees().create(fixture.request);
  Object.assign(fixture.item, { worktree: checkout.directory, branch: checkout.branch });
  const testSha = await commitFiles(checkout.directory, { 'regression.test.js': 'throw new Error("regression");\n' }, 'Regression');
  const fixSha = await commitFiles(checkout.directory, { 'correction.js': 'export const corrected = true;\n' }, 'Correction');
  const snapshot = await fixture.makeWorktrees().inspect(fixture.request);
  assert.equal(snapshot.testSha, testSha);
  assert.equal(snapshot.fixSha, fixSha);
  assert.equal((await fixture.makeWorktrees().reconcile(fixture.request)).state, 'succeeded');
  fixture.state.head = fixSha;
  fixture.state.remote = fixSha;
  fixture.state.mergeQueue = true;
  fixture.item.pr = { number: 7, url: 'https://github.com/acme/app/pull/7', headSha: fixSha };
  const timers = [];
  const feedback = [];
  const adapters = createProductionBotPullRequests({ context: fixture.context, services: fixture.services,
    getFixLoopRuntime: () => runtime, reviewApps: [{ slug: 'ai-review', appId: 77 }],
    receiveFeedback: async (projectId, itemId, event) => feedback.push({ projectId, itemId, event }),
  });
  runtime = createFixLoopRuntime({ dataDir: fixture.dataDir, botWatch: adapters.botWatch,
    getOctokit: async () => { throw new Error('Ambient account forbidden'); },
    readFeedback: readPullFeedback, readAuthorPermission: readFeedbackAuthorPermission, readFailedChecks,
    hasQueuedItem: async () => false, isSessionWorking: async () => false,
    enqueue: async () => { throw new Error('Ordinary user feedback queue forbidden'); },
    setTimer: (fn) => { const timer = { fn, unref() {} }; timers.push(timer); return timer; },
    clearTimer: (timer) => { const index = timers.indexOf(timer); if (index >= 0) timers.splice(index, 1); },
  });
  await adapters.pullRequests.ensureLoop(fixture.request);
  for (let id = 1; id <= 11; id += 1) {
    fixture.state.feedback = [{ id: `T${id}`, isResolved: false, isOutdated: false, path: 'correction.js', line: 1,
      comments: { pageInfo: { hasPreviousPage: false, hasNextPage: false }, nodes: [{ databaseId: id,
        body: `Review ${id}`, url: `https://github.com/acme/app/pull/7#${id}`, createdAt: new Date().toISOString(),
        author: { __typename: 'Bot', login: 'ai-review[bot]' } }] } }];
    await timers.shift().fn();
  }
  assert.equal(feedback.length, 11);
  const status = await adapters.pullRequests.read(fixture.request);
  const binding = (await fixture.context.serviceContext({ ...fixture.request, service: 'github', operation: 'pr.auto-merge' })).github;
  const input = { number: 7, headSha: fixSha, baseSha: snapshot.baseSha, branch: checkout.branch, mode: status.mergeMode, mergeMethod: 'SQUASH' };
  const envelope = await fixture.services.prepare({ key: 'driver:queue', operation: 'pr.auto-merge', botId: fixture.bot.id,
    itemId: fixture.item.id, ...binding, input });
  assert.equal((await fixture.services.execute(envelope, input)).result.status, 'enqueued');
  await fixture.services.execute(envelope, input);
  assert.equal(fixture.state.admissions.length, 1);
  await adapters.pullRequests.stop(fixture.request);
  await fixture.makeWorktrees().remove({ ...fixture.request, checkout });
  assert.equal((await fixture.makeWorktrees().reconcile({ ...fixture.request, operation: 'remove' })).state, 'succeeded');
  console.log(JSON.stringify({ git: 'real linked checkout: create -> inspect -> restart reconcile -> cleanup',
    testSha, fixSha, feedbackTurns: feedback.length, admission: 'existing service journal, queue only, replayed once',
    provider: 'controlled HTTP upstream, no live GitHub publication or merge proved' }, null, 2));
} finally {
  await runtime?.stop();
  await fixture.close();
}
