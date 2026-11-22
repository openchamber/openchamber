import crypto from 'node:crypto';
import { asNonEmptyString, isString } from '../shared/guards.js';
import { createMessageId, escapeAttribute } from '../dispatch-results/runtime.js';
import { WORKFLOW_ANSWER_TOOL } from '../openchamber-control/actions.js';
import { OpenChamberControlError } from '../openchamber-control/error.js';
import { callKey, publishCallName, readAgentOptions, resolveForkSource } from './agent-call.js';
import { WorkflowAgentStopped } from './agent-session.js';
import { hasErrorCode, hasErrorMessage, hasErrorStatus, isAnswerWrapper, isWorkflowText } from './contracts.js';
import { findSchemaContradiction, parseJsonAnswer, validateJsonSchema } from './json-schema.js';
import { createLimiter } from './limiter.js';
import { readWorkflowProcessStart } from './process-owner.js';
import { runWorkflowSandbox } from './sandbox.js';
import { WorkflowScriptError, parseWorkflowScript, plannedPhases } from './script.js';
import { isWorkflowRunId } from './store.js';
import type { WorkflowRun, WorkflowAgent } from './store.js';
import type { WorkflowAgentCall } from './sandbox.js';
import type { AnswerSlot, Ending, Execution, RunInput, WorkflowInput, WorkflowRuntimeOptions, WorkflowSchema, WorkflowScope, WorkflowText } from './contracts.js';
export const MAX_CONCURRENT_AGENTS = 8;
export const MAX_AGENTS_PER_RUN = 200;
const SCHEMA_ATTEMPTS = 3;
const MAX_LOGS = 200;
const MAX_ARGS_LENGTH = 50_000;
const RESULT_CHAR_LIMIT = 50_000;
const PREVIEW_CHAR_LIMIT = 400;
const STORED_PROMPT_LIMIT = 20_000;
const BROADCAST_THROTTLE_MS = 250;
const DELIVERY_ATTEMPTS = 4;
const DELIVERY_BASE_DELAY_MS = 2_000;
const SAVED_DIRECTORY = ['.openchamber', 'workflows'];
const WORKFLOW_RESULT_SOURCE = 'openchamber-workflow';

const truncate = <T extends WorkflowText>(text: T, limit: number) => (text.length > limit ? `${text.slice(0, limit)}…` : text);
const asText = (value: WorkflowAgent['result']) => (isWorkflowText(value) ? value : JSON.stringify(value ?? null, null, 2));

const createRunId = () => `wf_${crypto.randomBytes(12).toString('base64url').replace(/[-_]/g, '').slice(0, 16).padEnd(16, '0')}`;

const schemaInstruction = (schema: WorkflowSchema) => [
  '',
  `Your answer is a JSON value matching the JSON Schema below. Hand it over with the ${WORKFLOW_ANSWER_TOOL} tool: pass the value itself as answer, as a JSON object, not as text${schema.type === 'object' ? '' : ' (this schema is not an object, so pass { "value": <your value> })'}. It checks the value at once and says what to fix; call it again until it is accepted, then end your turn. If you do not have that tool, end your turn with only the JSON value and no text around it.`,
  '```json',
  JSON.stringify(schema, null, 2),
  '```',
].join('\n');

const submittedAnswerCandidates = (raw: WorkflowInput['answer'], schema: WorkflowSchema) => {
  const candidates: unknown[] = [];
  if (schema?.type !== 'object' && isAnswerWrapper(raw) && Object.hasOwn(raw, 'value')) candidates.push(raw.value);
  if (isString(raw)) {
    const parsed = parseJsonAnswer(raw);
    if (parsed) candidates.push(parsed.value);
  }
  candidates.push(raw);
  return candidates;
};

const preview = (value: WorkflowRun['result']): WorkflowRun['result'] => JSON.parse(JSON.stringify(asText(value).slice(0, PREVIEW_CHAR_LIMIT + 1)));

export const lightenWorkflowRun = (run: WorkflowRun): WorkflowRun => ({
  ...run,
  script: '',
  args: undefined,
  agents: run.agents.map((agent) => ({
    ...agent,
    prompt: '',
    schema: undefined,
    result: agent.state === 'completed' ? preview(agent.result) : undefined,
  })),
  logs: run.logs.slice(-20),
  result: run.result === undefined ? undefined : preview(run.result),
});

