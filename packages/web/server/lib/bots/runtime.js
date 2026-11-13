import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { withSourceControlFileLock } from '../source-control/file-lock.js';
import { createBotItem, TERMINAL_ITEM_STATES } from './schema.js';
import { createBotExecutionStore } from './execution-store.js';
import { botInputDigest, createBotEffects } from './effects.js';
import { approveRepositoryPolicy, evaluateRepositoryPolicy, readRepositoryPolicy } from './repository-policy.js';
import { botTaskFor } from './events.js';
import { botPresets } from './presets.js';
import { botServiceReceipt } from './service-receipts.js';
import { admitBotJudgment } from './judge-policy.js';
import { operations } from './services/contracts.js';
import { buildBotPrompt, buildBotPullRequestBody, evidenceSchema, parseBotStageOutput, sourceCandidateSchema } from './prompts.js';

const text = z.string().min(1).max(100_000);
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const projectSchema = z.object({ id: text, path: text });
const checkoutSchema = z.object({ directory: text, branch: text, baseBranch: text, baseSha: sha }).strict();
const snapshotSchema = z.object({
  baseSha: sha, headSha: sha, baseBranch: text, remoteSha: sha.nullable(), diff: z.string(),
  changes: z.array(z.object({ oldPath: text.nullable().optional(), newPath: text.nullable().optional() }).strict()),
  testSha: sha.optional(), fixSha: sha.optional(), testFiles: z.array(text).optional(),
}).strict();
const prStatusSchema = z.object({ headSha: sha, baseSha: sha, merged: z.boolean(), approved: z.boolean(), mergeMode: z.enum(['auto-merge', 'queue']) }).strict();
const bindingSchema = z.object({ identityId: text, identityRevision: z.number().int().positive(), target: z.json(), expectedStatusId: z.string().regex(/^[1-9][0-9]*$/).optional() }).strict();
const contextSchema = z.object({ github: bindingSchema.optional(), jira: bindingSchema.optional(), discord: bindingSchema.optional() }).strict();
const admissionFields = { key: text, number: z.number().int().positive(), branch: text, round: z.number().int().nonnegative(), headSha: sha, baseSha: sha,
  policyFingerprint: text, mode: z.enum(['auto-merge', 'queue']), binding: bindingSchema };
const admissionSchema = z.discriminatedUnion('state', [
  z.object({ ...admissionFields, state: z.literal('active') }).strict(),
  z.object({ ...admissionFields, state: z.literal('revoking'), action: z.enum(['judge', 'stop', 'disabled']) }).strict(),
  z.object({ ...admissionFields, state: z.enum(['revoked', 'merged']) }).strict(),
]);
const authorizationSchema = z.object({ number: z.number().int().positive(), headSha: sha, baseSha: sha,
  autoMerge: z.boolean(), queued: z.boolean(), merged: z.boolean() }).strict();
const remoteWarning = 'Remote auto-merge may still be active';
const toolOperations = ['git.push', 'pr.open', 'pr.comment', 'jira.comment', 'jira.transition', 'discord.send'];
const pendingToolSchema = z.discriminatedUnion('operation', toolOperations.map((operation) => z.object({
  key: text, operation: z.literal(operation), input: operations[operation].input,
}).strict()));
const questionAnswerSchema = z.object({ key: text, resumeState: z.enum(['investigating', 'fixing', 'judging']), round: z.number().int().nonnegative() }).strict();
const stageInterruptionSchema = z.object({ runId: z.string().regex(/^(investigation|fixing|judge):[0-9]+$/), sessionId: text }).strict();
const activeStates = new Set(['investigating', 'fixing', 'proving', 'judging', 'merging', 'closing']);
const humanStates = new Set(['needs-you', 'waiting-answer', 'in-review']);
const error = (code, status = 409) => Object.assign(new Error(code), { code, status });
const clean = (value) => JSON.parse(JSON.stringify(value));
const mergeEvidence = (left, right) => [...new Map([...left, ...right].map((entry) => [botInputDigest(entry), entry])).values()];

