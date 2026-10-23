import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createBotsRuntime } from './runtime.js';
import { registerBotRoutes } from './routes.js';
import { createBotExecutionStore } from './execution-store.js';
import { createBotEffects } from './effects.js';
import { botTaskFor } from './events.js';
import { botPresets } from './presets.js';
import { botStagePermissions } from './stage-sessions.js';
import { createBotSources } from './sources.js';
import { admitBotJudgment } from './judge-policy.js';
import { createBotDriver, TEST_HEAD } from './runtime-test-support.js';

const directories = [];
const fixture = async (options) => {
  const root = await fs.mkdtemp('/tmp/opencode/bot-runtime-'); directories.push(root);
  return createBotDriver(root, options);
};
afterEach(async () => { for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true }); });

describe('bot coordinator with actual session owner and disk journals', () => {
  it('drives queued through every automatic stage and closure exactly once across restart', async () => {
    const driver = await fixture({ bot: { jira: { doneTransition: '31' } } });
    const item = await driver.admit({ kind: 'jira', id: 'BUG-1' });
    await driver.runtime.pump('project');
    let current = (await driver.runtime.detail('project', item.id)).item;
    expect(current.state).toBe('merging');
    expect(current.transitions.map((entry) => entry.to)).toEqual(['queued', 'investigating', 'fixing', 'proving', 'judging', 'merging']);
    expect(current.proof.status).toBe('passed');
    expect(current.judgment.headSha).toBe(TEST_HEAD);
    expect(current.tokens.total).toBe(21);
    expect(driver.calls.effects.map((entry) => entry.operation)).toEqual(['git.push', 'pr.open', 'pr.auto-merge']);
    expect(driver.calls.proofs[0]).toMatchObject({ command: 'node', args: ['--test', '{files}'], isolated: false });
    expect(driver.calls.effects.find((entry) => entry.operation === 'pr.open').input.body).toContain('<!-- openchamber-agent:v1 -->');
    driver.controls.merged = true;
    const restarted = driver.restart();
    await restarted.pump('project');
    await restarted.pump('project');
    current = (await restarted.detail('project', item.id)).item;
    expect(current.state).toBe('done');
    expect(current.transitions.slice(-2).map((entry) => entry.to)).toEqual(['closing', 'done']);
    expect(driver.calls.effects.map((entry) => entry.operation)).toEqual(['git.push', 'pr.open', 'pr.auto-merge', 'jira.comment', 'jira.transition']);
    expect(driver.calls.removed).toEqual([item.id]);
    expect(driver.calls.sessions).toHaveLength(3);
    for (const session of driver.calls.sessions) expect(session.metadata.openchamber).toMatchObject({ kind: 'scheduled', automation: { source: 'bot', botId: 'bugs', itemId: item.id, notify: 'attention' } });
  });

  it('does not replay a PR whose write response was lost and recovers its original key', async () => {
    const driver = await fixture();
    const item = await driver.admit();
    driver.controls.loseOperation = 'pr.open';
    await driver.runtime.pump('project');
    let current = (await driver.runtime.detail('project', item.id)).item;
    expect(current.state).toBe('needs-you');
    expect(current.effects.find((effect) => effect.kind === 'pr.open').state).toBe('outcome-unknown');
    await driver.restart().resume('project', item.id);
    expect(driver.calls.effects.filter((entry) => entry.operation === 'pr.open')).toHaveLength(1);
    driver.controls.loseOperation = null;
    driver.controls.reconciliation = { state: 'succeeded', result: { number: 42, head: `bot/${item.id}`, base: 'main', headSha: TEST_HEAD } };
    await driver.restart().resume('project', item.id);
    current = (await driver.runtime.detail('project', item.id)).item;
    expect(current.state).toBe('merging');
    expect(driver.calls.effects.filter((entry) => entry.operation === 'pr.open')).toHaveLength(1);
    expect(current.effects.filter((effect) => effect.kind === 'pr.open')).toHaveLength(1);
  });

  it('retains a merged PR and worktree after an ambiguous Jira comment without duplicate writes', async () => {
    const driver = await fixture();
    const item = await driver.admit({ kind: 'jira', id: 'BUG-1' });
    await driver.runtime.pump('project');
    driver.controls.merged = true;
    driver.controls.loseOperation = 'jira.comment';
    await driver.runtime.pump('project');
    expect((await driver.runtime.detail('project', item.id)).item.state).toBe('needs-you');
    await driver.restart().resume('project', item.id);
    expect(driver.calls.effects.filter((entry) => entry.operation === 'jira.comment')).toHaveLength(1);
    expect(driver.calls.removed).toEqual([]);
    expect((await driver.runtime.detail('project', item.id)).item.pr.number).toBe(42);
  });

  it('forces fixed human paths through in-review despite an auto judge', async () => {
    const driver = await fixture();
    driver.controls.changes = [{ oldPath: '.github/workflows/ci.yml', newPath: 'src/moved.yml' }];
    const item = await driver.admit();
    await driver.runtime.pump('project');
    let current = (await driver.runtime.detail('project', item.id)).item;
    expect(current.state).toBe('in-review');
    expect(current.judgment).toMatchObject({ decision: 'review', reason: expect.stringContaining('Fixed human path') });
    expect(driver.calls.effects.some((entry) => entry.operation === 'pr.auto-merge')).toBe(false);
    driver.controls.approved = true;
    await driver.runtime.pump('project');
    current = (await driver.runtime.detail('project', item.id)).item;
    expect(current.state).toBe('merging');
    expect(driver.calls.effects.filter((entry) => entry.operation === 'pr.auto-merge')).toHaveLength(1);
  });

  it('invalidates merge authority when the policy fingerprint changes', async () => {
    const driver = await fixture({ decision: 'review' });
    const item = await driver.admit();
    await driver.runtime.pump('project');
    const before = (await driver.runtime.detail('project', item.id)).item.judgment.policyFingerprint;
    await fs.mkdir(path.join(driver.project.path, '.agents', 'areas'), { recursive: true });
    await fs.writeFile(path.join(driver.project.path, '.agents', 'areas', 'database.md'), '---\nname: Database\npaths: ["db/**"]\nlevel: human\nowners: []\n---\nReview database changes.\n');
    driver.controls.approved = true;
    driver.held.add('judge');
    await driver.runtime.pump('project');
    const detail = await driver.runtime.detail('project', item.id);
    expect(detail.item.state).toBe('judging');
    expect(detail.item.judgment).toBeUndefined();
    expect(detail.item.proof.status).toBe('absent');
    expect(driver.calls.effects.some((entry) => entry.operation === 'pr.auto-merge')).toBe(false);
    expect(before).toMatch(/^[a-f0-9]{64}$/);
  });

  it('blocks absent isolation without creating a host session', async () => {
    const driver = await fixture({ bot: { isolated: true } });
    const item = await driver.admit();
    await driver.runtime.pump('project');
    expect((await driver.runtime.detail('project', item.id)).item.state).toBe('needs-you');
    expect(driver.calls.sessions).toEqual([]);
    expect(driver.calls.proofs).toEqual([]);
  });

  it('returns a pending merge to judgment when its policy changes', async () => {
    // Given an item already admitted to GitHub auto-merge.
    const driver = await fixture();
    const item = await driver.admit();
    await driver.runtime.pump('project');
    expect((await driver.runtime.detail('project', item.id)).item.state).toBe('merging');
    const mergeCount = driver.calls.effects.filter((entry) => entry.operation === 'pr.auto-merge').length;
    // When the local policy changes before GitHub merges the branch.
    await fs.mkdir(path.join(driver.project.path, '.agents', 'areas'), { recursive: true });
    await fs.writeFile(path.join(driver.project.path, '.agents', 'areas', 'new.md'), '---\nname: Review\npaths: ["src/**"]\nlevel: human\nowners: []\n---\nReview this change.\n');
    driver.held.add('judge');
    await driver.runtime.pump('project');
    // Then the item awaits a fresh verdict instead of failing its state transition or resending merge.
    const current = (await driver.runtime.detail('project', item.id)).item;
    expect(current.state).toBe('judging');
    expect(current.judgment).toBeUndefined();
    expect(driver.calls.effects.filter((entry) => entry.operation === 'pr.auto-merge')).toHaveLength(mergeCount);
  });

  it('limits active items to the configured concurrency without limiting admission count', async () => {
    const driver = await fixture({ held: ['investigation'] });
    for (let i = 0; i < 5; i += 1) await driver.admit({ kind: 'manual', id: `work-${i}` });
    await driver.runtime.pump('project');
    const items = (await driver.runtime.getItems('project')).items;
    expect(items.filter((item) => item.state === 'investigating')).toHaveLength(2);
    expect(items.filter((item) => item.state === 'queued')).toHaveLength(3);
    expect(driver.calls.sessions).toHaveLength(2);
  });

  it('checks token budgets again before starting the next stage', async () => {
    const driver = await fixture({ bot: { limits: { dailyTokens: 7 } } });
    const item = await driver.admit();
    await driver.runtime.pump('project');
    const detail = await driver.runtime.detail('project', item.id);
    expect(detail.item.state).toBe('needs-you');
    expect(detail.item.wait.reason).toBe('BOT_DAILY_TOKEN_BUDGET');
    expect(driver.calls.prompts).toHaveLength(1);
    expect(detail.item.tokens.total).toBe(7);
  });

  it('gates new work on pending human review and keeps queued work visible', async () => {
    const driver = await fixture({ decision: 'review', bot: { limits: { maxPendingHuman: 1 } } });
    const first = await driver.admit();
    await driver.runtime.pump('project');
    expect((await driver.runtime.detail('project', first.id)).item.state).toBe('in-review');
    const second = await driver.admit({ kind: 'manual', id: 'second' });
    await driver.runtime.pump('project');
    expect((await driver.runtime.detail('project', second.id)).item.state).toBe('queued');
    expect(driver.calls.sessions).toHaveLength(3);
  });

  it('deduplicates sources and feedback, and carries answers to the fixing prompt', async () => {
    const driver = await fixture({ questions: ['Which behavior is intended?'] });
    const first = await driver.admit();
    expect((await driver.admit()).id).toBe(first.id);
    await driver.runtime.pump('project');
    expect((await driver.runtime.detail('project', first.id)).item.state).toBe('waiting-answer');
    await driver.runtime.answer('project', first.id, { text: 'Keep the existing API', eventId: 'answer-1' });
    await driver.runtime.receiveFeedback('project', first.id, { text: 'Keep the existing API', eventId: 'answer-1' });
    expect(driver.calls.notices).toHaveLength(1);
    expect(driver.calls.prompts[1].text).toContain('Keep the existing API');
  });

  it('recovers a persisted created session and never resends an uncertain prompt', async () => {
    const driver = await fixture();
    const item = await driver.admit();
    driver.controls.failStage = 'investigation';
    await driver.runtime.pump('project');
    expect((await driver.runtime.detail('project', item.id)).item.sessions.investigation).toBeDefined();
    await driver.restart().resume('project', item.id);
    expect(driver.calls.sessions).toHaveLength(1);
    expect(driver.calls.prompts).toHaveLength(1);
  });

  it('keeps read failures distinct from successful empty data', async () => {
    const driver = await fixture();
    const item = await driver.admit();
    const before = await fs.readFile(driver.store.filePathFor('project'), 'utf8');
    driver.dependencies.sources.jira = async () => { throw new Error('Provider unavailable'); };
    const settings = await driver.config.read('project');
    settings.definitions[0].source = { kind: 'jira', jql: 'type = Bug', maxItems: 10 };
    await driver.config.update('project', settings);
    await expect(driver.runtime.runScheduled('project', 'bugs', 'occurrence-1')).rejects.toThrow('Provider unavailable');
    expect(await fs.readFile(driver.store.filePathFor('project'), 'utf8')).toBe(before);
    expect((await driver.runtime.detail('project', item.id)).item.state).toBe('queued');
  });

  it('archives terminal items with the configured retention and preserves dedupe', async () => {
    const driver = await fixture({ config: { retentionDays: 0 } });
    const item = await driver.admit();
    await driver.runtime.pump('project');
    driver.controls.merged = true;
    await driver.runtime.pump('project');
    // The store uses strict < cutoff. Advance the fixture's next process clock.
    const archived = await driver.store.archive('project', { before: 1_792_700_000_001 });
    expect(archived.archived).toEqual([item.id]);
    expect((await driver.admit()).id).toBe(item.id);
    expect((await driver.runtime.getArchive('project')).items[0].proof.status).toBe('passed');
  });

  it('requires explicit constructor adapters and creates independent presets', async () => {
    expect(() => createBotsRuntime({})).toThrow('config.read is required');
    const presets = botPresets();
    presets[0].mission = 'changed';
    expect(botPresets()[0].mission).not.toBe('changed');
    const task = botTaskFor(botPresets()[0]);
    expect(task).toMatchObject({ botManaged: true, botId: 'jira-bugs', enabled: false });
  });

  it('updates live usage monotonically, stops at budget and does not double-charge completion', async () => {
    const driver = await fixture({ held: ['investigation'], bot: { limits: { dailyTokens: 10 } } });
    const item = await driver.admit();
    await driver.runtime.pump('project');
    const sessionId = (await driver.runtime.detail('project', item.id)).item.sessions.investigation;
    await driver.runtime.recordUsage({ sessionId, total: 6 });
    await driver.runtime.recordUsage({ sessionId, total: 6 });
    await driver.runtime.recordUsage({ sessionId, total: 4 });
    expect((await driver.runtime.detail('project', item.id)).item.tokens.total).toBe(6);
    await driver.runtime.recordUsage({ sessionId, total: 10 });
    const current = (await driver.runtime.detail('project', item.id)).item;
    expect(current.state).toBe('needs-you');
    expect(current.wait.reason).toBe('BOT_DAILY_TOKEN_BUDGET');
    expect(current.tokens.total).toBe(10);
  });

  it('stops through the session owner and removes only the recorded worktree', async () => {
    const driver = await fixture({ held: ['investigation'] });
    const item = await driver.admit();
    await driver.runtime.pump('project');
    const result = await driver.runtime.stopItem('project', item.id);
    expect(result.item.state).toBe('stopped');
    expect(driver.calls.removed).toEqual([item.id]);
    expect(result.item.effects.find((effect) => effect.kind === 'worktree.remove').state).toBe('succeeded');
    expect((await driver.runtime.stopItem('project', item.id)).item.state).toBe('stopped');
    expect(driver.calls.removed).toHaveLength(1);
  });

  it('protects cleanup while an external write remains ambiguous', async () => {
    const driver = await fixture();
    const item = await driver.admit();
    driver.controls.loseOperation = 'pr.open';
    await driver.runtime.pump('project');
    await expect(driver.runtime.stopItem('project', item.id)).rejects.toMatchObject({ code: 'BOT_STOP_HAS_UNSETTLED_EFFECTS' });
    expect(driver.calls.removed).toEqual([]);
  });

  it('does not trust tool-supplied targets, commands or another session identity', async () => {
    const driver = await fixture({ held: ['fixing'] });
    const item = await driver.admit();
    await driver.runtime.pump('project');
    const current = (await driver.runtime.detail('project', item.id)).item;
    await expect(driver.runtime.handleTool({ sessionId: 'foreign', action: 'jira.comment', input: { operationId: 'write', body: 'hello' } })).rejects.toMatchObject({ code: 'BOT_SESSION_REQUIRED' });
    await expect(driver.runtime.handleTool({ sessionId: current.sessions.investigation, action: 'jira.comment', input: { operationId: 'write', body: 'hello' } })).rejects.toMatchObject({ code: 'BOT_FIXING_SESSION_REQUIRED' });
    await expect(driver.runtime.handleTool({ sessionId: current.sessions.fixing, action: 'jira.comment', input: { operationId: 'write', body: 'hello', target: { issueKey: 'OTHER-1' } } })).rejects.toThrow();
    expect(driver.calls.effects).toEqual([]);
    await driver.runtime.handleTool({ sessionId: current.sessions.fixing, action: 'jira.comment', input: { operationId: 'write', body: 'hello' } });
    await driver.runtime.handleTool({ sessionId: current.sessions.fixing, action: 'jira.comment', input: { operationId: 'write', body: 'hello' } });
    expect(driver.calls.effects).toHaveLength(1);
    await expect(driver.runtime.handleTool({ sessionId: current.sessions.fixing, action: 'jira.comment', input: { operationId: 'write', body: 'changed' } })).rejects.toMatchObject({ code: 'BOT_EFFECT_INPUT_CHANGED' });
  });

  it('reconciles managed scheduler rows when config changes', async () => {
    const driver = await fixture();
    const settings = await driver.config.read('project');
    settings.definitions[0].schedule = { kind: 'daily', time: '11:30', weekdays: [1], cron: '0 9 * * 1-5' };
    await driver.runtime.saveConfig('project', settings);
    expect(driver.calls.schedules[0][1][0]).toMatchObject({ id: 'bot-bugs', botManaged: true, botId: 'bugs', enabled: true, schedule: { kind: 'daily', times: ['11:30'] } });
  });

  it('rejects a stale stage completion and keeps previous item evidence on read failure', async () => {
    const driver = await fixture({ held: ['investigation'] });
    const item = await driver.admit();
    await driver.runtime.pump('project');
    driver.dependencies.stages.outcome = async () => { throw new Error('Read failed'); };
    await driver.runtime.pump('project');
    const current = (await driver.runtime.detail('project', item.id)).item;
    expect(current.state).toBe('needs-you');
    expect(current.evidence).toEqual([]);
    expect(current.sessions.investigation).toBeDefined();
    expect(driver.calls.sessions).toHaveLength(1);
    expect(driver.calls.effects).toEqual([]);
  });
});