export const summarizeRun = (run: WorkflowRun) => ({
  id: run.id,
  parentSessionId: run.parentSessionId,
  directory: run.directory,
  name: run.name,
  description: run.description,
  state: run.state,
  attempt: run.attempt,
  createdAt: run.createdAt,
  startedAt: run.startedAt,
  endedAt: run.endedAt,
  currentPhase: run.currentPhase,
  phases: run.phases,
  agents: run.agents.map((agent) => ({
    key: agent.key,
    label: agent.label,
    phase: agent.phase,
    state: agent.state,
    sessionId: agent.sessionId,
    replayed: agent.replayed,
    startedAt: agent.startedAt,
    endedAt: agent.endedAt,
    model: agent.modelUsed ?? agent.model,
    usage: agent.usage,
    error: agent.error,
    preview: agent.state === 'completed' ? truncate(asText(agent.result), PREVIEW_CHAR_LIMIT) : undefined,
  })),
  logs: run.logs.slice(-20),
  error: run.error,
  resultPreview: run.result === undefined ? undefined : truncate(asText(run.result), PREVIEW_CHAR_LIMIT),
});

const reportText = (run: WorkflowRun) => {
  const attributes = `runId="${run.id}" name="${escapeAttribute(run.name)}" state="${run.state}"`;
  const counts = run.agents.reduce<Partial<Record<WorkflowAgent['state'], number>>>((total, agent) => ({ ...total, [agent.state]: (total[agent.state] ?? 0) + 1 }), {});
  const tally = Object.entries(counts).map(([state, count]) => `${count} ${state}`).join(', ') || 'no agents';
  const lines: (string | WorkflowText)[] = [`Agents: ${tally}.`];
  if (run.state === 'completed') {
    const result = asText(run.result);
    lines.push('', result.length > RESULT_CHAR_LIMIT
      ? `${result.slice(0, RESULT_CHAR_LIMIT)}\n\n[Cut at ${RESULT_CHAR_LIMIT} characters; read the rest with workflow.result for ${run.id}.]`
      : result);
  } else if (run.state === 'failed') {
    lines.push('', `The workflow failed: ${run.error ?? 'unknown error'}. Completed agents keep their results; workflow.resume runs the script again and reuses them.`);
  } else if (run.state === 'stopped') {
    lines.push('', `${run.error ?? 'The user stopped the workflow.'} workflow.resume continues it and reuses completed agents.`);
  } else if (run.state === 'declined') {
    lines.push('', 'The user declined to run this workflow. Continue from what they say next.');
  }
  lines.push('', `Each agent's full answer: workflow.result with runId ${run.id} and agent set to its key or session id.`);
  return `<openchamber-workflow ${attributes}>\n${lines.join('\n')}\n</openchamber-workflow>`;
};

const isPidAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return hasErrorCode(error) && error.code === 'EPERM';
  }
};

