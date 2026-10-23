import fs from 'node:fs/promises';
import path from 'node:path';
import { createOpenChamberSessionService } from '../openchamber-sessions/routes.js';
import { createBotStore } from './store.js';
import { createBotsConfig } from './config.js';
import { createBotStageSessions } from './stage-sessions.js';
import { createBotsRuntime } from './runtime.js';
import { createBotEvents } from './events.js';
import { createBotQuestions } from './questions.js';
import { operations } from './services/contracts.js';

const TEST_BASE = 'a'.repeat(40);
export const TEST_HEAD = 'b'.repeat(40);
const TEST_REGRESSION = 'c'.repeat(40);

/** Real coordinator, item/config parsers, disk journal and session-service owner.
 * Only process/provider boundaries are deterministic adapters. No network writes.
 */
export const createBotDriver = async (root, options = {}) => {
  await fs.mkdir(root, { recursive: true });
  const project = { id: 'project', path: root };
  let storedConfig = { definitions: [{ id: 'bugs', name: 'Bug bot', mission: 'Fix verified bugs', proof: { command: 'node', args: ['--test', '{files}'] }, ...options.bot }], ...options.config };
  const config = createBotsConfig({ projectConfigRuntime: {
    readBotsSection: async () => storedConfig,
    updateBotsSection: async (_id, change) => { storedConfig = await change(storedConfig); return storedConfig; },
  } });
  const clock = () => options.now ?? 1_792_700_000_000;
  const store = createBotStore({ projectsDirPath: path.join(root, 'personal'), now: clock });
  const calls = { sessions: [], prompts: [], permissions: [], modes: [], knowledge: [], effects: [], worktrees: [], removed: [], proofs: [], notices: [], attention: [], schedules: [], loops: [], published: [] };
  const records = new Map();
  const sessions = new Map();
  const held = new Set(options.held ?? []);
  const controls = { merged: false, approved: false, autoMerge: false, queued: false, headSha: TEST_HEAD, baseSha: TEST_BASE, remoteSha: null, changes: [{ newPath: 'src/fix.js' }], decision: options.decision ?? 'auto', questions: options.questions ?? [], reviewers: options.reviewers ?? [], failOperation: null, loseOperation: null, reconciliation: null, failStage: null, stageTokens: options.stageTokens ?? 7, providerCalls: 0 };
  const outputs = (stage) => stage === 'investigation' ? { summary: 'Verified bug', plan: 'Add test, then fix', evidence: [{ source: 'test', summary: 'Observed wrong result' }], questions: controls.questions, requestedRole: options.requestedRole }
    : stage === 'fixing' ? { summary: 'Fixed the cause', evidence: [{ source: 'test', summary: 'Regression now passes' }] }
      : { decision: controls.decision, reason: 'Reviewed the exact diff and evidence', reviewers: controls.reviewers, questions: controls.decision === 'ask' ? ['Confirm behavior?'] : [], requestedRole: options.requestedRole };
  const complete = (sessionId) => {
    const info = sessions.get(sessionId);
    const stage = info.metadata.openchamber.automation.stage;
    records.set(sessionId, [
      { id: `idle_${sessionId}`, type: 'idle', outcome: 'succeeded', time: { created: 10 } },
      { id: `reply_${sessionId}`, type: 'assistant', content: [{ type: 'text', text: JSON.stringify(outputs(stage)) }], tokens: { input: controls.stageTokens, output: 0 }, time: { created: 9 } },
    ]);
  };
  const client = {
    session: {
      async create(input) { const id = `ses_bot_${sessions.size + 1}`; const info = { ...input, id }; sessions.set(id, info); records.set(id, []); calls.sessions.push(input); return info; },
      async get({ sessionID }) { const info = sessions.get(sessionID); if (!info) throw new Error('Missing session'); return { data: info }; },
      async update({ sessionID, permissions }) { calls.permissions.push({ sessionID, permissions }); },
      async switchModel({ sessionID, model }) { sessions.get(sessionID).model = model; },
      async switchAgent({ sessionID, agent }) { sessions.get(sessionID).agent = agent; },
      async prompt({ sessionID, text }) {
        const info = sessions.get(sessionID);
        const stage = info.metadata.openchamber.automation.stage;
        const itemId = info.metadata.openchamber.automation.itemId;
        const item = (await store.read(project.id)).items.find((entry) => entry.id === itemId);
        if (item.sessions[stage] !== sessionID || !item.effects.some((effect) => effect.kind === 'session.prompt' && effect.state === 'dispatching')) throw new Error('Prompt preceded durable admission');
        calls.prompts.push({ sessionID, text, model: info.model });
        if (controls.failStage === stage) throw new Error('Lost prompt response');
        if (!held.has(stage)) complete(sessionID);
        return { id: `msg_${sessionID}` };
      },
      async interrupt({ sessionID }) { held.delete(sessions.get(sessionID).metadata.openchamber.automation.stage); },
      async synthetic() { return { id: 'msg_goal' }; },
    },
    message: { async list({ sessionID }) { return { data: records.get(sessionID) ?? [] }; } },
    model: { async list() { return { data: [{ providerID: 'test', modelID: 'model' }] }; } },
    agent: { async list() { return { data: [{ id: 'build', mode: 'primary' }] }; } },
    config: { async get() { return []; } },
    command: { async list() { return { data: [] }; } },
  };
  const knowledge = { async sync(...args) { calls.knowledge.push(args); } };
  const sessionService = createOpenChamberSessionService({
    dataDir: path.join(root, 'sessions'), readSettingsFromDiskMigrated: async () => ({ projects: [project], defaultModel: 'test/model', defaultAgent: 'build' }),
    sanitizeProjects: (projects) => projects, validateDirectoryPath: async (directory) => ({ ok: true, directory }),
    buildOpenCodeUrl: (route) => `http://127.0.0.1:1${route}`, getOpenCodeAuthHeaders: () => ({}),
    createOpenCodeClient: () => client, sessionKnowledgeRuntime: knowledge,
    resolveWorktreeTopLevel: async (directory) => ({ root: directory, prefix: '' }),
    createSessionGoal: async () => {},
  });
  const unavailable = async () => { throw Object.assign(new Error('Isolated bot adapter is unavailable'), { code: 'BOT_ISOLATION_UNAVAILABLE' }); };
  const stages = createBotStageSessions({ sessionService, clientFor: () => client,
    readSessionDefaults: async () => ({ providerID: 'test', modelID: 'model', agent: 'build' }),
    readTokenSnapshot: async () => controls.stageTokens,
    permissionAutoAcceptRuntime: { async setSessionPolicy(...args) { calls.modes.push(args); } },
    sessionKnowledgeRuntime: knowledge, activityProbe: { async fetchActiveSessionStatuses() { return {}; }, async hasWorkingChildren() { return false; } },
    isolated: { create: unavailable, dispatch: unavailable, outcome: unavailable, reconcile: unavailable, stop: unavailable },
  });
  const serviceContext = async () => ({ github: { identityId: 'github-account', identityRevision: 1, target: { repositoryId: 'repository', owner: 'owner', repo: 'repository' } }, jira: { identityId: 'jira-account', identityRevision: 1, target: { projectKey: 'BUG', issueKey: 'BUG-1' }, expectedStatusId: '3' } });
  const services = {
    async prepare(value) {
      const operation = operations[value.operation];
      const target = operation.target.parse(value.target);
      operation.input.parse(value.input);
      return { key: value.key, operation: value.operation, botId: value.botId, itemId: value.itemId,
        target, authority: { service: operation.service, identityId: value.identityId, identityRevision: value.identityRevision }, inputDigest: 'd'.repeat(64) };
    },
    async execute(prepared, input, { beforeDispatch } = {}) {
      await beforeDispatch?.();
      const item = (await store.read(project.id)).items.find((entry) => entry.id === prepared.itemId);
      if (!item.effects.some((effect) => effect.key === prepared.key && effect.state === 'dispatching')) throw new Error('Provider write preceded journal admission');
      calls.effects.push({ operation: prepared.operation, input, key: prepared.key, itemState: item.state });
      controls.providerCalls += 1;
      if (controls.failOperation === prepared.operation) throw Object.assign(new Error('Refused'), { code: 'TEST_REFUSED', state: 'refused' });
      if (controls.loseOperation === prepared.operation) throw Object.assign(new Error('Response lost'), { code: 'TEST_UNKNOWN', state: 'outcome-unknown' });
      const operation = prepared.operation;
      const result = operation === 'git.push' ? { headSha: input.headSha, sourceHeadSha: input.headSha }
        : operation === 'pr.open' ? { number: 42, head: input.branch, base: input.base, headSha: input.headSha }
          : operation === 'pr.auto-merge' ? { number: input.number, headSha: input.headSha, status: 'pending' }
            : ['pr.disable-auto-merge', 'pr.dequeue'].includes(operation) ? { number: input.number, headSha: controls.headSha, merged: controls.merged }
            : operation === 'jira.transition' ? { issueKey: 'BUG-1', statusId: input.expectedStatusId }
              : operations[operation].service === 'jira' ? { commentId: 'comment-1', issueKey: 'BUG-1' }
                : operation === 'pr.comment' ? { number: input.number, headSha: input.headSha, commentId: 44 } : { messageId: 'discord-1' };
      if (operation === 'git.push') controls.remoteSha = input.headSha;
      if (operation === 'pr.auto-merge') controls.autoMerge = true;
      if (operation === 'pr.disable-auto-merge') controls.autoMerge = false;
      if (operation === 'pr.dequeue') controls.queued = false;
      return { status: 'succeeded', result };
    },
    async reconcile() { return controls.reconciliation ?? { state: 'outcome-unknown' }; },
    async read({ operation, input }) {
      if (operation !== 'github.authorization') throw new Error('Unsupported fixture read');
      return { number: input.number, headSha: controls.headSha, baseSha: controls.baseSha,
        merged: controls.merged, autoMerge: controls.autoMerge, queued: controls.queued };
    },
  };
  const dependencies = { config, store, resolveProject: async (id) => { if (id !== project.id) throw Object.assign(new Error('Missing project'), { status: 404 }); return project; }, listProjects: async () => [project], stages, services, serviceContext,
    worktrees: {
      async create(request) { const directory = path.join(root, 'worktrees', request.item.id); await fs.mkdir(directory, { recursive: true }); calls.worktrees.push(request.item.id); return { directory, branch: `bot/${request.item.id}`, baseBranch: 'main', baseSha: TEST_BASE }; },
      async reconcile() { return { state: 'outcome-unknown' }; },
      async remove(request) { if (!request.checkout.directory.startsWith(path.join(root, 'worktrees'))) throw new Error('Unowned worktree'); calls.removed.push(request.item.id); await fs.rm(request.checkout.directory, { recursive: true }); },
      async inspect() { return { baseSha: controls.baseSha, headSha: controls.headSha, remoteSha: controls.remoteSha, baseBranch: 'main', diff: 'verified diff', changes: controls.changes, testSha: TEST_REGRESSION, fixSha: controls.headSha, testFiles: ['regression.test.js'] }; },
      async acceptPublished(input) { calls.published.push(input); },
    },
    async runProof(input) { calls.proofs.push(input); return { status: 'passed', testSha: input.testSha, fixSha: input.fixSha, command: input.command, args: input.args, testExitCode: 1, fixExitCode: 0 }; },
    pullRequests: { async ensureLoop(input) { calls.loops.push(input); }, async read() { return { headSha: controls.headSha, baseSha: controls.baseSha, merged: controls.merged, approved: controls.approved, mergeMode: 'auto-merge' }; }, async stop() {} },
    sources: { async jira() { return options.candidates ?? []; }, async investigate() { return options.candidates ?? []; } },
    attention: { async sync(input) { calls.attention.push(input); } }, notices: { async deliver(input) { calls.notices.push(input); } },
    scheduler: { async sync(...args) { calls.schedules.push(args); }, async remove() {} }, events: createBotEvents(), now: clock,
  };
  dependencies.questions = createBotQuestions({ ...dependencies, now: clock, context: {
    serviceContext: (request) => dependencies.serviceContext(request),
    github: async () => { throw new Error('Fixture GitHub blame is unavailable'); },
  } });
  const runtime = createBotsRuntime(dependencies);
  const admit = (source = { kind: 'manual', id: 'manual-1' }) => runtime.admit(project.id, 'bugs', { source, title: 'Fix a verified defect' });
  return { runtime, dependencies, project, config, store, calls, controls, sessions, stages, records, held, admit,
    complete: (stage) => { for (const [id, info] of sessions) if (info.metadata.openchamber.automation.stage === stage) complete(id); held.delete(stage); },
    restart: () => createBotsRuntime(dependencies),
  };
};
