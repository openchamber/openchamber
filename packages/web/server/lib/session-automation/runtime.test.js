import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createAutomationAdmission, pullRequestKey, sessionKey } from './runtime.js';

const session = sessionKey('ses_original');
const reviewer = sessionKey('ses_reviewer');
const pr = pullRequestKey({ provider: 'github', instance: 'github.com', owner: 'acme', repo: 'app', number: 7 });

test('restore completes before any dispatch, including both review sessions and canonical PR writers', async () => {
  let finish;
  const admission = createAutomationAdmission({ restore: () => new Promise((resolve) => { finish = resolve; }) });
  const ready = admission.ready();
  assert.equal(admission.trySend(null, [session]), null);
  finish([{ owner: 'review', keys: [session, reviewer] }, { owner: 'fix', keys: [pr] }]);
  await ready;
  assert.equal(admission.trySend(null, [reviewer]), null);
  assert.equal(admission.trySend(null, [sessionKey('ses_other'), pr]), null);
  assert.throws(() => admission.claim('other', [pr]), /owned/);
  assert.equal(pr, pullRequestKey({ provider: 'github', instance: 'github.com', owner: 'ACME', repo: 'App', number: 7 }));
});

test('a send lease closes asynchronous admission and remains exclusive after its owner stops', async () => {
  const admission = createAutomationAdmission();
  await admission.ready();
  const releaseSend = admission.trySend(null, [session]);
  assert.equal(typeof releaseSend, 'function');
  assert.throws(() => admission.claim('review', [session, reviewer]), /owned/);
  releaseSend();
  admission.claim('review', [session, reviewer]);
  const releaseReview = admission.trySend('review', [reviewer]);
  admission.release('review');
  assert.equal(admission.trySend(null, [reviewer]), null);
  assert.throws(() => admission.claim('fix', [reviewer, pr]), /owned/);
  releaseReview();
  admission.claim('fix', [reviewer, pr]);
  assert.equal(admission.trySend(null, [pr]), null);
});

test('conflicting restored records block both owners and an unreadable restore blocks all sends', async () => {
  const admission = createAutomationAdmission({ restore: async () => [
    { owner: 'review', keys: [session, reviewer] }, { owner: 'fix', keys: [session, pr] },
  ] });
  await admission.ready();
  assert.equal(admission.owns('review'), false);
  assert.equal(admission.owns('fix'), false);
  assert.equal(admission.trySend('review', [reviewer]), null);
  admission.release('fix');
  assert.equal(admission.owns('review'), true);
  const broken = createAutomationAdmission({ restore: async () => { throw new Error('unreadable'); } });
  await assert.rejects(broken.ready(), /unreadable/);
  assert.equal(broken.trySend(null, [session]), null);
});