describe('effect journal', () => {
  it('reconciles a crash after dispatch admission with the original immutable request', async () => {
    const driver = await fixture();
    const item = await driver.admit();
    const journal = createBotExecutionStore({ store: driver.store });
    const effects = createBotEffects({ store: driver.store, journal });
    const request = { body: 'original' };
    let sent = 0;
    const input = { projectId: 'project', itemId: item.id, key: 'comment', kind: 'jira.comment', authority: { service: 'jira', identityId: 'jira', revision: 1, target: 'BUG-1' }, request,
      execute: async () => { sent += 1; throw new Error('Response lost'); }, reconcile: async () => ({ state: 'outcome-unknown' }) };
    await expect(effects.run(input)).rejects.toMatchObject({ state: 'outcome-unknown' });
    await expect(effects.run(input)).rejects.toMatchObject({ state: 'outcome-unknown' });
    expect(sent).toBe(1);
    await expect(effects.run({ ...input, request: { body: 'changed' } })).rejects.toMatchObject({ code: 'BOT_EFFECT_AUTHORITY_CHANGED' });
    const receipt = await effects.run({ ...input, reconcile: async () => ({ state: 'succeeded', result: { id: 'authoritative-comment' } }) });
    expect(receipt.id).toBe('authoritative-comment');
    expect(sent).toBe(1);
  });
});

