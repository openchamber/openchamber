import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createBotDriver, TEST_HEAD } from './runtime-test-support.js';
import { createBotExecutionStore } from './execution-store.js';

const directories = [];
afterEach(async () => { for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true }); });
const setup = async (options) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bot-publication-'));
  directories.push(root);
  return createBotDriver(root, options);
};
const rules = [{ type: 'branch_name_pattern', parameters: { operator: 'regex', pattern: '^task/BUG-[0-9]+$' } }];

it('publishes the reserved project branch while retaining the item local branch', async () => {
  const h = await setup({ publicationBranch: 'task/BUG-1', repositoryRules: rules });
  await h.admit();

  await h.runtime.pump(h.project.id);

  const [item] = (await h.store.read(h.project.id)).items;
  expect(item.state).toBe('merging');
  expect(item.branch).toBe(`bot/${item.id}`);
  expect(item.publicationBranch).toBe('task/BUG-1');
  expect(h.calls.effects.find((call) => call.operation === 'git.push').input)
    .toMatchObject({ branch: 'task/BUG-1', localBranch: `bot/${item.id}`, expectedRemoteSha: null });
  expect(h.calls.effects.find((call) => call.operation === 'pr.open').input.branch).toBe('task/BUG-1');
  expect(h.calls.effects.find((call) => call.operation === 'pr.auto-merge').input.branch).toBe('task/BUG-1');
  const execution = await createBotExecutionStore({ store: h.store }).read(h.project.id, item.id);
  expect(execution.data.runs['fixing:0'].context.repositoryRules).toEqual({ branch: 'task/BUG-1', rules });
});

it('holds before fixing when naming rules have no proposed publication branch', async () => {
  const h = await setup({ repositoryRules: rules });
  await h.admit();

  await h.runtime.pump(h.project.id);

  const [item] = (await h.store.read(h.project.id)).items;
  expect(item.state).toBe('needs-you');
  expect(item.wait.reason).toBe('BOT_PUBLICATION_BRANCH_REQUIRED');
  expect(item.sessions.fixing).toBeUndefined();
  expect(h.calls.effects).toEqual([]);
});

it('reinvestigates a human naming answer before binding and starting correction', async () => {
  const h = await setup({ repositoryRules: rules, questions: ['Which branch convention applies?'] });
  const item = await h.admit();
  await h.runtime.pump(h.project.id);
  expect((await h.runtime.detail(h.project.id, item.id)).item.state).toBe('waiting-answer');
  h.controls.questions = [];
  h.controls.publicationBranch = 'task/BUG-1';

  const answered = await h.restart().answer(h.project.id, item.id, { eventId: 'human-naming-answer', text: 'Use task/BUG-1' });

  expect(answered.item.state).toBe('merging');
  expect(answered.item.publicationBranch).toBe('task/BUG-1');
  expect(h.calls.sessions.filter((session) => session.metadata.openchamber.automation.stage === 'investigation')).toHaveLength(2);
  expect(h.calls.sessions.filter((session) => session.metadata.openchamber.automation.stage === 'fixing')).toHaveLength(1);
});

it('preserves attention and sends no model prompt when effective rules cannot be read', async () => {
  const h = await setup();
  h.dependencies.services.read = async () => { throw Object.assign(new Error('Denied'), { code: 'BOT_SERVICE_AUTH_REQUIRED' }); };
  await h.admit();

  await h.runtime.pump(h.project.id);

  const [item] = (await h.store.read(h.project.id)).items;
  expect(item.state).toBe('needs-you');
  expect(item.wait.reason).toBe('BOT_SERVICE_AUTH_REQUIRED');
  expect(h.calls.prompts).toEqual([]);
  expect(h.calls.effects).toEqual([]);
});

it('rejects replacing a bound publication branch in persisted item state', async () => {
  const h = await setup({ publicationBranch: 'task/BUG-1' });
  await h.admit();
  await h.runtime.pump(h.project.id);
  const [item] = (await h.store.read(h.project.id)).items;

  await expect(h.store.update(h.project.id, (snapshot) => ({ snapshot: { ...snapshot,
    items: snapshot.items.map((entry) => entry.id === item.id ? { ...entry, publicationBranch: 'task/BUG-2' } : entry),
  } }))).rejects.toThrow('Bot publication branch is immutable');
});

it('refuses an externally created matching head between reservation and first publication', async () => {
  const h = await setup({ publicationBranch: 'task/BUG-1' });
  h.dependencies.worktrees.bindPublication = async ({ branch }) => {
    h.controls.remoteSha = TEST_HEAD;
    return { publicationBranch: branch };
  };
  await h.admit();

  await h.runtime.pump(h.project.id);

  const [item] = (await h.store.read(h.project.id)).items;
  expect(item.wait.reason).toBe('BOT_GIT_REMOTE_CHANGED');
  expect(h.calls.effects).toEqual([]);
});

it('reconciles the original uncertain push when its remote head appears, without redispatch', async () => {
  const h = await setup({ publicationBranch: 'task/BUG-1' });
  h.controls.loseOperation = 'git.push';
  const admitted = await h.admit();
  await h.runtime.pump(h.project.id);
  h.controls.remoteSha = TEST_HEAD;
  h.controls.reconciliation = { state: 'succeeded', result: { headSha: TEST_HEAD, sourceHeadSha: TEST_HEAD } };
  h.controls.loseOperation = null;

  const detail = await h.restart().resume(h.project.id, admitted.id);

  expect(detail.item.state).toBe('merging');
  expect(h.calls.effects.filter((call) => call.operation === 'git.push')).toHaveLength(1);
  expect(detail.item.effects.find((effect) => effect.kind === 'git.push').state).toBe('succeeded');
  expect(h.calls.effects.find((call) => call.operation === 'pr.open').input.branch).toBe('task/BUG-1');
});