export const createWorkflowRuntime = ({
  store,
  agentSessions,
  postSynthetic,
  broadcast = () => {},
  isEnabled = async () => true,
  startsWithoutApproval = async (_sessionId: string) => false,
  fsPromises,
  path,
  now = Date.now,
  sleep = (duration) => new Promise((resolve) => setTimeout(resolve, duration)),
  maxConcurrentAgents = MAX_CONCURRENT_AGENTS,
  maxAgentsPerRun = MAX_AGENTS_PER_RUN,
  pid = process.pid,
  isProcessAlive = isPidAlive,
  readProcessStart = readWorkflowProcessStart,
}: WorkflowRuntimeOptions) => {
  const active = new Map<string, Execution>();
  const answerSlots = new Map<string, AnswerSlot>();
  const broadcastTimers = new Map<string, ReturnType<typeof setTimeout>>();

  const announce = (run: WorkflowRun, { immediate = false }: { immediate?: boolean } = {}) => {
    const send = () => {
      broadcastTimers.delete(run.id);
      broadcast({ type: 'openchamber:workflow-run', properties: { run: summarizeRun(run) } });
    };
    if (immediate) {
      clearTimeout(broadcastTimers.get(run.id));
      send();
      return;
    }
    if (broadcastTimers.has(run.id)) return;
    const timer = setTimeout(send, BROADCAST_THROTTLE_MS);
    timer.unref?.();
    broadcastTimers.set(run.id, timer);
  };

  const removedRuns = new Set<string>();

  const persist = async (run: WorkflowRun, options?: { immediate?: boolean }) => {
    if (removedRuns.has(run.id)) return;
    try {
      await store.save(run);
    } catch {
      throw new OpenChamberControlError('Could not save workflow run', 500);
    }
    if (removedRuns.has(run.id)) return;
    announce(run, options);
  };

  const withRollback = async <Run extends WorkflowRun>(run: Run, transition: () => Promise<void>) => {
    const before = { ...run };
    try {
      await transition();
    } catch (error) {
      if (!removedRuns.has(run.id)) {
        for (const key in run) {
          if (Object.hasOwn(run, key) && !Object.hasOwn(before, key)) delete run[key];
        }
        Object.assign(run, before);
        if (await store.get(run.id)) announce(run, { immediate: true });
      }
      throw error;
    }
  };

  const assertEnabled = async () => {
    if (!await isEnabled()) throw new OpenChamberControlError('Workflows are turned off in OpenChamber settings', 403);
  };

  const requireRun = async (runId: WorkflowInput['runId'], parentSessionId?: string | null) => {
    const id = asNonEmptyString(runId);
    if (!id || !isWorkflowRunId(id)) throw new OpenChamberControlError('runId is required: the id workflow.run answered', 400);
    const run = await store.get(id);
    if (!run) throw new OpenChamberControlError(`No workflow run ${id}`, 404);
    if (parentSessionId && run.parentSessionId !== parentSessionId) {
      throw new OpenChamberControlError(`Workflow run ${id} belongs to another session`, 403);
    }
    return run;
  };

  const savedPath = (directory: string, name: string) => path.join(directory, ...SAVED_DIRECTORY, `${name}.js`);

  const readScript = async (input: WorkflowInput, directory?: string | null) => {
    const name = asNonEmptyString(input.name);
    const script = asNonEmptyString(input.script);
    if (script && name) throw new OpenChamberControlError('Provide script or name, not both', 400);
    if (script) return script;
    if (!name) throw new OpenChamberControlError('script is required, or name of a saved workflow', 400);
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) throw new OpenChamberControlError('name is a saved workflow name such as audit-routes', 400);
    if (!directory) throw new OpenChamberControlError('A saved workflow needs the session directory', 400);
    try {
      return await fsPromises.readFile(savedPath(directory, name), 'utf8');
    } catch (error) {
      if (hasErrorCode(error) && error.code === 'ENOENT') throw new OpenChamberControlError(`No saved workflow ${name} in ${path.join(...SAVED_DIRECTORY)}`, 404);
      throw error;
    }
  };

  const parse = (script: string) => {
    try {
      return parseWorkflowScript(script);
    } catch (error) {
      if (error instanceof WorkflowScriptError) throw new OpenChamberControlError(error.message, 400);
      throw error;
    }
  };

  const readArgs = (raw: WorkflowInput['args']): WorkflowRun['args'] => {
    if (raw === undefined) return undefined;
    let value = raw;
    if (isString(raw) && /^\s*[[{]/.test(String(raw))) {
      try {
        value = JSON.parse(String(raw));
      } catch {
        throw new OpenChamberControlError('args must be an object; it arrived as a string that is not JSON', 400);
      }
    }
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new OpenChamberControlError('args must be JSON', 400);
    if (serialized.length > MAX_ARGS_LENGTH) throw new OpenChamberControlError(`args is ${serialized.length} characters as JSON; the limit is ${MAX_ARGS_LENGTH}`, 400);
    return JSON.parse(serialized);
  };

  const uncommittedReports = new WeakSet<NonNullable<WorkflowRun['report']>>();

  const deliverReport = async (run: WorkflowRun) => {
    const report = run.report;
    if (!report || report.delivered || uncommittedReports.has(report)) return;
    const message = {
      id: report.messageId,
      text: reportText(run),
      description: run.name,
      metadata: { source: WORKFLOW_RESULT_SOURCE, runId: run.id, name: run.name, state: run.state },
      delivery: 'steer',
      resume: report.resume,
    };
    for (let attempt = 1; attempt <= DELIVERY_ATTEMPTS; attempt += 1) {
      if (run.report !== report) return;
      try {
        await postSynthetic(run.parentSessionId, message);
      } catch (error) {
        if (!hasErrorStatus(error) || (error.status !== 409 && error.status !== 404)) {
          console.warn(`[workflows] delivering the report of ${run.id} failed:`, (hasErrorMessage(error) ? error.message : undefined) ?? error);
          await sleep(DELIVERY_BASE_DELAY_MS * 2 ** (attempt - 1));
          continue;
        }
      }
      if (run.report !== report || report.delivered) return;
      report.delivered = true;
      await persist(run, { immediate: true }).catch((error) => {
        console.warn(`[workflows] report ${report.messageId} of ${run.id} was delivered but its marker was not saved:`, error.message);
      });
      return;
    }
  };

  const settleRun = async (run: WorkflowRun, state: Ending['state'], { error, result, resume }: Omit<Ending, 'state'>) => {
    run.state = state;
    run.endedAt = now();
    if (error) run.error = error;
    else delete run.error;
    if (result !== undefined) run.result = result;
    const report = { messageId: createMessageId(now()), delivered: false, resume };
    uncommittedReports.add(report);
    run.report = report;
    await persist(run, { immediate: true });
    uncommittedReports.delete(report);
  };

  const log = (run: WorkflowRun, message: string, notify = true) => {
    run.logs.push({ at: now(), message: truncate(message, 2_000) });
    if (run.logs.length > MAX_LOGS) run.logs.splice(0, run.logs.length - MAX_LOGS);
    if (notify) announce(run);
  };

  const runAgent = async (run: WorkflowRun, execution: Execution, { prompt, options: rawOptions, phase }: WorkflowAgentCall): Promise<WorkflowAgent['result']> => {
    const options = readAgentOptions(rawOptions);
    const forkFromSessionId = resolveForkSource(execution.named, options);
    const base = callKey(prompt, forkFromSessionId ? { ...options, forkFromSessionId } : options);
    const occurrence = (execution.occurrences.get(base) ?? 0) + 1;
    execution.occurrences.set(base, occurrence);
    const key = `${base}-${occurrence}`;
    const label = options.label ?? truncate(prompt.replace(/\s+/g, ' ').trim(), 60);

    let replay = execution.completed.get(key);
    if (replay && options.id && replay.sessionId
      && await agentSessions.sessionGone({ directory: run.directory, sessionId: replay.sessionId, signal: execution.controller.signal })
      && !execution.controller.signal.aborted) {
      execution.completed.delete(key);
      replay = undefined;
    }
    if (replay) {
      execution.consumed.add(key);
      run.agents.push({ ...replay, phase: phase ?? replay.phase, replayed: true });
      publishCallName(execution.named, options, replay);
      announce(run);
      return replay.result;
    }

    const contradiction = options.schema ? findSchemaContradiction(options.schema) : null;
    const record: WorkflowAgent = {
      key,
      label,
      phase: phase ?? null,
      prompt: truncate(prompt, STORED_PROMPT_LIMIT),
      agent: options.agent,
      model: options.model,
      schema: options.schema,
      state: 'queued',
    };
    run.agents.push(record);
    if (contradiction) {
      Object.assign(record, { state: 'failed', error: `The schema can never be satisfied: ${contradiction}` });
      announce(run);
      return null;
    }
    announce(run);

    const { signal } = execution.controller;
    let release;
    let counted = false;
    try {
      release = await execution.limiter.acquire(signal);
      const started = run.agentsStarted ?? 0;
      if (started >= maxAgentsPerRun) {
        Object.assign(record, { state: 'failed', endedAt: now(), error: `A run starts at most ${maxAgentsPerRun} agents across its attempts` });
        log(run, `agent() refused: a run starts at most ${maxAgentsPerRun} agents across its attempts. Split the work into several runs.`);
        return null;
      }
      run.agentsStarted = started + 1;
      counted = true;
      if (record.phase) {
        run.currentPhase = record.phase;
        if (!run.phases.includes(record.phase)) run.phases.push(record.phase);
      }
      Object.assign(record, { state: 'running', startedAt: now() });
      await persist(run);
      if (signal.aborted) throw new WorkflowAgentStopped();
      const text = options.schema ? `${prompt}\n${schemaInstruction(options.schema)}` : prompt;
      const slot: AnswerSlot | null = options.schema ? { schema: options.schema, submitted: false, value: undefined } : null;
      const { sessionId, outcome } = await agentSessions.start({
        directory: run.directory,
        parentSessionId: run.parentSessionId,
        forkFromSessionId,
        title: label,
        agent: options.agent,
        model: options.model,
        allowTools: slot ? [WORKFLOW_ANSWER_TOOL] : [],
        text,
        signal,
        onSession: async (id) => {
          record.sessionId = id;
          execution.sessions.add(id);
          await persist(run, { immediate: true });
          if (slot) answerSlots.set(id, slot);
        },
      });
      let current = outcome;
      let value: unknown = current.text;
      for (let attempt = 1; slot; attempt += 1) {
        if (slot.submitted && !signal.aborted) {
          current = { state: 'completed', text: current.text, errorMessage: '' };
          value = slot.value;
          break;
        }
        if (current.state !== 'completed') break;
        const parsed = parseJsonAnswer(current.text);
        const mismatch = parsed ? validateJsonSchema(slot.schema, parsed.value) : 'the answer is not JSON';
        if (parsed && !mismatch) {
          value = parsed.value;
          break;
        }
        if (attempt >= SCHEMA_ATTEMPTS) {
          current = { state: 'error', text: current.text, errorMessage: `The answer did not match the schema after ${SCHEMA_ATTEMPTS} attempts: ${mismatch}` };
          break;
        }
        log(run, `${label}: no answer matching the schema (${mismatch}); asking again, try ${attempt + 1} of ${SCHEMA_ATTEMPTS}`);
        current = await agentSessions.followUp({
          directory: run.directory,
          sessionId,
          text: `No accepted answer yet: ${mismatch}. Hand it over with the ${WORKFLOW_ANSWER_TOOL} tool, or end your turn with only the JSON value.`,
          signal,
        });
      }
      execution.sessions.delete(sessionId);
      if (current.state !== 'completed') {
        Object.assign(record, {
          state: current.state === 'cancelled' ? 'stopped' : 'failed',
          endedAt: now(),
          error: current.errorMessage || (current.state === 'cancelled' ? 'The agent was stopped' : 'The agent failed'),
        });
        if (!signal.aborted) log(run, `${label} ${record.state === 'stopped' ? 'stopped' : 'failed'}: ${record.error}`);
        return null;
      }
      Object.assign(record, { state: 'completed', endedAt: now(), result: value });
      return value;
    } catch (error) {
      const stopped = error instanceof WorkflowAgentStopped || signal.aborted;
      if (counted && !record.sessionId && !stopped) run.agentsStarted = Number(run.agentsStarted) - 1;
      Object.assign(record, {
        state: stopped ? 'stopped' : 'failed',
        endedAt: now(),
        error: stopped ? 'The run was stopped' : (error instanceof Error ? error.message : String(error)),
      });
      if (!stopped) log(run, `${label} failed: ${record.error}`);
      return null;
    } finally {
      release?.();
      if (record.sessionId) {
        execution.sessions.delete(record.sessionId);
        answerSlots.delete(record.sessionId);
        const read = await agentSessions.readUsage({ directory: run.directory, sessionId: record.sessionId }).catch(() => null);
        if (read?.model) record.modelUsed = read.model;
        if (read) record.usage = read.usage;
      }
      await persist(run).catch((error) => {
        console.warn(`[workflows] agent ${record.key} of ${run.id} ended but could not be saved:`, error.message);
      });
      publishCallName(execution.named, options, record);
    }
  };

  const answer = (input: WorkflowInput, { sessionId }: { sessionId: string }) => {
    const slot = answerSlots.get(sessionId);
    if (!slot) {
      throw new OpenChamberControlError(`${WORKFLOW_ANSWER_TOOL} is only for a workflow agent whose prompt asks for a schema answer`, 403);
    }
    if (input.answer === undefined) throw new OpenChamberControlError('answer is required: your answer as a JSON object', 400);
    const candidates = submittedAnswerCandidates(input.answer, slot.schema);
    const value = candidates.find((candidate) => !validateJsonSchema(slot.schema, candidate));
    if (value === undefined) {
      const mismatch = validateJsonSchema(slot.schema, candidates[0]);
      throw new OpenChamberControlError(`The answer does not match the schema: ${mismatch}. Fix it and call ${WORKFLOW_ANSWER_TOOL} again.`, 400);
    }
    Object.assign(slot, { submitted: true, value });
    return { accepted: true, note: 'Accepted as your answer. End your turn now; nothing else you write is read.' };
  };

  const execute = async (run: WorkflowRun, execution: Execution, body: string) => {
    const { completed } = execution;
    let ending: Ending;
    try {
      execution.sandbox = runWorkflowSandbox({
        body,
        args: run.args,
        filename: `${run.name}.workflow.js`,
        onAgent: (call) => {
          const running = runAgent(run, execution, call);
          execution.inflight.add(running);
          const removeInflight = () => execution.inflight.delete(running);
          void running.then(removeInflight, removeInflight);
          return running;
        },
        onPhase: (title) => {
          run.currentPhase = title;
          if (!run.phases.includes(title)) run.phases.push(title);
          announce(run);
        },
        onLog: (message) => log(run, message),
      });
      if (execution.stopReason) execution.sandbox.terminate();
      ending = await execution.sandbox.result.then(
        (result) => ({ state: 'completed', result, resume: true }),
        (error) => (error?.stopped
          ? { state: 'stopped', error: execution.stopReason ?? 'The user stopped the workflow.', resume: false }
          : { state: 'failed', error: error instanceof Error ? error.message : String(error), resume: true }),
      );
    } catch (error) {
      ending = { state: 'failed', error: error instanceof Error ? error.message : String(error), resume: true };
    }

    try {
      execution.controller.abort();
      await Promise.allSettled([...execution.sessions].map((sessionId) => agentSessions.interrupt(run.directory, sessionId)));
      await Promise.allSettled([...execution.inflight]);
      for (const [key, agent] of completed) {
        if (!execution.consumed.has(key)) run.agents.push(agent);
      }
      await settleRun(run, ending.state, ending);
    } catch (error) {
      console.warn(`[workflows] run ${run.id} ended; completion report withheld:`, (hasErrorMessage(error) ? error.message : undefined) ?? error);
      log(run, 'Could not save workflow completion; completion report withheld.');
      announce(run, { immediate: true });
      return;
    } finally {
      active.delete(run.id);
    }
    await deliverReport(run);
  };

  const startInBackground = async (run: WorkflowRun) => {
    const { body } = parse(run.script);
    const completed = new Map(run.agents.filter((agent) => agent.state === 'completed').map((agent) => [agent.key, agent]));
    const execution: Execution = {
      controller: new AbortController(),
      limiter: createLimiter(maxConcurrentAgents),
      sessions: new Set(),
      inflight: new Set(),
      completed,
      consumed: new Set(),
      occurrences: new Map(),
      named: new Map(),
      stopReason: null,
      sandbox: null,
    };
    active.set(run.id, execution);
    try {
      await withRollback(run, async () => {
        Object.assign(run, { state: 'running', attempt: run.attempt + 1, startedAt: now(), agents: [], logs: [...run.logs], currentPhase: null, ownerPid: pid });
        delete run.endedAt;
        delete run.error;
        delete run.result;
        delete run.report;
        delete run.ownerStartedAt;
        log(run, run.attempt === 1
          ? 'Run started'
          : `Attempt ${run.attempt} started; ${completed.size} answers from earlier attempts can be reused`, false);
        const startedAt = await readProcessStart(pid);
        if (startedAt) run.ownerStartedAt = startedAt;
        else console.warn(`[workflows] Cannot read process start time for owner PID ${pid}; run ${run.id} uses PID-only recovery`);
        await persist(run, { immediate: true });
      });
    } catch (error) {
      active.delete(run.id);
      throw error;
    }
    void execute(run, execution, body).catch((error) => {
      console.warn(`[workflows] run ${run.id} ended with an internal error:`, error?.message ?? error);
    });
  };

  const check = async (input: WorkflowInput, { directory }: WorkflowScope = {}) => {
    await assertEnabled();
    const parsed = parse(await readScript(input, directory));
    return {
      name: parsed.meta.name,
      description: parsed.meta.description,
      phases: plannedPhases(parsed),
      limits: { concurrentAgents: maxConcurrentAgents, agentsPerRun: maxAgentsPerRun },
    };
  };

  const propose = async (input: WorkflowInput, { sessionId, directory, scriptDirectory = directory }: WorkflowScope, { approved = false } = {}) => {
    await assertEnabled();
    if (!sessionId) throw new OpenChamberControlError('workflow.run needs the calling session', 400);
    if (!directory) throw new OpenChamberControlError('workflow.run needs the session directory', 400);
    if ([...active.values()].some((execution) => execution.sessions.has(sessionId))) {
      throw new OpenChamberControlError('An agent of a workflow cannot start another workflow; do your piece of the work and answer', 403);
    }
    const script = await readScript(input, scriptDirectory);
    const parsed = parse(script);
    const run: WorkflowRun = {
      version: store.version,
      id: createRunId(),
      parentSessionId: sessionId,
      directory,
      name: parsed.meta.name,
      description: parsed.meta.description,
      phases: plannedPhases(parsed),
      script,
      args: readArgs(input.args),
      state: 'awaiting-approval',
      attempt: 0,
      agentsStarted: 0,
      createdAt: now(),
      currentPhase: null,
      agents: [],
      logs: [],
    };
    if (approved) {
      log(run, 'Started without approval: OpenChamber settings let agents start workflow runs', false);
      await startInBackground(run);
    } else {
      await persist(run, { immediate: true });
    }
    return {
      runId: run.id,
      state: run.state,
      name: run.name,
      phases: run.phases,
      note: approved
        ? 'The run started without waiting for approval: the user allows that in OpenChamber settings. They see it in the chat and can stop it. The report arrives here as a message when the run ends. Do not poll or wait for it: end your turn or carry on with other work.'
        : 'The user sees the plan in the chat and approves or declines it. The report arrives here as a message when the run ends, or a note if they decline. Do not poll or wait for it: end your turn or carry on with other work.',
    };
  };

  const approve = async ({ runId }: RunInput) => {
    await assertEnabled();
    const run = await requireRun(runId);
    if (run.state !== 'awaiting-approval') throw new OpenChamberControlError(`The run is ${run.state}, not waiting for approval`, 409);
    await startInBackground(run);
    return { runId: run.id, state: 'running' };
  };

  const decline = async ({ runId }: RunInput) => {
    const run = await requireRun(runId);
    if (run.state !== 'awaiting-approval') throw new OpenChamberControlError(`The run is ${run.state}, not waiting for approval`, 409);
    await withRollback(run, () => settleRun(run, 'declined', { resume: false }));
    await deliverReport(run);
    return { runId: run.id, state: run.state };
  };

  const stop = async ({ runId }: RunInput, { sessionId }: WorkflowScope = {}) => {
    const run = await requireRun(runId, sessionId);
    const execution = active.get(run.id);
    if (!execution) {
      if (run.state === 'awaiting-approval') return decline({ runId: run.id });
      throw new OpenChamberControlError(`The run is ${run.state}, not running`, 409);
    }
    execution.stopReason ??= sessionId ? 'The agent stopped the workflow.' : 'The user stopped the workflow.';
    execution.sandbox?.terminate();
    return { runId: run.id, state: 'stopping' };
  };

  const resume = async ({ runId }: RunInput, { sessionId }: WorkflowScope = {}) => {
    await assertEnabled();
    const run = await requireRun(runId, sessionId);
    if (active.has(run.id) || run.state === 'running') throw new OpenChamberControlError('The run is already running', 409);
    if (run.state !== 'failed' && run.state !== 'stopped') {
      throw new OpenChamberControlError(`The run is ${run.state}; only a failed or stopped run resumes. Propose a new one with workflow.run`, 409);
    }
    const reused = run.agents.filter((agent) => agent.state === 'completed').length;
    await startInBackground(run);
    return { runId: run.id, state: 'running', reused };
  };

  const status = async ({ runId }: RunInput, { sessionId }: WorkflowScope = {}) => summarizeRun(await requireRun(runId, sessionId));

  const remove = async ({ runId }: RunInput) => {
    const run = await requireRun(runId);
    if (run.state === 'running' || run.state === 'awaiting-approval') {
      throw new OpenChamberControlError('Stop or decline the run before deleting it', 409);
    }
    removedRuns.add(run.id);
    const report = run.report;
    delete run.report;
    try {
      await store.remove(run.id);
    } catch (error) {
      removedRuns.delete(run.id);
      if (report) run.report = report;
      throw error;
    }
    clearTimeout(broadcastTimers.get(run.id));
    broadcastTimers.delete(run.id);
    broadcast({ type: 'openchamber:workflow-run-removed', properties: { runId: run.id, parentSessionId: run.parentSessionId } });
    return { runId: run.id, removed: true };
  };

  const detail = async ({ runId }: RunInput) => {
    const run = await requireRun(runId);
    return { runId: run.id, logs: run.logs, script: run.script, args: run.args, result: run.result };
  };

  const agentDetail = async ({ runId, key }: RunInput & { key: string }) => {
    const run = await requireRun(runId);
    const record = run.agents.find((candidate) => candidate.key === key);
    if (!record) throw new OpenChamberControlError(`No agent ${key} in run ${run.id}`, 404);
    return { key: record.key, prompt: record.prompt, schema: record.schema, result: record.result, error: record.error };
  };

  const result = async ({ runId, agent }: WorkflowInput, { sessionId }: WorkflowScope = {}) => {
    const run = await requireRun(runId, sessionId);
    const wanted = asNonEmptyString(agent);
    if (!wanted) {
      return { runId: run.id, state: run.state, result: run.result, error: run.error };
    }
    const record = run.agents.find((candidate) => candidate.key === wanted || candidate.sessionId === wanted);
    if (!record) throw new OpenChamberControlError(`No agent ${wanted} in run ${run.id}; workflow.status lists their keys and session ids`, 404);
    return {
      runId: run.id,
      agent: { key: record.key, label: record.label, phase: record.phase, state: record.state, sessionId: record.sessionId, prompt: record.prompt, result: record.result, error: record.error },
    };
  };

  const list = async ({ sessionId }: { sessionId: string }) => {
    const runs = await store.list();
    return runs.filter((run) => run.parentSessionId === sessionId).map(summarizeRun);
  };

  const listByDirectory = async ({ directories }: { directories: string[] }) => {
    const wanted = new Set(directories);
    const runs = await store.list();
    return runs.filter((run) => wanted.has(run.directory)).map(summarizeRun);
  };

  const startSaved = async ({ directory, scriptDirectory, sessionId, name, args }: { directory: string; scriptDirectory?: string | undefined; sessionId?: string | null | undefined; name: string; args?: unknown }) => {
    await assertEnabled();
    if (!directory) throw new OpenChamberControlError('directory is required', 400);
    if (!asNonEmptyString(name)) throw new OpenChamberControlError('name is required: a saved workflow', 400);
    const owner = asNonEmptyString(sessionId) ?? await agentSessions.createSession({ directory, title: name });
    const proposed = await propose({ name, args }, { sessionId: owner, directory, scriptDirectory: scriptDirectory ?? directory });
    await approve({ runId: proposed.runId });
    return { runId: proposed.runId, sessionId: owner };
  };

  const save = async (input: WorkflowInput, { directory }: WorkflowScope) => {
    await assertEnabled();
    if (!directory) throw new OpenChamberControlError('workflow.save needs the session directory', 400);
    const script = asNonEmptyString(input.script);
    if (!script) throw new OpenChamberControlError('script is required', 400);
    const parsed = parse(script);
    const target = savedPath(directory, parsed.meta.name);
    const exists = await fsPromises.access(target).then(() => true, () => false);
    if (exists && input.overwrite !== true) {
      throw new OpenChamberControlError(`${path.relative(directory, target)} exists; pass overwrite: true to replace it`, 409);
    }
    await fsPromises.mkdir(path.dirname(target), { recursive: true });
    await fsPromises.writeFile(target, script.endsWith('\n') ? script : `${script}\n`, 'utf8');
    return { name: parsed.meta.name, path: target, run: `workflow.run with name ${parsed.meta.name}` };
  };

  const listSaved = async ({ directory }: WorkflowScope) => {
    if (!directory) return { workflows: [] };
    const folder = path.join(directory, ...SAVED_DIRECTORY);
    const names = await fsPromises.readdir(folder).catch(() => []);
    const workflows: ({ name: string; description: string } | { name: string; error: string })[] = [];
    for (const file of names.filter((name) => name.endsWith('.js')).sort()) {
      const script = await fsPromises.readFile(path.join(folder, file), 'utf8').catch(() => null);
      if (script === null) continue;
      try {
        const { meta } = parseWorkflowScript(script);
        workflows.push({ name: meta.name, description: meta.description });
      } catch (error) {
        workflows.push({ name: file.slice(0, -3), error: error instanceof Error ? error.message : String(error) });
      }
    }
    return { workflows };
  };

  let delivering: Promise<void> | null = null;
  let restored = Promise.resolve();
  const deliverPending = () => {
    delivering ??= restored
      .then(() => store.list())
      .then(async (runs) => {
        for (const run of runs) {
          if (run.report && !run.report.delivered && !active.has(run.id)) await deliverReport(run);
        }
      })
      .catch((error) => console.warn('[workflows] delivering pending reports failed:', error?.message ?? error))
      .finally(() => { delivering = null; });
    return delivering;
  };

  const start = () => {
    restored = (async () => {
      for (const run of await store.list()) {
        if (run.state !== 'running') continue;
        try {
          if (run.ownerPid && run.ownerPid !== pid && isProcessAlive(run.ownerPid)) {
            const startedAt = run.ownerStartedAt ? await readProcessStart(run.ownerPid) : null;
            if (run.ownerStartedAt && !startedAt) {
              console.warn(`[workflows] Cannot verify process start time for owner PID ${run.ownerPid} of run ${run.id}; preserving the live owner's run`);
            }
            if (!run.ownerStartedAt || !startedAt || startedAt === run.ownerStartedAt) {
              console.info(`[workflows] Skipping run ${run.id}: owner PID ${run.ownerPid} is alive${!run.ownerStartedAt || !startedAt ? ' according to a PID-only check' : ' with matching process start time'}`);
              continue;
            }
          }
          for (const agent of run.agents) {
            if (agent.state === 'running' || agent.state === 'queued') Object.assign(agent, { state: 'stopped', error: 'OpenChamber restarted' });
          }
          await settleRun(run, 'stopped', { error: 'OpenChamber restarted while the workflow ran.', resume: false });
        } catch (error) {
          console.warn(`[workflows] could not recover run ${run.id}; completion report withheld:`, (hasErrorMessage(error) ? error.message : undefined) ?? error);
          announce(run, { immediate: true });
        }
      }
    })();
    return restored;
  };

  const shutdown = () => {
    for (const execution of active.values()) {
      execution.stopReason ??= 'OpenChamber shut down while the workflow ran.';
      execution.sandbox?.terminate();
    }
  };

  const executeAction = async (action: string, input: WorkflowInput, { sessionId, directory }: WorkflowScope) => {
    if (!sessionId) throw new OpenChamberControlError('Workflow actions need the calling session', 400);
    const scope = { sessionId, directory };
    switch (action) {
      case 'workflow.check': return check(input, scope);
      case 'workflow.run': return propose(input, scope, { approved: await startsWithoutApproval(sessionId) });
      case 'workflow.status': return status(input, scope);
      case 'workflow.result': return result(input, scope);
      case 'workflow.stop': return stop(input, scope);
      case 'workflow.resume': return resume(input, scope);
      case 'workflow.save': return save(input, scope);
      case 'workflow.answer': return answer(input, scope);
      case 'workflow.list': {
        await assertEnabled();
        return { ...(await listSaved(scope)), runs: (await list(scope)).map(({ id, name, state, createdAt }) => ({ runId: id, name, state, createdAt })) };
      }
      default: throw new OpenChamberControlError(`Unsupported workflow action: ${action}`, 400);
    }
  };

  return { executeAction, approve, decline, stop, resume, remove, list, listByDirectory, listSaved, startSaved, detail, agentDetail, start, deliverPending, shutdown };
};