describe('bot HTTP contract', () => {
  it('runs actual routes and exposes proof absence, evidence and public identity methods', async () => {
    const driver = await fixture({ bot: { proof: undefined } });
    const app = express();
    registerBotRoutes(app, { botsRuntime: driver.runtime, identities: { async list() { return [{ id: 'public', configured: true }]; }, async create() { return { id: 'public', configured: true }; }, async update() { return { id: 'public' }; }, async remove() { return { removed: true }; } } });
    const base = '/api/projects/project/bots';
    const response = await request(app).post(`${base}/items`).send({ botId: 'bugs', source: { kind: 'manual', id: 'http' }, title: 'HTTP work' });
    expect(response.status).toBe(200);
    expect(response.body.item.state).toBe('merging');
    expect(response.body.item.proof).toEqual({ status: 'absent', reason: 'No server proof command configured' });
    expect(response.body.item.evidence).toHaveLength(2);
    expect(response.body.reports).toHaveProperty('judge:0');
    expect(JSON.stringify(response.body)).not.toContain('identityRevision');
    expect((await request(app).get(`${base}/identities`)).body).toEqual({ identities: [{ id: 'public', configured: true }] });
    expect((await request(app).post(`${base}/items`).send({ botId: 'bugs', source: { kind: 'manual', id: 'bad' } })).status).toBe(400);
    expect((await request(app).get('/api/projects/missing/bots')).status).toBe(404);
  });
});