/** Persistent coordinator. Every external owner is explicitly injected. */
export const createBotsRuntime = ({ config, store, resolveProject, listProjects, stages, worktrees, services, serviceContext, runProof, pullRequests, sources, attention, notices, questions, scheduler, events, now = Date.now }) => {
  const required = {
    'config.read': config?.read, 'config.update': config?.update,
    'store.read': store?.read, 'store.update': store?.update, 'store.archive': store?.archive, 'store.readArchive': store?.readArchive, 'store.filePathFor': store?.filePathFor,
    resolveProject, listProjects, serviceContext, runProof,
    'stages.select': stages?.select, 'stages.create': stages?.create, 'stages.dispatch': stages?.dispatch, 'stages.outcome': stages?.outcome, 'stages.reconcile': stages?.reconcile, 'stages.stop': stages?.stop, 'stages.resume': stages?.resume,
    'worktrees.create': worktrees?.create, 'worktrees.reconcile': worktrees?.reconcile, 'worktrees.remove': worktrees?.remove, 'worktrees.inspect': worktrees?.inspect, 'worktrees.acceptPublished': worktrees?.acceptPublished,
    'services.prepare': services?.prepare, 'services.execute': services?.execute, 'services.reconcile': services?.reconcile, 'services.read': services?.read,
    'pullRequests.ensureLoop': pullRequests?.ensureLoop, 'pullRequests.read': pullRequests?.read, 'pullRequests.stop': pullRequests?.stop,
    'sources.jira': sources?.jira, 'sources.investigate': sources?.investigate,
    'attention.sync': attention?.sync, 'notices.deliver': notices?.deliver,
    'questions.ask': questions?.ask, 'questions.retry': questions?.retry, 'questions.answered': questions?.answered,
    'scheduler.sync': scheduler?.sync, 'scheduler.remove': scheduler?.remove,
    'events.publish': events?.publish, 'events.subscribe': events?.subscribe,
  };
  for (const [name, value] of Object.entries(required)) if (!(value instanceof Function)) throw new TypeError(`${name} is required by the bot runtime`);
  const journal = createBotExecutionStore({ store });
  const effects = createBotEffects({ store, journal, now });
  const pending = new Map();
  const dirty = new Set();
  const sessionIndex = new Map();
  const activeProofs = new Map();
  let stopped = false;
  let releaseEvents = null;

  const projectFor = async (projectId) => {
    const project = projectSchema.parse(await resolveProject(projectId));
    if (project.id !== projectId) throw error('BOT_PROJECT_MISMATCH');
    return project;
  };
  const itemFor = async (projectId, itemId) => {
    const item = (await store.read(projectId)).items.find((entry) => entry.id === itemId);
    if (!item) throw error('BOT_ITEM_NOT_FOUND', 404);
    return item;
  };
  const mutate = async (projectId, itemId, change) => {
    const snapshot = await store.update(projectId, (current) => ({ snapshot: { ...current, items: current.items.map((item) => item.id === itemId ? change(item) : item) } }));
    const item = snapshot.items.find((entry) => entry.id === itemId);
    if (!item) throw error('BOT_ITEM_NOT_FOUND', 404);
    for (const sessionId of Object.values(item.sessions)) sessionIndex.set(sessionId, { projectId, itemId });
    await attention.sync({ projectId, item });
    events.publish({ type: 'bot.item.changed', projectId, item });
    return item;
  };
  const saveData = async (projectId, itemId, patch) => journal.update(projectId, itemId, (entry) => ({ ...entry, data: { ...entry.data, ...clean(patch) } }));
  const transition = (projectId, itemId, state, patch = {}) => mutate(projectId, itemId, (item) => {
    const next = { ...item, ...patch, state };
    if (!humanStates.has(state)) delete next.wait;
    return next;
  });
  const needsYou = async (projectId, itemId, reason) => {
    const item = await itemFor(projectId, itemId);
    if (TERMINAL_ITEM_STATES.includes(item.state)) return item;
    if (item.state !== 'needs-you') {
      const execution = await journal.read(projectId, itemId);
      const question = execution.data.questions?.[execution.data.pendingQuestion];
      await saveData(projectId, itemId, { resumeState: question?.input.resumeState ?? item.state });
    }
    return transition(projectId, itemId, 'needs-you', { wait: { reason, since: now(), channel: 'ui', people: [] } });
  };
  const policyFor = async (projectId, project, snapshot) => {
    const policy = await readRepositoryPolicy(project.path, (await config.read(projectId)).approvals);
    return { policy, evaluation: evaluateRepositoryPolicy(policy, snapshot.changes) };
  };
  const localAuthority = (service, projectId, itemId) => ({ service, identityId: 'openchamber', revision: 1, target: `${projectId}:${itemId}` });

  const ensureCheckout = async (projectId, project, bot, item) => {
    const key = `${item.id}:worktree`;
    if (!item.effects.some((effect) => effect.key === key)) {
      const context = contextSchema.parse(await serviceContext({ project, bot, item, service: 'github', operation: 'github.checkout' }));
      if (!context.github) throw error('BOT_IDENTITY_REQUIRED');
    }
    const request = (await journal.read(projectId, item.id)).operations[key] ?? { project, bot, item: { id: item.id, botId: item.botId, source: item.source }, key };
    const record = async (result) => {
      const checkout = checkoutSchema.parse(result);
      if (checkout.branch !== `bot/${item.id}`) throw error('BOT_WORKTREE_BRANCH_MISMATCH');
      await saveData(projectId, item.id, { checkout });
      return { id: checkout.directory, sha: checkout.baseSha };
    };
    await effects.run({ projectId, itemId: item.id, key, kind: 'worktree.create', authority: localAuthority('git', projectId, item.id), request,
      execute: async () => record(await worktrees.create(request)),
      reconcile: async () => {
        const result = await worktrees.reconcile(request);
        return result.state === 'succeeded' ? { state: 'succeeded', result: await record(result.result) } : result;
      },
    });
    const checkout = checkoutSchema.parse((await journal.read(projectId, item.id)).data.checkout);
    if (item.worktree !== checkout.directory) return mutate(projectId, item.id, (current) => ({ ...current, worktree: checkout.directory, branch: checkout.branch }));
    return item;
  };

  const runStage = async (projectId, bot, item, stage, context = {}) => {
    let execution = await journal.read(projectId, item.id);
    const round = execution.data.round ?? 0;
    const runId = `${stage}:${round}`;
    let run = execution.data.runs?.[runId];
    if (!run) {
      run = clean({ stage, projectId, itemId: item.id, directory: item.worktree, bot,
        selection: await stages.select(projectId, bot, stage),
        prompt: buildBotPrompt({ stage, bot, item, ...context, feedback: execution.data.feedback }), dispatchedAt: now(), afterIdleId: null,
        tokenBaseline: item.tokens, context,
      });
      await saveData(projectId, item.id, { runs: { ...execution.data.runs, [runId]: run } });
    }
    const createKey = `${item.id}:${stage}:${round}:create`;
    await effects.run({ projectId, itemId: item.id, key: createKey, kind: 'session.create', authority: localAuthority('opencode', projectId, item.id), request: run,
      execute: async () => {
        const created = await stages.create(run, async ({ sessionId }) => {
          await mutate(projectId, item.id, (current) => ({ ...current, sessions: { ...current.sessions, [stage]: sessionId } }));
        });
        return { id: created.sessionId, sessionId: created.sessionId };
      },
      reconcile: async () => stages.reconcile('session.create', run, (await itemFor(projectId, item.id)).sessions[stage]),
    });
    item = await itemFor(projectId, item.id);
    const request = { ...run, sessionId: item.sessions[stage] };
    const promptKey = `${item.id}:${stage}:${round}:prompt`;
    if (!item.effects.some((effect) => effect.key === promptKey)) {
      const budget = await checkBudgets(projectId, bot, (await store.read(projectId)).items, item);
      if (budget) throw error(budget);
    }
    await effects.run({ projectId, itemId: item.id, key: promptKey, kind: 'session.prompt', authority: localAuthority('opencode', projectId, item.id), request,
      execute: () => stages.dispatch(request), reconcile: () => stages.reconcile('session.prompt', request, item.sessions[stage]),
    });
    execution = await journal.read(projectId, item.id);
    let outcome = execution.data.outcomes?.[runId];
    if (!outcome) {
      outcome = await stages.outcome(request);
      if (!outcome) return null;
      if (outcome.state !== 'completed') throw error(outcome.state === 'cancelled' ? 'BOT_STAGE_INTERRUPTED' : 'BOT_STAGE_FAILED');
      let output;
      try { output = parseBotStageOutput(stage, outcome.text); }
      catch { throw error('BOT_STAGE_OUTPUT_INVALID'); }
      outcome = { ...outcome, output };
      await saveData(projectId, item.id, { outcomes: { ...execution.data.outcomes, [runId]: outcome } });
    }
    // Reapplying a completion after a crash never charges the run twice.
    const usage = z.number().int().nonnegative().parse(outcome.tokens);
    const day = new Date(now()).toISOString().slice(0, 10);
    await mutate(projectId, item.id, (current) => {
      const stageTotal = Math.max(current.tokens.byStage[stage], run.tokenBaseline.byStage[stage] + usage);
      const delta = stageTotal - current.tokens.byStage[stage];
      return { ...current, evidence: mergeEvidence(current.evidence, outcome.output.evidence ?? []), tokens: {
        total: current.tokens.total + delta,
        byStage: { ...current.tokens.byStage, [stage]: stageTotal },
        byDay: { ...current.tokens.byDay, [day]: (current.tokens.byDay[day] ?? 0) + delta },
      } };
    });
    return outcome.output;
  };

  const external = async (projectId, project, bot, item, key, operation, input, { binding: fixedBinding, beforeDispatch, tool = false } = {}) => {
    const execution = await journal.read(projectId, item.id);
    const current = await itemFor(projectId, item.id);
    const effect = current.effects.find((entry) => entry.key === key);
    let request = execution.operations[key];
    if (!['pr.disable-auto-merge', 'pr.dequeue'].includes(operation)
      && (!effect || effect.state === 'prepared')
      && current.effects.some((entry) => entry.key !== key && ['dispatching', 'outcome-unknown'].includes(entry.state))) throw error('BOT_EFFECT_UNSETTLED');
    if (tool && effect?.state !== 'succeeded') {
      const pendingTool = execution.data.pendingTool ? pendingToolSchema.parse(execution.data.pendingTool) : null;
      if (pendingTool && pendingTool.key !== key && (!effect || effect.state === 'prepared')) throw error('BOT_EFFECT_UNSETTLED');
      if (!pendingTool || pendingTool.key === key) await saveData(projectId, item.id, { pendingTool: pendingToolSchema.parse({ key, operation, input: request?.input ?? input }) });
    }
    if (!request) {
      const service = operation.startsWith('jira.') ? 'jira' : operation === 'discord.send' ? 'discord' : 'github';
      const context = fixedBinding ? { github: fixedBinding } : contextSchema.parse(await serviceContext({ project, bot, item, service, operation }));
      const binding = context[service];
      if (!binding) throw error('BOT_IDENTITY_REQUIRED');
      const captured = execution.data.destinations?.[service];
      const identity = { identityId: binding.identityId, identityRevision: binding.identityRevision, target: binding.target };
      if (captured && botInputDigest(captured) !== botInputDigest(identity)) throw error('BOT_DESTINATION_CHANGED');
      if (!captured) await saveData(projectId, item.id, { destinations: { ...execution.data.destinations, [service]: identity } });
      const prepared = await services.prepare({ key, operation, botId: bot.id, itemId: item.id, ...identity, input });
      request = { prepared, input };
      if (operation === 'pr.auto-merge') request.authorization = (await journal.read(projectId, item.id)).data.admission;
      request = clean(request);
    }
    const capturedAuthority = request.prepared.authority;
    const record = async (result) => {
      const receipt = botServiceReceipt(request.prepared, result);
      const latest = await journal.read(projectId, item.id);
      await saveData(projectId, item.id, { serviceResults: { ...latest.data.serviceResults, [key]: result } });
      return receipt;
    };
    const receipt = await effects.run({ projectId, itemId: item.id, key, kind: operation,
      authority: { service: capturedAuthority.service, identityId: capturedAuthority.identityId, revision: capturedAuthority.identityRevision, target: JSON.stringify(request.prepared.target) },
      request, beforeDispatch, executePrepared: async (_request, claimDispatch) => record((await services.execute(request.prepared, request.input,
        { beforeAdmission: beforeDispatch, beforeDispatch: claimDispatch })).result), reconcile: async () => {
        const result = await services.reconcile(request.prepared, request.input);
        return result.state === 'succeeded' ? { state: 'succeeded', result: await record(result.result) } : result;
      },
    });
    if ((await journal.read(projectId, item.id)).data.pendingTool?.key === key) await saveData(projectId, item.id, { pendingTool: null });
    return receipt;
  };

  const publishPullRequest = async (projectId, project, bot, item, snapshot, tool = false) => {
    if (snapshot.remoteSha !== snapshot.headSha) {
      const key = `${item.id}:push:${snapshot.headSha}`;
      const pushed = await external(projectId, project, bot, item, key, 'git.push', {
        directory: item.worktree, branch: item.branch, headSha: snapshot.headSha, baseSha: snapshot.remoteSha ?? snapshot.baseSha, expectedRemoteSha: snapshot.remoteSha, base: snapshot.baseBranch,
      }, { tool });
      if (pushed.sha !== snapshot.headSha) {
        const result = (await journal.read(projectId, item.id)).data.serviceResults[key];
        await worktrees.acceptPublished({ project, bot, item, snapshot, result });
        await nextJudgeRound(projectId, item);
        return null;
      }
    }
    const receipt = await external(projectId, project, bot, item, `${item.id}:pr`, 'pr.open', {
      branch: item.branch, base: snapshot.baseBranch, headSha: snapshot.headSha, title: item.title,
      body: buildBotPullRequestBody(item, (await journal.read(projectId, item.id)).data.fixing?.summary ?? item.description), draft: false,
    }, { tool });
    const number = Number(receipt.id);
    if (!Number.isSafeInteger(number) || number < 1 || !receipt.url) throw error('BOT_PR_RECEIPT_INVALID');
    item = await mutate(projectId, item.id, (current) => ({ ...current, pr: { number, url: receipt.url, headSha: snapshot.headSha, baseSha: snapshot.baseSha } }));
    await pullRequests.ensureLoop({ project, bot, item });
    return item;
  };

  const freshAdmission = async (projectId, project, bot, item) => {
    const snapshot = snapshotSchema.parse(await worktrees.inspect({ project, bot, item }));
    const { evaluation } = await policyFor(projectId, project, snapshot);
    const judgment = item.judgment;
    if (!judgment || judgment.headSha !== snapshot.headSha || judgment.baseSha !== snapshot.baseSha || judgment.policyFingerprint !== evaluation.policyFingerprint) return null;
    if (evaluation.level === 'human' && judgment.decision === 'auto') return null;
    return snapshot;
  };

  const admissionFor = async (projectId, item) => {
    const execution = await journal.read(projectId, item.id);
    if (execution.data.admission) return admissionSchema.parse(execution.data.admission);
    // Old descriptors retain their exact key and identity, but cannot grant fresh dispatch.
    const effect = item.effects.findLast((entry) => entry.kind === 'pr.auto-merge');
    if (!effect || !item.pr) return null;
    const request = execution.operations[effect.key];
    if (!request) throw error('BOT_EFFECT_REQUEST_MISSING');
    const admission = admissionSchema.parse({ state: 'revoking', action: execution.data.stopRequested ? 'stop' : 'judge',
      key: effect.key, number: request.input.number, branch: `bot/${item.id}`, round: execution.data.round ?? 0, headSha: request.input.headSha,
      baseSha: item.judgment?.baseSha ?? item.pr.baseSha, policyFingerprint: item.judgment?.policyFingerprint ?? 'legacy',
      mode: request.input.mode, binding: { identityId: request.prepared.authority.identityId,
        identityRevision: request.prepared.authority.identityRevision, target: request.prepared.target } });
    await saveData(projectId, item.id, { admission });
    return admission;
  };
  const requestRevocation = async (projectId, item, action) => {
    let admission = await admissionFor(projectId, item);
    if (admission && !['revoked', 'merged'].includes(admission.state)) {
      admission = admissionSchema.parse({ ...admission, state: 'revoking', action });
      const update = { admission };
      if (action === 'stop') update.stopRequested = true;
      await saveData(projectId, item.id, update);
    } else if (action === 'stop') await saveData(projectId, item.id, { stopRequested: true });
    return admission;
  };
  const readAuthorization = async (admission) => authorizationSchema.parse(await services.read({
    ...admission.binding, operation: 'github.authorization', input: { number: admission.number, branch: admission.branch },
  }));
  const finishJudgeRound = async (projectId, item, round) => {
    await saveData(projectId, item.id, { round });
    return transition(projectId, item.id, 'judging', { judgment: undefined, proof: { status: 'absent', reason: 'Head, base or repository policy changed; admission requires a new verdict' } });
  };
  const settleRevocation = async (projectId, project, bot, item, admission) => {
    try {
      let original = item.effects.find((effect) => effect.key === admission.key);
      if (original?.state === 'prepared') {
        await mutate(projectId, item.id, (current) => ({ ...current, effects: current.effects.map((effect) => effect.key === original.key
          ? { ...effect, state: 'refused', code: 'BOT_ADMISSION_REVOKED', updatedAt: now() } : effect) }));
      }
      // Unknown admission must settle on its own evidence. Cancellation cannot prove it never arrived.
      if (original && ['dispatching', 'outcome-unknown'].includes(original.state)) {
        const request = (await journal.read(projectId, item.id)).operations[admission.key];
        try { await external(projectId, project, bot, item, admission.key, 'pr.auto-merge', request.input, { binding: admission.binding }); }
        catch { /* Still revoke observed authorization, then keep the owner blocked. */ }
      }
      for (const operation of ['pr.disable-auto-merge', 'pr.dequeue']) {
        await external(projectId, project, bot, item, `${admission.key}:${operation === 'pr.dequeue' ? 'dequeue' : 'disable'}`,
          operation, { number: admission.number, branch: admission.branch }, { binding: admission.binding });
      }
      const status = await readAuthorization(admission);
      if (status.merged) {
        await saveData(projectId, item.id, { admission: { ...admissionFieldsOf(admission), state: 'merged' }, mergedObservation: status });
        if (admission.action === 'judge' && ['merging', 'in-review'].includes(item.state)) {
          if (item.state === 'in-review') await transition(projectId, item.id, 'merging');
          await transition(projectId, item.id, 'closing');
          return true;
        }
        await needsYou(projectId, item.id, 'GitHub merged before revocation was confirmed');
        return false;
      }
      if (status.autoMerge || status.queued) throw error('BOT_REMOTE_AUTHORIZATION_ACTIVE');
      original = (await itemFor(projectId, item.id)).effects.find((effect) => effect.key === admission.key);
      if (original && ['dispatching', 'outcome-unknown'].includes(original.state)) throw error('BOT_ADMISSION_OUTCOME_UNKNOWN');
      if (admission.action === 'judge') {
        await pullRequests.stop({ project, bot, item });
        await finishJudgeRound(projectId, item, admission.round + 1);
      }
      else if (admission.action === 'disabled') await needsYou(projectId, item.id, 'BOT_NOT_ENABLED');
      await saveData(projectId, item.id, { round: admission.round + 1, admission: { ...admissionFieldsOf(admission), state: 'revoked' } });
      return true;
    } catch (failure) {
      await needsYou(projectId, item.id, `${remoteWarning}: ${failure?.code ?? 'BOT_REVOCATION_UNCONFIRMED'}`);
      return false;
    }
  };
  const admissionFieldsOf = ({ state: _state, action: _action, ...fields }) => fields;

  const authorizeMerge = async (projectId, project, bot, item, snapshot, status) => {
    let admission = await admissionFor(projectId, item);
    if (!admission || admission.state === 'revoked') {
      const round = (await journal.read(projectId, item.id)).data.round ?? 0;
      if (item.branch !== `bot/${item.id}`) throw error('BOT_WORKTREE_BRANCH_MISMATCH');
      const tuple = { number: item.pr.number, branch: item.branch, round, headSha: snapshot.headSha, baseSha: snapshot.baseSha,
        policyFingerprint: item.judgment.policyFingerprint, mode: status.mergeMode };
      const binding = contextSchema.parse(await serviceContext({ project, bot, item, service: 'github', operation: 'pr.auto-merge' })).github;
      if (!binding) throw error('BOT_IDENTITY_REQUIRED');
      admission = admissionSchema.parse({ ...tuple, key: `${item.id}:merge:${botInputDigest(tuple)}`, binding, state: 'active' });
      await saveData(projectId, item.id, { admission });
    }
    if (admission.state !== 'active') throw error('BOT_ADMISSION_REVOKED');
    const beforeDispatch = async () => {
      const current = await itemFor(projectId, item.id);
      const execution = await journal.read(projectId, item.id);
      const enabled = (await config.read(projectId)).definitions.some((definition) => definition.id === bot.id && definition.enabled);
      const local = await freshAdmission(projectId, project, bot, current);
      const remote = prStatusSchema.parse(await pullRequests.read({ project, bot, item: current }));
      if (!enabled || execution.data.stopRequested || execution.data.admission?.state !== 'active'
        || execution.data.admission.key !== admission.key || (execution.data.round ?? 0) !== admission.round
        || !['merging', 'in-review'].includes(current.state) || !local || local.headSha !== admission.headSha
        || current.pr?.number !== admission.number || current.branch !== admission.branch
        || local.baseSha !== admission.baseSha || current.judgment.policyFingerprint !== admission.policyFingerprint
        || remote.headSha !== admission.headSha || remote.baseSha !== admission.baseSha || remote.mergeMode !== admission.mode
        || remote.merged || current.judgment.decision !== 'auto' && !remote.approved) {
        await requestRevocation(projectId, current, execution.data.stopRequested ? 'stop' : !enabled ? 'disabled' : 'judge');
        throw Object.assign(error('BOT_ADMISSION_STALE'), { state: 'refused' });
      }
    };
    await external(projectId, project, bot, item, admission.key, 'pr.auto-merge', { number: item.pr.number,
      headSha: admission.headSha, baseSha: admission.baseSha, branch: item.branch, mode: admission.mode, mergeMethod: 'SQUASH' },
    { binding: admission.binding, beforeDispatch });
  };

  const cleanup = async (projectId, project, bot, item) => {
    const key = `${item.id}:cleanup`;
    const execution = await journal.read(projectId, item.id);
    const request = execution.operations[key] ?? { project, bot,
      item: { id: item.id, worktree: item.worktree, branch: item.branch }, checkout: checkoutSchema.parse(execution.data.checkout) };
    return effects.run({ projectId, itemId: item.id, key, kind: 'worktree.remove', authority: localAuthority('git', projectId, item.id), request,
      execute: async (captured) => { await worktrees.remove(captured); return { id: item.id }; },
      reconcile: (captured) => worktrees.reconcile({ ...captured, operation: 'remove' }),
    });
  };

  const close = async (projectId, project, bot, item) => {
    await pullRequests.stop({ project, bot, item });
    if (item.source.kind === 'jira') {
      await external(projectId, project, bot, item, `${item.id}:jira:comment`, 'jira.comment', { body: buildBotPullRequestBody(item, `Merged: ${item.pr.url}`) });
      const key = `${item.id}:jira:transition`;
      const captured = (await journal.read(projectId, item.id)).operations[key];
      if (captured || bot.jira?.doneTransition) {
        let input = captured?.input;
        if (!captured) {
          const binding = contextSchema.parse(await serviceContext({ project, bot, item, service: 'jira', operation: 'jira.transition' })).jira;
          if (!binding?.expectedStatusId) throw error('BOT_JIRA_STATUS_REQUIRED');
          input = { transitionId: bot.jira.doneTransition, expectedStatusId: binding.expectedStatusId };
        }
        await external(projectId, project, bot, item, key, 'jira.transition', input);
      }
    }
    await cleanup(projectId, project, bot, item);
    return transition(projectId, item.id, 'done');
  };

  const nextJudgeRound = async (projectId, item) => {
    const execution = await journal.read(projectId, item.id);
    const admission = await requestRevocation(projectId, item, 'judge');
    if (admission?.state === 'revoking') return;
    return finishJudgeRound(projectId, item, (execution.data.round ?? 0) + 1);
  };

  const advance = async (projectId, project, bot, initial) => {
    let item = initial;
    let admission = await admissionFor(projectId, item);
    const execution = await journal.read(projectId, item.id);
    if (admission?.state === 'merged' && execution.data.stopRequested) return;
    if (admission?.state === 'active' && item.state !== 'closing') {
      if (execution.data.stopRequested || !bot.enabled || !['merging', 'in-review', 'needs-you'].includes(item.state)) {
        admission = await requestRevocation(projectId, item, execution.data.stopRequested ? 'stop' : !bot.enabled ? 'disabled' : 'judge');
      } else if (item.state === 'needs-you') {
        const status = prStatusSchema.parse(await pullRequests.read({ project, bot, item }));
        const snapshot = await freshAdmission(projectId, project, bot, item);
        if (!snapshot || snapshot.headSha !== status.headSha || snapshot.baseSha !== status.baseSha
          || snapshot.headSha !== admission.headSha || snapshot.baseSha !== admission.baseSha
          || item.judgment.policyFingerprint !== admission.policyFingerprint || status.mergeMode !== admission.mode) {
          admission = await requestRevocation(projectId, item, 'judge');
        }
      }
    }
    if (admission?.state === 'revoking') {
      if (!await settleRevocation(projectId, project, bot, item, admission)) return;
      item = await itemFor(projectId, item.id);
      if (item.state === 'closing') return true;
    }
    if (execution.data.stopRequested) { await finishStop(projectId, project, bot, item); return; }
    if (execution.data.questionAnswer && !execution.data.pendingQuestion) return finishQuestionAnswer(projectId, project, bot, item.id);
    if (execution.data.pendingTool) {
      const request = pendingToolSchema.parse(execution.data.pendingTool);
      await needsYou(projectId, item.id, item.effects.find((entry) => entry.key === request.key)?.code ?? 'BOT_TOOL_OPERATION_PENDING');
      return;
    }
    if (execution.data.pendingQuestion) {
      if (bot.enabled && ['investigating', 'fixing', 'judging'].includes(item.state)) await questions.retry({ project, bot, itemId: item.id });
      return;
    }
    if (!bot.enabled || ['needs-you', 'waiting-answer'].includes(item.state)) return;
    if (item.state === 'queued') item = await transition(projectId, item.id, 'investigating');
    if (item.state === 'investigating') {
      item = await ensureCheckout(projectId, project, bot, item);
      const investigation = await runStage(projectId, bot, item, 'investigation');
      if (!investigation) return;
      await saveData(projectId, item.id, { investigation });
      if (investigation.questions.length) {
        const round = (await journal.read(projectId, item.id)).data.round ?? 0;
        const request = { project, bot, itemId: item.id, eventId: `investigation:${round}`, questions: investigation.questions, resumeState: 'fixing' };
        if (investigation.requestedRole) request.requestedRole = investigation.requestedRole;
        await questions.ask(request);
        return;
      }
      item = await transition(projectId, item.id, 'fixing');
    }
    if (item.state === 'fixing') {
      const execution = await journal.read(projectId, item.id);
      const fixing = await runStage(projectId, bot, item, 'fixing', { investigation: execution.data.investigation });
      if (!fixing) return;
      await saveData(projectId, item.id, { fixing });
      item = await transition(projectId, item.id, 'proving');
    }
    if (item.state === 'proving') {
      const snapshot = snapshotSchema.parse(await worktrees.inspect({ project, bot, item }));
      await saveData(projectId, item.id, { snapshot });
      let proof = { status: 'absent', reason: 'No server proof command configured' };
      if (bot.proof && snapshot.testSha && snapshot.fixSha && snapshot.testFiles?.length) {
        const key = JSON.stringify([projectId, item.id]);
        const controller = new AbortController();
        activeProofs.set(key, controller);
        try {
          if (stopped || (await journal.read(projectId, item.id)).data.stopRequested) controller.abort();
          proof = await runProof({
            directory: item.worktree, testSha: snapshot.testSha, fixSha: snapshot.fixSha, testFiles: snapshot.testFiles,
            command: bot.proof.command, args: bot.proof.args, isolated: bot.isolated, item,
          }, { signal: controller.signal });
          if (controller.signal.aborted) {
            await mutate(projectId, item.id, (current) => ({ ...current, proof }));
            return !stopped;
          }
        } finally { activeProofs.delete(key); }
      }
      else if (bot.proof) proof = { status: 'absent', reason: 'The server did not observe separate regression and fix commits with test files' };
      item = await transition(projectId, item.id, 'judging', { proof });
    }
    if (item.state === 'judging') {
      const snapshot = snapshotSchema.parse(await worktrees.inspect({ project, bot, item }));
      if (item.proof.status !== 'absent' && item.proof.fixSha !== snapshot.headSha) item = await mutate(projectId, item.id, (current) => ({ ...current, proof: { status: 'absent', reason: 'The observed head differs from the server proof head' } }));
      const { policy, evaluation } = await policyFor(projectId, project, snapshot);
      const output = await runStage(projectId, bot, item, 'judge', { snapshot, policy: { ...evaluation, people: policy.people } });
      if (!output) return;
      // The judge's captured input must match the head and policy read now.
      const execution = await journal.read(projectId, item.id);
      const run = execution.data.runs[`judge:${execution.data.round ?? 0}`];
      const captured = run.context;
      if (captured.snapshot.headSha !== snapshot.headSha || captured.snapshot.baseSha !== snapshot.baseSha || captured.policy.policyFingerprint !== evaluation.policyFingerprint) {
        await nextJudgeRound(projectId, item); return true;
      }
      const { judgment, requiresAnswer } = admitBotJudgment({ output, policy, evaluation, snapshot });
      const { decision } = judgment;
      item = await mutate(projectId, item.id, (current) => ({ ...current, judgment }));
      if (requiresAnswer) {
        const round = (await journal.read(projectId, item.id)).data.round ?? 0;
        const request = { project, bot, itemId: item.id, eventId: `judge:${round}`, questions: judgment.questions.length ? judgment.questions : [judgment.reason], people: output.reviewers, resumeState: 'judging' };
        if (output.requestedRole) request.requestedRole = output.requestedRole;
        await questions.ask(request);
        return;
      }
      item = await publishPullRequest(projectId, project, bot, await itemFor(projectId, item.id), snapshot);
      if (item === null) return true;
      item = await transition(projectId, item.id, decision === 'auto' ? 'merging' : 'in-review');
    }
    if (item.state === 'in-review' || item.state === 'merging') {
      const status = prStatusSchema.parse(await pullRequests.read({ project, bot, item }));
      if (status.merged) {
        if (admission?.state === 'active') await saveData(projectId, item.id, {
          admission: { ...admissionFieldsOf(admission), state: 'merged' }, mergedObservation: status,
        });
        if (item.state === 'in-review') item = await transition(projectId, item.id, 'merging');
        item = await transition(projectId, item.id, 'closing');
      } else {
        const snapshot = await freshAdmission(projectId, project, bot, item);
        const admission = await admissionFor(projectId, item);
        if (!snapshot || status.headSha !== snapshot.headSha || status.baseSha !== snapshot.baseSha
          || admission?.state === 'active' && (admission.headSha !== snapshot.headSha || admission.baseSha !== snapshot.baseSha
            || admission.policyFingerprint !== item.judgment.policyFingerprint || admission.mode !== status.mergeMode)) {
          await nextJudgeRound(projectId, item); return true;
        }
        if (item.state === 'in-review' && !status.approved) return;
        if (item.state === 'in-review') item = await transition(projectId, item.id, 'merging');
        await authorizeMerge(projectId, project, bot, item, snapshot, status);
        return;
      }
    }
    if (item.state === 'closing') await close(projectId, project, bot, item);
  };

  const checkBudgets = async (projectId, bot, items, item) => {
    const day = new Date(now()).toISOString().slice(0, 10);
    const archived = await store.readArchive(projectId);
    const discovery = sources.usage ? await sources.usage({ projectId, botId: bot.id, day }) : { dailyTotal: 0, complete: true };
    if (bot.limits.dailyTokens !== null && !discovery.complete) return 'BOT_SOURCE_USAGE_UNAVAILABLE';
    const usage = discovery.dailyTotal + [...items, ...archived].filter((entry) => entry.botId === bot.id).reduce((sum, entry) => sum + (entry.tokens.byDay[day] ?? 0), 0);
    if (bot.limits.dailyTokens !== null && usage >= bot.limits.dailyTokens) return 'BOT_DAILY_TOKEN_BUDGET';
    if (item && bot.goalTokenBudget !== null && item.tokens.total >= bot.goalTokenBudget) return 'BOT_GOAL_TOKEN_BUDGET';
    if (item?.state === 'queued' && bot.limits.maxPendingHuman !== null && items.filter((entry) => entry.botId === bot.id && humanStates.has(entry.state)).length >= bot.limits.maxPendingHuman) return 'BOT_PENDING_HUMAN_LIMIT';
    return null;
  };
  const pump = (projectId) => {
    if (stopped) return Promise.resolve();
    if (pending.has(projectId)) { dirty.add(projectId); return pending.get(projectId); }
    const operation = withSourceControlFileLock(`${store.filePathFor(projectId)}.owner.lock`, async () => {
      const project = await projectFor(projectId);
      const settings = await config.read(projectId);
      let items = (await store.read(projectId)).items;
      let active = items.filter((item) => activeStates.has(item.state)).length;
      for (const initial of items) {
        if (stopped) break;
        for (const sessionId of Object.values(initial.sessions)) sessionIndex.set(sessionId, { projectId, itemId: initial.id });
        await attention.sync({ projectId, item: initial });
        if (TERMINAL_ITEM_STATES.includes(initial.state)) continue;
        const bot = settings.definitions.find((entry) => entry.id === initial.botId) ?? { id: initial.botId, enabled: false };
        const recovery = await journal.read(projectId, initial.id);
        const hasAdmission = initial.effects.some((effect) => effect.kind === 'pr.auto-merge') || recovery.data.admission;
        const pendingToolNeedsAttention = recovery.data.pendingTool && initial.state !== 'needs-you';
        const answeredQuestionNeedsRecovery = bot.enabled && recovery.data.questionAnswer && !recovery.data.pendingQuestion && initial.state !== 'needs-you';
        if (!hasAdmission && !recovery.data.stopRequested && !pendingToolNeedsAttention && !answeredQuestionNeedsRecovery && (['needs-you', 'waiting-answer'].includes(initial.state) || !bot.enabled)) continue;
        if (initial.state === 'queued' && active >= settings.concurrency) continue;
        const budget = bot.enabled && !recovery.data.stopRequested && recovery.data.admission?.state !== 'revoking'
          && ['queued', 'investigating', 'fixing', 'judging'].includes(initial.state) ? await checkBudgets(projectId, bot, items, initial) : null;
        if (budget) {
          if (initial.state !== 'queued') await needsYou(projectId, initial.id, budget);
          continue;
        }
        if (initial.state === 'queued') active += 1;
        try {
          let again = await advance(projectId, project, bot, initial);
          while (again && !stopped) again = await advance(projectId, project, bot, await itemFor(projectId, initial.id));
        }
        catch (failure) {
          const admission = await admissionFor(projectId, await itemFor(projectId, initial.id));
          if (admission?.state === 'revoking') dirty.add(projectId);
          await needsYou(projectId, initial.id, failure?.code ?? 'BOT_OPERATION_FAILED');
        }
        const current = await itemFor(projectId, initial.id);
        if (activeStates.has(initial.state) || initial.state === 'queued') if (!activeStates.has(current.state)) active -= 1;
        items = (await store.read(projectId)).items;
      }
      await store.archive(projectId, { before: Math.max(0, now() - settings.retentionDays * 86_400_000) });
    }, { waitMs: 0 }).catch((failure) => {
      if (failure?.code !== 'SOURCE_CONTROL_LOCK_BUSY') throw failure;
    }).finally(() => {
      pending.delete(projectId);
      if (dirty.delete(projectId) && !stopped) return pump(projectId);
    });
    pending.set(projectId, operation);
    return operation;
  };

  const admit = async (projectId, botId, raw) => withSourceControlFileLock(`${store.filePathFor(projectId)}.owner.lock`, async () => {
    await projectFor(projectId);
    const settings = await config.read(projectId);
    const bot = settings.definitions.find((entry) => entry.id === botId);
    if (!bot?.enabled) throw error('BOT_NOT_ENABLED');
    const candidate = sourceCandidateSchema.parse(raw);
    // Archived origins remain deduplication authority.
    const archived = await store.readArchive(projectId);
    const existingArchive = archived.find((entry) => entry.botId === botId && entry.source.kind === candidate.source.kind && entry.source.id === candidate.source.id);
    if (existingArchive) return existingArchive;
    const id = randomUUID();
    const snapshot = await store.update(projectId, (current) => {
      const existing = current.items.find((entry) => entry.botId === botId && entry.source.kind === candidate.source.kind && entry.source.id === candidate.source.id);
      if (existing) return { result: current };
      const item = createBotItem({ id, botId, source: candidate.source, title: candidate.title, description: candidate.description, now: now() });
      return { snapshot: { ...current, items: [...current.items, { ...item, evidence: candidate.evidence }] } };
    });
    const item = snapshot.items.find((entry) => entry.id === id) ?? snapshot.items.find((entry) => entry.botId === botId && entry.source.kind === candidate.source.kind && entry.source.id === candidate.source.id);
    events.publish({ type: 'bot.item.changed', projectId, item });
    return item;
  }, { waitMs: 10_000 });
  const runScheduled = async (projectId, botId, occurrence) => {
    const project = await projectFor(projectId);
    const bot = (await config.read(projectId)).definitions.find((entry) => entry.id === botId);
    if (!bot?.enabled) throw error('BOT_NOT_ENABLED');
    text.parse(occurrence);
    const budget = await checkBudgets(projectId, bot, (await store.read(projectId)).items, null);
    if (budget) throw error(budget);
    const results = bot.source.kind === 'manual' ? [] : await (bot.source.kind === 'jira'
      ? sources.jira({ project, bot, jql: bot.source.jql, maxItems: bot.source.maxItems })
      : sources.investigate({ project, bot, occurrence, maxItems: bot.source.maxItems }));
    const candidates = z.array(sourceCandidateSchema).parse(results);
    const items = [];
    for (const candidate of candidates.slice(0, bot.source.kind === 'manual' ? 0 : bot.source.maxItems)) items.push(await admit(projectId, botId, candidate));
    await pump(projectId);
    return { items, skipped: candidates.length === 0 };
  };
  const detail = async (projectId, itemId) => {
    await projectFor(projectId);
    const item = (await store.read(projectId)).items.find((entry) => entry.id === itemId)
      ?? (await store.readArchive(projectId)).find((entry) => entry.id === itemId);
    if (!item) throw error('BOT_ITEM_NOT_FOUND', 404);
    const execution = await journal.read(projectId, itemId);
    return { item, reports: execution.data.outcomes ?? {}, snapshot: execution.data.snapshot ?? null };
  };
  const saveConfig = async (projectId, input) => {
    await projectFor(projectId);
    const previous = await config.read(projectId);
    const settings = await config.update(projectId, input);
    // Failure remains visible. A repeated save safely reconciles the same rows.
    await scheduler.sync(projectId, settings.definitions.map(botTaskFor));
    for (const bot of previous.definitions) if (!settings.definitions.some((entry) => entry.id === bot.id)) await scheduler.remove(projectId, bot.id);
    await pump(projectId);
    return { config: settings };
  };
  const resume = async (projectId, itemId) => {
    await withSourceControlFileLock(`${store.filePathFor(projectId)}.owner.lock`, async () => {
      const item = await itemFor(projectId, itemId);
      const execution = await journal.read(projectId, itemId);
      if (item.state !== 'needs-you' && !(item.state === 'waiting-answer' && execution.data.pendingQuestion)) throw error('BOT_ITEM_NOT_WAITING');
      if (execution.data.stopRequested || execution.data.admission?.state === 'revoking') return;
      const bot = (await config.read(projectId)).definitions.find((entry) => entry.id === item.botId);
      if (!bot?.enabled) throw error('BOT_NOT_ENABLED');
      const budget = await checkBudgets(projectId, bot, (await store.read(projectId)).items, item);
      if (budget) throw error(budget);
      if (execution.data.pendingQuestion) {
        await questions.retry({ project: await projectFor(projectId), bot, itemId });
        if (execution.data.questionAnswer) await finishQuestionAnswer(projectId, await projectFor(projectId), bot, itemId);
        return;
      }
      if (execution.data.questionAnswer) {
        await finishQuestionAnswer(projectId, await projectFor(projectId), bot, itemId, true);
        return;
      }
      const state = execution.data.resumeState;
      if (!state) throw error('BOT_RESUME_STATE_MISSING');
      if (execution.data.interruptedStage) {
        const interruption = stageInterruptionSchema.parse(execution.data.interruptedStage);
        const run = execution.data.runs[interruption.runId];
        if (!run || item.sessions[run.stage] !== interruption.sessionId) throw error('BOT_INTERRUPTED_STAGE_MISMATCH');
        const request = { ...run, sessionId: interruption.sessionId };
        await stages.resume(request);
        for (const suffix of ['create', 'prompt']) {
          const key = `${itemId}:${interruption.runId}:${suffix}`;
          const effect = item.effects.find((entry) => entry.key === key);
          if (effect && ['dispatching', 'outcome-unknown'].includes(effect.state)) await effects.recover({ projectId, itemId, key,
            reconcile: () => stages.reconcile(effect.kind, request, interruption.sessionId) });
        }
        await saveData(projectId, itemId, { round: (execution.data.round ?? 0) + (execution.data.outcomes?.[interruption.runId] ? 0 : 1), interruptedStage: null });
      }
      if (execution.data.pendingTool) {
        const request = pendingToolSchema.parse(execution.data.pendingTool);
        try { await external(projectId, await projectFor(projectId), bot, item, request.key, request.operation, request.input); }
        catch (failure) { await needsYou(projectId, itemId, failure?.code ?? 'BOT_OPERATION_FAILED'); return; }
      }
      await transition(projectId, itemId, state);
    }, { waitMs: 10_000 });
    await pump(projectId);
    return detail(projectId, itemId);
  };
  const deliverFeedback = async (projectId, itemId, raw) => {
    const feedback = z.object({ eventId: text, text }).strict().parse(raw);
    const item = await itemFor(projectId, itemId);
    if (TERMINAL_ITEM_STATES.includes(item.state)) return { ignored: true };
    const execution = await journal.read(projectId, itemId);
    if (Object.hasOwn(execution.data.delivered ?? {}, feedback.eventId)) return { duplicate: true };
    // Admission precedes delivery. The queue adapter uses this same event ID.
    const feedbackQuestions = { ...execution.data.feedbackQuestions };
    if (!Object.hasOwn(feedbackQuestions, feedback.eventId)) feedbackQuestions[feedback.eventId] = execution.data.pendingQuestion ?? null;
    await saveData(projectId, itemId, { feedback: { ...execution.data.feedback, [feedback.eventId]: feedback }, feedbackQuestions });
    const admission = await admissionFor(projectId, item);
    if (admission?.state === 'active' || admission?.state === 'revoking') {
      const project = await projectFor(projectId);
      const bot = (await config.read(projectId)).definitions.find((entry) => entry.id === item.botId) ?? { id: item.botId, enabled: false };
      const pendingRevocation = await requestRevocation(projectId, item, execution.data.stopRequested ? 'stop' : !bot.enabled ? 'disabled' : 'judge');
      if (!await settleRevocation(projectId, project, bot, item, pendingRevocation)) throw error('BOT_REMOTE_AUTHORIZATION_UNCONFIRMED');
    }
    if (execution.data.stopRequested || (await admissionFor(projectId, item))?.state === 'merged') throw error('BOT_ADMISSION_REVOKED');
    if (!(await config.read(projectId)).definitions.some((bot) => bot.id === item.botId && bot.enabled)) throw error('BOT_NOT_ENABLED');
    await notices.deliver({ projectId, item, ...feedback });
    const latest = await journal.read(projectId, itemId);
    await saveData(projectId, itemId, { delivered: { ...latest.data.delivered, [feedback.eventId]: true } });
    return { delivered: true };
  };
  const receiveFeedback = (projectId, itemId, raw) => withSourceControlFileLock(`${store.filePathFor(projectId)}.owner.lock`, () => deliverFeedback(projectId, itemId, raw), { waitMs: 10_000 });
  const refuseUnsentQuestion = async (projectId, itemId, key, code) => {
    const item = await itemFor(projectId, itemId);
    if (!item.effects.some((effect) => effect.key === key && effect.state === 'prepared')) return item;
    return mutate(projectId, itemId, (current) => ({ ...current, effects: current.effects.map((effect) => effect.key === key && effect.state === 'prepared'
      ? { ...effect, state: 'refused', code, updatedAt: now() } : effect) }));
  };
  const finishQuestionAnswer = async (projectId, project, bot, itemId, explicitResume = false) => {
    const execution = await journal.read(projectId, itemId);
    const intent = questionAnswerSchema.parse(execution.data.questionAnswer);
    if (execution.data.pendingQuestion && execution.data.pendingQuestion !== intent.key) throw error('BOT_QUESTION_PENDING');
    await questions.answered({ projectId, itemId });
    const item = await itemFor(projectId, itemId);
    if ((item.state === 'needs-you' && !explicitResume) || !bot.enabled) return false;
    const budget = await checkBudgets(projectId, bot, (await store.read(projectId)).items, item);
    if (budget) { await needsYou(projectId, itemId, budget); return false; }
    if (intent.resumeState === 'judging') await saveData(projectId, itemId, { round: intent.round });
    if (item.state !== intent.resumeState) await transition(projectId, itemId, intent.resumeState);
    await saveData(projectId, itemId, { questionAnswer: null });
    return true;
  };
  const answer = async (projectId, itemId, input) => {
    let progressed = false;
    await withSourceControlFileLock(`${store.filePathFor(projectId)}.owner.lock`, async () => {
      const item = await itemFor(projectId, itemId);
      const feedback = z.object({ eventId: text, text }).strict().parse(input);
      const previous = await journal.read(projectId, itemId);
      if (Object.hasOwn(previous.data.feedbackQuestions ?? {}, feedback.eventId)
        && previous.data.feedbackQuestions[feedback.eventId] !== (previous.data.pendingQuestion ?? previous.data.questionAnswer?.key ?? null)) return;
      if (previous.data.questionAnswer && !previous.data.pendingQuestion) {
        const bot = (await config.read(projectId)).definitions.find((entry) => entry.id === item.botId);
        if (!bot) throw error('BOT_DEFINITION_REQUIRED');
        progressed = await finishQuestionAnswer(projectId, await projectFor(projectId), bot, itemId);
        return;
      }
      if (!['waiting-answer', 'needs-you'].includes(item.state)) {
        if (Object.hasOwn(previous.data.delivered ?? {}, feedback.eventId)) return;
        throw error('BOT_ITEM_NOT_WAITING');
      }
      await deliverFeedback(projectId, itemId, feedback);
      const execution = await journal.read(projectId, itemId);
      if (execution.data.pendingQuestion) {
        await refuseUnsentQuestion(projectId, itemId, execution.data.pendingQuestion, 'BOT_QUESTION_ANSWERED');
        const question = execution.data.questions[execution.data.pendingQuestion];
        await saveData(projectId, itemId, { questionAnswer: questionAnswerSchema.parse({ key: execution.data.pendingQuestion,
          resumeState: question.input.resumeState, round: (execution.data.round ?? 0) + (question.input.resumeState === 'judging' ? 1 : 0) }) });
        const bot = (await config.read(projectId)).definitions.find((entry) => entry.id === item.botId);
        if (!bot) throw error('BOT_DEFINITION_REQUIRED');
        progressed = await finishQuestionAnswer(projectId, await projectFor(projectId), bot, itemId);
        return;
      }
      if (item.state === 'needs-you') return;
      const target = execution.data.resumeState;
      if (target === 'judging') await saveData(projectId, itemId, { round: (execution.data.round ?? 0) + 1 });
      await transition(projectId, itemId, target ?? 'fixing');
      progressed = true;
    }, { waitMs: 10_000 });
    if (progressed) await pump(projectId);
    return detail(projectId, itemId);
  };
  const finishStop = async (projectId, project, bot, item) => {
    const itemId = item.id;
    await pullRequests.stop({ project, bot, item });
    for (const sessionId of Object.values(item.sessions)) await stages.stop({ bot, sessionId, directory: item.worktree });
    let current = await itemFor(projectId, itemId);
    const execution = await journal.read(projectId, itemId);
    if (execution.data.pendingTool) {
      const request = pendingToolSchema.parse(execution.data.pendingTool);
      const effect = current.effects.find((entry) => entry.key === request.key);
      if (!effect || effect.state === 'prepared') {
        if (effect) current = await mutate(projectId, itemId, (item) => ({ ...item, effects: item.effects.map((entry) => entry.key === request.key
          ? { ...entry, state: 'refused', code: 'BOT_STOP_REQUESTED', updatedAt: now() } : entry) }));
        await saveData(projectId, itemId, { pendingTool: null });
      }
    }
    if (execution.data.pendingQuestion) current = await refuseUnsentQuestion(projectId, itemId, execution.data.pendingQuestion, 'BOT_STOP_REQUESTED');
    if (current.effects.some((effect) => ['dispatching', 'outcome-unknown', 'prepared'].includes(effect.state)
      && (effect.key !== `${itemId}:cleanup` || effect.kind !== 'worktree.remove'))) throw error('BOT_STOP_HAS_UNSETTLED_EFFECTS');
    if (execution.data.pendingQuestion) await questions.answered({ projectId, itemId });
    if (current.worktree) await cleanup(projectId, project, bot, current);
    return { item: await transition(projectId, itemId, 'stopped') };
  };
  const stopItem = async (projectId, itemId) => {
    await projectFor(projectId);
    const initial = await itemFor(projectId, itemId);
    if (TERMINAL_ITEM_STATES.includes(initial.state)) return { item: initial };
    await saveData(projectId, itemId, { stopRequested: true });
    activeProofs.get(JSON.stringify([projectId, itemId]))?.abort();
    return withSourceControlFileLock(`${store.filePathFor(projectId)}.owner.lock`, async () => {
      const project = await projectFor(projectId);
      const item = await itemFor(projectId, itemId);
      if (TERMINAL_ITEM_STATES.includes(item.state)) return { item };
      const bot = (await config.read(projectId)).definitions.find((entry) => entry.id === item.botId);
      if (!bot) throw error('BOT_DEFINITION_REQUIRED');
      const admission = await requestRevocation(projectId, item, 'stop');
      await needsYou(projectId, itemId, 'BOT_STOP_REQUESTED');
      if (admission?.state === 'merged') {
        return { item: await needsYou(projectId, itemId, 'GitHub merged before revocation was confirmed') };
      }
      if (admission?.state === 'revoking' && !await settleRevocation(projectId, project, bot, item, admission)) return { item: await itemFor(projectId, itemId) };
      return finishStop(projectId, project, bot, await itemFor(projectId, itemId));
    }, { waitMs: 10_000 });
  };
  const onSessionEvent = async ({ sessionId, reason }) => {
    const target = sessionIndex.get(sessionId);
    if (!target) return;
    if (reason === 'idle') return pump(target.projectId);
    const item = await itemFor(target.projectId, target.itemId);
    const stage = item.state === 'investigating' ? 'investigation' : item.state === 'judging' ? 'judge' : 'fixing';
    if (item.sessions[stage] !== sessionId) return;
    return needsYou(target.projectId, target.itemId, reason);
  };

  const recordUsage = async ({ sessionId, total }) => {
    z.number().int().nonnegative().parse(total);
    const target = sessionIndex.get(sessionId);
    if (!target) return;
    const { projectId, itemId } = target;
    const item = await itemFor(projectId, itemId);
    if (TERMINAL_ITEM_STATES.includes(item.state)) return;
    const execution = await journal.read(projectId, itemId);
    const stage = Object.keys(item.sessions).find((key) => item.sessions[key] === sessionId);
    if (!stage) return;
    const runs = Object.entries(execution.data.runs ?? {}).filter(([key]) => key.startsWith(`${stage}:`));
    const latestRun = runs.at(-1);
    const run = latestRun?.[1];
    if (!run) return;
    const day = new Date(now()).toISOString().slice(0, 10);
    const updated = await mutate(projectId, itemId, (current) => {
      const stageTotal = Math.max(current.tokens.byStage[stage], run.tokenBaseline.byStage[stage] + total);
      const delta = stageTotal - current.tokens.byStage[stage];
      return { ...current, tokens: { total: current.tokens.total + delta, byStage: { ...current.tokens.byStage, [stage]: stageTotal }, byDay: { ...current.tokens.byDay, [day]: (current.tokens.byDay[day] ?? 0) + delta } } };
    });
    const bot = (await config.read(projectId)).definitions.find((entry) => entry.id === item.botId);
    if (!bot) return;
    const budget = await checkBudgets(projectId, bot, (await store.read(projectId)).items, updated);
    if (budget) {
      await saveData(projectId, itemId, { interruptedStage: stageInterruptionSchema.parse({ runId: latestRun[0], sessionId }) });
      await needsYou(projectId, itemId, budget);
      await stages.stop({ bot, sessionId, directory: item.worktree });
    }
    return updated.tokens;
  };

  const handleTool = async ({ sessionId, action, input }) => {
    const target = sessionIndex.get(sessionId);
    if (!target) throw error('BOT_SESSION_REQUIRED', 403);
    const { projectId, itemId } = target;
    return withSourceControlFileLock(`${store.filePathFor(projectId)}.owner.lock`, async () => {
    const item = await itemFor(projectId, itemId);
    if (item.sessions.fixing !== sessionId || TERMINAL_ITEM_STATES.includes(item.state)) throw error('BOT_FIXING_SESSION_REQUIRED', 403);
    const project = await projectFor(projectId);
    const bot = (await config.read(projectId)).definitions.find((entry) => entry.id === item.botId);
    if (!bot?.enabled) throw error('BOT_NOT_ENABLED');
    if (action === 'item.report') {
      const report = z.object({ evidence: z.array(evidenceSchema), critical: z.boolean().default(false) }).strict().parse(input);
      const updated = await mutate(projectId, itemId, (current) => ({ ...current, evidence: mergeEvidence(current.evidence, report.evidence) }));
      if (report.critical) {
        await saveData(projectId, itemId, { critical: true });
        await attention.sync({ projectId, item: updated, critical: true });
      }
      return { item: updated };
    }
    if (action === 'item.ask') {
      if (item.state === 'needs-you') throw error('BOT_EFFECT_RESUME_REQUIRED');
      const question = z.object({ operationId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/), question: text, people: z.array(text).default([]), requestedRole: z.string().trim().min(1).max(200).optional() }).strict().parse(input);
      const execution = await journal.read(projectId, itemId);
      if (execution.data.questionAnswer) throw error('BOT_QUESTION_ANSWER_PENDING');
      const eventId = `tool:${question.operationId}`;
      const captured = Object.values(execution.data.questions ?? {}).find((record) => record.input.eventId === eventId);
      const pending = execution.data.questions?.[execution.data.pendingQuestion];
      const request = { project, bot, itemId, eventId, questions: [question.question], people: question.people, resumeState: captured?.input.resumeState ?? pending?.input.resumeState ?? item.state };
      if (question.requestedRole) request.requestedRole = question.requestedRole;
      return questions.ask(request);
    }
    if (!toolOperations.includes(action)) throw error('BOT_ACTION_UNSUPPORTED', 400);
    const request = z.object({ operationId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/), body: text.optional() }).strict().parse(input);
    const key = action === 'pr.open' ? `${itemId}:pr` : `${itemId}:tool:${request.operationId}`;
    const execution = await journal.read(projectId, itemId);
    const previous = execution.operations[key];
    const pendingTool = execution.data.pendingTool ? pendingToolSchema.parse(execution.data.pendingTool) : null;
    const known = previous ? pendingToolSchema.parse({ key, operation: previous.prepared.operation, input: previous.input }) : pendingTool?.key === key ? pendingTool : null;
    if (known && (known.operation !== action || ['pr.comment', 'jira.comment', 'discord.send'].includes(action) && known.input.body !== request.body)) throw error('BOT_EFFECT_INPUT_CHANGED');
    const effect = item.effects.find((entry) => entry.key === key);
    const canSend = !effect || effect.state === 'prepared';
    if (canSend && (pendingTool && pendingTool.key !== key
      || item.effects.some((entry) => entry.key !== key && ['dispatching', 'outcome-unknown'].includes(entry.state)))) throw error('BOT_EFFECT_UNSETTLED');
    if (canSend && (pendingTool || item.state === 'needs-you')) throw error('BOT_EFFECT_RESUME_REQUIRED');
    const admission = await admissionFor(projectId, item);
    if (execution.data.stopRequested || admission?.state === 'revoking') throw error('BOT_ADMISSION_REVOKED');
    if (['git.push', 'pr.open'].includes(action) && admission?.state === 'active') {
      await requestRevocation(projectId, item, 'judge');
      dirty.add(projectId);
      throw error('BOT_ADMISSION_REVOKED');
    }
    try {
      const snapshot = known && action !== 'pr.open' ? null : snapshotSchema.parse(await worktrees.inspect({ project, bot, item }));
      let payload;
      if (known && action !== 'pr.open') payload = known.input;
      else if (action === 'git.push') payload = { directory: item.worktree, branch: item.branch, headSha: snapshot.headSha, baseSha: snapshot.remoteSha ?? snapshot.baseSha, expectedRemoteSha: snapshot.remoteSha, base: snapshot.baseBranch };
      else if (action === 'pr.open') {
        if (!await freshAdmission(projectId, project, bot, item)) throw error('BOT_JUDGMENT_REQUIRED');
        return { item: await publishPullRequest(projectId, project, bot, item, snapshot, true) };
      } else if (action === 'pr.comment') {
        if (!item.pr) throw error('BOT_PULL_REQUEST_REQUIRED');
        payload = { number: item.pr.number, headSha: snapshot.headSha, body: text.parse(request.body) };
      } else if (action === 'jira.transition') {
        const binding = contextSchema.parse(await serviceContext({ project, bot, item, service: 'jira', operation: 'jira.transition' })).jira;
        if (!bot.jira?.doneTransition || !binding?.expectedStatusId || item.state !== 'closing') throw error('BOT_CLOSURE_REQUIRED');
        payload = { transitionId: bot.jira.doneTransition, expectedStatusId: binding.expectedStatusId };
      } else payload = { body: text.parse(request.body) };
      return { receipt: await external(projectId, project, bot, item, key, action, payload, { tool: true }) };
    } catch (failure) {
      await needsYou(projectId, itemId, failure?.code ?? 'BOT_OPERATION_FAILED');
      throw failure;
    }
    }, { waitMs: 10_000 }).finally(async () => { if (dirty.delete(projectId)) await pump(projectId); });
  };

  return {
    admit, pump, runScheduled, detail, saveConfig, answer, resume, stopItem, receiveFeedback, onSessionEvent, handleTool, recordUsage,
    reportAttention: ({ projectId, itemId, reason }) => needsYou(projectId, itemId, text.parse(reason)),
    async getProject(projectId) { await projectFor(projectId); return { config: await config.read(projectId), ...await store.read(projectId), presets: botPresets() }; },
    async getConfig(projectId) { await projectFor(projectId); return { config: await config.read(projectId), presets: botPresets() }; },
    async getItems(projectId) { await projectFor(projectId); return store.read(projectId); },
    async getArchive(projectId, month) { await projectFor(projectId); return { items: await store.readArchive(projectId, month) }; },
    async getPolicy(projectId) { const project = await projectFor(projectId); return readRepositoryPolicy(project.path, (await config.read(projectId)).approvals); },
    async approvePolicy(projectId, { file, fingerprint }) { const project = await projectFor(projectId); await approveRepositoryPolicy({ config, projectId, projectPath: project.path, file, fingerprint }); return { ok: true }; },
    async start() {
      stopped = false;
      releaseEvents ??= events.subscribe((event) => {
        if (event.type === 'bot.wake') void pump(event.projectId).catch((failure) => events.publish({ type: 'bot.runtime.error', projectId: event.projectId, code: failure?.code ?? 'BOT_RECOVERY_FAILED' }));
      });
      const failures = [];
      for (const project of await listProjects()) {
        try {
          await scheduler.sync(project.id, (await config.read(project.id)).definitions.map(botTaskFor));
          await pump(project.id);
        } catch (failure) {
          const entry = { projectId: project.id, code: failure?.code ?? 'BOT_RECOVERY_FAILED' };
          failures.push(entry);
          events.publish({ type: 'bot.runtime.error', ...entry });
        }
      }
      return { failures };
    },
    async stop() {
      stopped = true;
      releaseEvents?.(); releaseEvents = null;
      for (const controller of activeProofs.values()) controller.abort();
      await Promise.all([...pending.values()]);
    },
  };
};