describe('stage permission boundary', () => {
  it('uses read-only investigation and explicit correction MCP grants with accidental account guards', () => {
    const bot = { web: false, mcp: [{ server: 'jira', tools: { search: 'allow', comment: 'ask' } }], correctionMcp: [{ server: 'jira', tools: { search: 'allow' } }] };
    expect(botStagePermissions('investigation', bot)[0]).toEqual({ action: '*', resource: '*', effect: 'deny' });
    expect(botStagePermissions('judge', bot)).not.toContainEqual({ action: 'shell', resource: '*', effect: 'allow' });
    expect(botStagePermissions('fixing', bot)).toEqual(expect.arrayContaining([
      { action: '*_*', resource: '*', effect: 'deny' }, { action: 'jira_search', resource: '*', effect: 'allow' },
      { action: 'shell', resource: 'gh *', effect: 'deny' }, { action: 'shell', resource: 'git push*', effect: 'deny' },
    ]));
  });
});

describe('source admission and judgment', () => {
  it('reads Jira through the exact provider identity with pagination and the user limit', async () => {
    const calls = [];
    let discovered = 0;
    const sources = createBotSources({
      services: { async read(input) { calls.push(input); return calls.length === 1
        ? { issues: [{ key: 'BUG-1', summary: 'First', description: 'Description' }], nextPageToken: 'second' }
        : { issues: [{ key: 'BUG-2', summary: 'Second', description: 'Description' }, { key: 'BUG-3', summary: 'Third', description: 'Description' }], nextPageToken: null }; } },
      resolveJiraContext: async () => ({ identityId: 'jira', identityRevision: 4, site: 'https://example.atlassian.net' }),
      discover: async () => { discovered += 1; return []; },
    });
    const items = await sources.jira({ project: {}, bot: {}, jql: 'type = Bug', maxItems: 2 });
    expect(items.map((item) => item.source.id)).toEqual(['BUG-1', 'BUG-2']);
    expect(calls[1]).toMatchObject({ identityId: 'jira', identityRevision: 4, operation: 'jira.search', target: {}, input: { jql: 'type = Bug', maxResults: 1, nextPageToken: 'second' } });
    expect(discovered).toBe(0);
  });

  it('makes unresolved people a question while retaining fixed human review', () => {
    const result = admitBotJudgment({ output: { decision: 'auto', reason: 'Looks safe', reviewers: [], questions: [] },
      policy: { people: { status: 'unapproved', people: [] } },
      evaluation: { level: 'human', reason: 'Human area', owners: ['database-owner'], policyFingerprint: 'fingerprint' },
      snapshot: { headSha: 'head', baseSha: 'base' },
    });
    expect(result).toMatchObject({ requiresAnswer: true, judgment: { decision: 'review', questions: ['People directory needs approval'], reviewers: [] } });
  });
});
