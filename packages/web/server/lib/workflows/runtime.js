import crypto from 'node:crypto';

import { asNonEmptyString, isPlainObject, isString } from '../shared/guards.js';
import { createMessageId, escapeAttribute } from '../dispatch-results/runtime.js';
import { WORKFLOW_ANSWER_TOOL } from '../openchamber-control/actions.js';
import { OpenChamberControlError } from '../openchamber-control/error.js';
import { WorkflowAgentStopped } from './agent-session.js';
import { findSchemaContradiction, parseJsonAnswer, validateJsonSchema } from './json-schema.js';
import { runWorkflowSandbox } from './sandbox.js';
import { WorkflowScriptError, parseWorkflowScript, plannedPhases } from './script.js';
import { isWorkflowRunId } from './store.js';

// How many agents of one run work at once, and how many one run may start in
// all. A script with a loop must not be able to spend a subscription in a
// minute; a run that needs more is split into several.
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

const truncate = (text, limit) => (text.length > limit ? `${text.slice(0, limit)}…` : text);
const asText = (value) => (isString(value) ? value : JSON.stringify(value ?? null, null, 2));

const callKey = (prompt, options) => crypto.createHash('sha256').update(JSON.stringify([prompt, options])).digest('hex').slice(0, 24);

const createRunId = () => `wf_${crypto.randomBytes(12).toString('base64url').replace(/[-_]/g, '').slice(0, 16).padEnd(16, '0')}`;

/** A small counting semaphore; waiters give up when the run stops. */
const createLimiter = (limit) => {
  let active = 0;
  const queue = [];
  const release = () => {
    active -= 1;
    const next = queue.shift();
    if (next) next();
  };
  const acquire = (signal) => new Promise((resolve, reject) => {
    const grant = () => {
      signal.removeEventListener('abort', cancel);
      active += 1;
      resolve(release);
    };
    const cancel = () => {
      const index = queue.indexOf(grant);
      if (index !== -1) queue.splice(index, 1);
      reject(new WorkflowAgentStopped());
    };
    if (signal.aborted) return cancel();
    if (active < limit) return grant();
    queue.push(grant);
    signal.addEventListener('abort', cancel, { once: true });
  });
  return { acquire };
};

const readAgentOptions = (raw) => {
  const source = isPlainObject(raw) ? raw : {};
  const label = asNonEmptyString(source.label);
  const agent = asNonEmptyString(source.agent);
  const model = asNonEmptyString(source.model);
  // Only the options given: the replay key hashes this object.
  const options = {};
  if (label) options.label = label.trim().slice(0, 120);
  if (agent) options.agent = agent.trim();
  if (model) options.model = model.trim();
  if (isPlainObject(source.schema)) options.schema = source.schema;
  return options;
};

const schemaInstruction = (schema) => [
  '',
  `Your answer is a JSON value matching the JSON Schema below. Hand it over with the ${WORKFLOW_ANSWER_TOOL} tool: pass the value itself as answer, as a JSON object, not as text${schema.type === 'object' ? '' : ' (this schema is not an object, so pass { "value": <your value> })'}. It checks the value at once and says what to fix; call it again until it is accepted, then end your turn. If you do not have that tool, end your turn with only the JSON value and no text around it.`,
  '```json',
  JSON.stringify(schema, null, 2),
  '```',
].join('\n');

/**
 * What the answer tool received, as the values to check, best first: the
 * value an object-only tool input wraps as { value } for a schema that is not
 * an object, then JSON text parsed (a model that sent text anyway), then the
 * input as it came, so "42" still answers a schema that wants a string.
 */
const submittedAnswerCandidates = (raw, schema) => {
  const candidates = [];
  if (schema?.type !== 'object' && isPlainObject(raw) && Object.hasOwn(raw, 'value')) candidates.push(raw.value);
  if (isString(raw)) {
    const parsed = parseJsonAnswer(raw);
    if (parsed) candidates.push(parsed.value);
  }
  candidates.push(raw);
  return candidates;
};

/**
 * What the UI and the status action show of a run: everything but the script
 * and the full results. It always travels as JSON, which leaves out the fields
 * a run or an agent does not have yet.
 */
const summarizeRun = (run) => ({
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

const reportText = (run) => {
  const attributes = `runId="${run.id}" name="${escapeAttribute(run.name)}" state="${run.state}"`;
  const counts = run.agents.reduce((total, agent) => ({ ...total, [agent.state]: (total[agent.state] ?? 0) + 1 }), {});
  const tally = Object.entries(counts).map(([state, count]) => `${count} ${state}`).join(', ') || 'no agents';
  const lines = [`Agents: ${tally}.`];
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

/**
 * Workflow runs: scripts an agent writes that fan work out to many agents,
 * run here in OpenChamber's server so the agent that asked stays free. The
 * user approves each run's plan before it starts; when it ends the report is
 * delivered into the asking session like a dispatched session's result.
 */
export const createWorkflowRuntime = ({
  store,
  agentSessions,
  postSynthetic,
  broadcast = () => {},
  isEnabled = async () => true,
  fsPromises,
  path,
  now = Date.now,
  sleep = (duration) => new Promise((resolve) => setTimeout(resolve, duration)),
  maxConcurrentAgents = MAX_CONCURRENT_AGENTS,
  maxAgentsPerRun = MAX_AGENTS_PER_RUN,
}) => {
  // Run id -> { controller, terminate, sessions: Set<sessionId> } while it runs.
  const active = new Map();
  // Agent session id -> { schema, submitted, value } for an agent asked for a
  // schema answer, from its session's creation until its call settles.
  const answerSlots = new Map();
  const broadcastTimers = new Map();

  const announce = (run, { immediate = false } = {}) => {
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

  // Runs the user deleted. A report delivery or an agent still settling holds
  // the run object, and its next save must not bring the file back.
  const removedRuns = new Set();

  const persist = async (run, options) => {
    if (removedRuns.has(run.id)) return;
    announce(run, options);
    await store.save(run);
  };

  const assertEnabled = async () => {
    if (!await isEnabled()) throw new OpenChamberControlError('Workflows are turned off in OpenChamber settings', 403);
  };

  const requireRun = async (runId, parentSessionId) => {
    const id = asNonEmptyString(runId);
    if (!id || !isWorkflowRunId(id)) throw new OpenChamberControlError('runId is required: the id workflow.run answered', 400);
    const run = await store.get(id);
    if (!run) throw new OpenChamberControlError(`No workflow run ${id}`, 404);
    if (parentSessionId && run.parentSessionId !== parentSessionId) {
      throw new OpenChamberControlError(`Workflow run ${id} belongs to another session`, 403);
    }
    return run;
  };

  const savedPath = (directory, name) => path.join(directory, ...SAVED_DIRECTORY, `${name}.js`);

  const readScript = async (input, directory) => {
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
      if (error?.code === 'ENOENT') throw new OpenChamberControlError(`No saved workflow ${name} in ${path.join(...SAVED_DIRECTORY)}`, 404);
      throw error;
    }
  };

  const parse = (script) => {
    try {
      return parseWorkflowScript(script);
    } catch (error) {
      if (error instanceof WorkflowScriptError) throw new OpenChamberControlError(error.message, 400);
      throw error;
    }
  };

  const readArgs = (raw) => {
    if (raw === undefined) return undefined;
    // The plugin forwards raw JSON, and an object can arrive stringified.
    let value = raw;
    if (isString(raw) && /^\s*[[{]/.test(raw)) {
      try {
        value = JSON.parse(raw);
      } catch {
        throw new OpenChamberControlError('args must be an object; it arrived as a string that is not JSON', 400);
      }
    }
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new OpenChamberControlError('args must be JSON', 400);
    if (serialized.length > MAX_ARGS_LENGTH) throw new OpenChamberControlError(`args is ${serialized.length} characters as JSON; the limit is ${MAX_ARGS_LENGTH}`, 400);
    return JSON.parse(serialized);
  };

  // --- report ----------------------------------------------------------------

  /**
   * Sends the run's report. A report a resume replaced (or one already sent)
   * is left alone, so a retry never sends a stale report or marks a new one.
   */
  const deliverReport = async (run) => {
    const report = run.report;
    if (!report || report.delivered) return;
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
        // 409: this id was admitted before; 404: the session is gone.
        if (error?.status !== 409 && error?.status !== 404) {
          console.warn(`[workflows] delivering the report of ${run.id} failed:`, error?.message ?? error);
          await sleep(DELIVERY_BASE_DELAY_MS * 2 ** (attempt - 1));
          continue;
        }
      }
      if (run.report !== report) return;
      report.delivered = true;
      await persist(run, { immediate: true });
      return;
    }
  };

  /** Records how the run ended, with its report still to be sent. */
  const settleRun = async (run, state, { error, result, resume }) => {
    run.state = state;
    run.endedAt = now();
    if (error) run.error = error;
    else delete run.error;
    if (result !== undefined) run.result = result;
    run.report = { messageId: createMessageId(now()), delivered: false, resume };
    await persist(run, { immediate: true });
  };

  // --- running ---------------------------------------------------------------

  const log = (run, message) => {
    run.logs.push({ at: now(), message: truncate(message, 2_000) });
    if (run.logs.length > MAX_LOGS) run.logs.splice(0, run.logs.length - MAX_LOGS);
    announce(run);
  };

  /** One agent() call: replayed from the last attempt when it asked the same, else run. */
  const runAgent = async (run, execution, { prompt, options: rawOptions, phase }) => {
    const options = readAgentOptions(rawOptions);
    const base = callKey(prompt, options);
    const occurrence = (execution.occurrences.get(base) ?? 0) + 1;
    execution.occurrences.set(base, occurrence);
    const key = `${base}-${occurrence}`;
    const label = options.label ?? truncate(prompt.replace(/\s+/g, ' ').trim(), 60);

    const replay = execution.completed.get(key);
    if (replay) {
      execution.consumed.add(key);
      run.agents.push({ ...replay, phase: phase ?? replay.phase, replayed: true });
      announce(run);
      return replay.result;
    }

    const contradiction = options.schema ? findSchemaContradiction(options.schema) : null;
    const record = {
      key,
      label,
      phase: phase ?? null,
      prompt: truncate(prompt, STORED_PROMPT_LIMIT),
      // Saved as JSON, which leaves out the options not given.
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
    try {
      release = await execution.limiter.acquire(signal);
      // Counted when an agent starts, across attempts: a call still queued
      // when the run stopped spent nothing, and resuming does not reset it.
      const started = run.agentsStarted ?? 0;
      if (started >= maxAgentsPerRun) {
        Object.assign(record, { state: 'failed', endedAt: now(), error: `A run starts at most ${maxAgentsPerRun} agents across its attempts` });
        log(run, `agent() refused: a run starts at most ${maxAgentsPerRun} agents across its attempts. Split the work into several runs.`);
        return null;
      }
      run.agentsStarted = started + 1;
      // An agent filed under a phase moves the run there, so a pipeline that
      // names phases per agent shows where it is like one that calls phase().
      if (record.phase) {
        run.currentPhase = record.phase;
        if (!run.phases.includes(record.phase)) run.phases.push(record.phase);
      }
      Object.assign(record, { state: 'running', startedAt: now() });
      // Saved before the session exists: a restart while it works must still
      // count it against the limit and show it as stopped, not forget it.
      await persist(run);
      // A stop that came during the save: no session is made after it.
      if (signal.aborted) throw new WorkflowAgentStopped();
      const text = options.schema ? `${prompt}\n${schemaInstruction(options.schema)}` : prompt;
      const slot = options.schema ? { schema: options.schema, submitted: false, value: undefined } : null;
      const { sessionId, outcome } = await agentSessions.start({
        directory: run.directory,
        parentSessionId: run.parentSessionId,
        title: label,
        agent: options.agent,
        model: options.model,
        allowTools: slot ? [WORKFLOW_ANSWER_TOOL] : [],
        text,
        signal,
        onSession: (id) => {
          record.sessionId = id;
          execution.sessions.add(id);
          if (slot) answerSlots.set(id, slot);
          // At once, not throttled: the chat leaves workflow agents out of its
          // subagent rows by this id, and it must know before the agent works.
          // Saved too, so a restart knows which session to report as stopped.
          void persist(run, { immediate: true });
        },
      });
      let current = outcome;
      let value = current.text;
      // An answer the tool accepted is the answer, after the first turn or a
      // correction, even when that turn then ended in an error; only a stop of
      // the run discards it. The final text is the fallback for an agent that
      // did not have or use the tool.
      for (let attempt = 1; slot; attempt += 1) {
        if (slot.submitted && !signal.aborted) {
          current = { state: 'completed', text: current.text, errorMessage: '' };
          value = slot.value;
          break;
        }
        if (current.state !== 'completed') break;
        const parsed = parseJsonAnswer(current.text);
        const mismatch = parsed ? validateJsonSchema(slot.schema, parsed.value) : 'the answer is not JSON';
        if (!mismatch) {
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
        // A stop of the run ends every agent at once; only an agent's own end is worth a line.
        if (!signal.aborted) log(run, `${label} ${record.state === 'stopped' ? 'stopped' : 'failed'}: ${record.error}`);
        return null;
      }
      Object.assign(record, { state: 'completed', endedAt: now(), result: value });
      return value;
    } catch (error) {
      const stopped = error instanceof WorkflowAgentStopped || signal.aborted;
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
        answerSlots.delete(record.sessionId);
        // What the agent ran on and spent; the session keeps it, so a failed
        // read only leaves the panel without the numbers.
        const read = await agentSessions.readUsage({ directory: run.directory, sessionId: record.sessionId }).catch(() => null);
        if (read?.model) record.modelUsed = read.model;
        if (read) record.usage = read.usage;
      }
      await persist(run);
    }
  };

  /**
   * The answer tool: checks a workflow agent's answer against the schema its
   * call asked for and keeps the last accepted one. A mismatch is an error the
   * agent reads and fixes in the same turn.
   */
  const answer = (input, { sessionId }) => {
    const slot = answerSlots.get(sessionId);
    if (!slot) {
      throw new OpenChamberControlError(`${WORKFLOW_ANSWER_TOOL} is only for a workflow agent whose prompt asks for a schema answer`, 403);
    }
    if (input.answer === undefined) throw new OpenChamberControlError('answer is required: your answer as a JSON object', 400);
    // JSON text parsed first; a schema that wants a string still takes "42" as the string it is.
    const candidates = submittedAnswerCandidates(input.answer, slot.schema);
    const value = candidates.find((candidate) => !validateJsonSchema(slot.schema, candidate));
    if (value === undefined) {
      const mismatch = validateJsonSchema(slot.schema, candidates[0]);
      throw new OpenChamberControlError(`The answer does not match the schema: ${mismatch}. Fix it and call ${WORKFLOW_ANSWER_TOOL} again.`, 400);
    }
    Object.assign(slot, { submitted: true, value });
    return { accepted: true, note: 'Accepted as your answer. End your turn now; nothing else you write is read.' };
  };

  /**
   * Runs the script for `run`, reusing the agents of earlier attempts that
   * completed. Resolves when the run has ended and its report is on its way.
   *
   * The run is in `active` from the first moment it is `running`, so a stop
   * that arrives before the sandbox exists is recorded and honoured as soon as
   * it does. It leaves `active` once its end is saved, before the report goes
   * out, so a slow delivery does not hold a finished run as running.
   */
  const execute = async (run) => {
    const { body } = parse(run.script);
    const completed = new Map(run.agents.filter((agent) => agent.state === 'completed').map((agent) => [agent.key, agent]));
    const execution = {
      controller: new AbortController(),
      limiter: createLimiter(maxConcurrentAgents),
      sessions: new Set(),
      inflight: new Set(),
      completed,
      consumed: new Set(),
      occurrences: new Map(),
      stopReason: null,
      sandbox: null,
    };
    active.set(run.id, execution);
    Object.assign(run, { state: 'running', attempt: run.attempt + 1, startedAt: now(), agents: [], currentPhase: null });
    delete run.endedAt;
    delete run.error;
    delete run.result;
    delete run.report;
    log(run, run.attempt === 1
      ? 'Run started'
      : `Attempt ${run.attempt} started; ${completed.size} answers from earlier attempts can be reused`);

    let ending;
    try {
      await persist(run, { immediate: true });
      execution.sandbox = runWorkflowSandbox({
        body,
        args: run.args,
        filename: `${run.name}.workflow.js`,
        onAgent: (call) => {
          const running = runAgent(run, execution, call);
          execution.inflight.add(running);
          void running.finally(() => execution.inflight.delete(running));
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
      // The worker could not start: the run fails instead of staying running.
      ending = { state: 'failed', error: error instanceof Error ? error.message : String(error), resume: true };
    }

    try {
      // Agents the script did not wait for, or that were running when it was
      // stopped, end with the run; the report counts them as stopped.
      execution.controller.abort();
      await Promise.all([...execution.sessions].map((sessionId) => agentSessions.interrupt(run.directory, sessionId)));
      await Promise.allSettled([...execution.inflight]);
      // Answers this attempt did not get to stay for the next one.
      for (const [key, agent] of completed) {
        if (!execution.consumed.has(key)) run.agents.push(agent);
      }
      await settleRun(run, ending.state, ending);
    } finally {
      active.delete(run.id);
    }
    await deliverReport(run);
  };

  const startInBackground = (run) => {
    void execute(run).catch((error) => {
      console.warn(`[workflows] run ${run.id} ended with an internal error:`, error?.message ?? error);
    });
  };

  // --- actions ---------------------------------------------------------------

  /** Checks a script without running it: what the user would approve. */
  const check = async (input, { directory } = {}) => {
    await assertEnabled();
    const parsed = parse(await readScript(input, directory));
    return {
      name: parsed.meta.name,
      description: parsed.meta.description,
      phases: plannedPhases(parsed),
      limits: { concurrentAgents: maxConcurrentAgents, agentsPerRun: maxAgentsPerRun },
    };
  };

  /** Proposes a run; it starts when the user approves it in the chat. */
  // `scriptDirectory`: where a saved workflow named in `input` is read, when the
  // user runs one of the project's from a worktree session (default: `directory`).
  const propose = async (input, { sessionId, directory, scriptDirectory = directory }) => {
    await assertEnabled();
    if (!sessionId) throw new OpenChamberControlError('workflow.run needs the calling session', 400);
    if (!directory) throw new OpenChamberControlError('workflow.run needs the session directory', 400);
    // One level only: an agent of a run doing its piece does not fan out again.
    if ([...active.values()].some((execution) => execution.sessions.has(sessionId))) {
      throw new OpenChamberControlError('An agent of a workflow cannot start another workflow; do your piece of the work and answer', 403);
    }
    const script = await readScript(input, scriptDirectory);
    const parsed = parse(script);
    const run = {
      version: store.version,
      id: createRunId(),
      parentSessionId: sessionId,
      directory,
      name: parsed.meta.name,
      description: parsed.meta.description,
      phases: plannedPhases(parsed),
      script,
      // Saved as JSON, which leaves args out when none were given.
      args: readArgs(input.args),
      state: 'awaiting-approval',
      attempt: 0,
      agentsStarted: 0,
      createdAt: now(),
      currentPhase: null,
      agents: [],
      logs: [],
    };
    await persist(run, { immediate: true });
    return {
      runId: run.id,
      state: run.state,
      name: run.name,
      phases: run.phases,
      note: 'The user sees the plan in the chat and approves or declines it. The report arrives here as a message when the run ends, or a note if they decline. Do not poll or wait for it: end your turn or carry on with other work.',
    };
  };

  const approve = async ({ runId }) => {
    await assertEnabled();
    const run = await requireRun(runId);
    if (run.state !== 'awaiting-approval') throw new OpenChamberControlError(`The run is ${run.state}, not waiting for approval`, 409);
    startInBackground(run);
    return { runId: run.id, state: 'running' };
  };

  const decline = async ({ runId }) => {
    const run = await requireRun(runId);
    if (run.state !== 'awaiting-approval') throw new OpenChamberControlError(`The run is ${run.state}, not waiting for approval`, 409);
    await settleRun(run, 'declined', { resume: false });
    await deliverReport(run);
    return { runId: run.id, state: run.state };
  };

  const stop = async ({ runId }, { sessionId } = {}) => {
    const run = await requireRun(runId, sessionId);
    const execution = active.get(run.id);
    if (!execution) {
      if (run.state === 'awaiting-approval') return decline({ runId: run.id });
      throw new OpenChamberControlError(`The run is ${run.state}, not running`, 409);
    }
    execution.stopReason ??= sessionId ? 'The agent stopped the workflow.' : 'The user stopped the workflow.';
    // Before the sandbox exists, execute() honours the reason once it does.
    execution.sandbox?.terminate();
    return { runId: run.id, state: 'stopping' };
  };

  const resume = async ({ runId }, { sessionId } = {}) => {
    await assertEnabled();
    const run = await requireRun(runId, sessionId);
    if (active.has(run.id) || run.state === 'running') throw new OpenChamberControlError('The run is already running', 409);
    if (run.state !== 'failed' && run.state !== 'stopped') {
      throw new OpenChamberControlError(`The run is ${run.state}; only a failed or stopped run resumes. Propose a new one with workflow.run`, 409);
    }
    startInBackground(run);
    return { runId: run.id, state: 'running', reused: run.agents.filter((agent) => agent.state === 'completed').length };
  };

  const status = async ({ runId }, { sessionId } = {}) => summarizeRun(await requireRun(runId, sessionId));

  /**
   * The user's delete: a finished run leaves the server, its report included
   * if it never went out. A run that is running or waiting is stopped or
   * declined first. The agents' sessions stay, as any subagent's would.
   */
  const remove = async ({ runId }) => {
    const run = await requireRun(runId);
    // The run's state is the rule ("stop or decline first"), not the active
    // set: an execution leaves `active` only once its end save resolves
    // (execute's finally), so for a moment after the end is saved the run is
    // finished yet still listed there. Deleting in that overlap is safe — the
    // deletion drops an undelivered report and the `removedRuns` guards keep
    // the run from coming back.
    if (run.state === 'running' || run.state === 'awaiting-approval') {
      throw new OpenChamberControlError('Stop or decline the run before deleting it', 409);
    }
    removedRuns.add(run.id);
    delete run.report;
    try {
      await store.remove(run.id);
    } catch (error) {
      removedRuns.delete(run.id);
      throw error;
    }
    // A throttled update still on its way would bring the run back on screen.
    clearTimeout(broadcastTimers.get(run.id));
    broadcastTimers.delete(run.id);
    broadcast({ type: 'openchamber:workflow-run-removed', properties: { runId: run.id, parentSessionId: run.parentSessionId } });
    return { runId: run.id, removed: true };
  };

  /** What the panel shows of one run beyond its summary: every log line, the script and the result. */
  const detail = async ({ runId }) => {
    const run = await requireRun(runId);
    return { runId: run.id, logs: run.logs, script: run.script, args: run.args, result: run.result };
  };

  /** One agent's prompt and full answer, for the panel's agent row. */
  const agentDetail = async ({ runId, key }) => {
    const run = await requireRun(runId);
    const record = run.agents.find((candidate) => candidate.key === key);
    if (!record) throw new OpenChamberControlError(`No agent ${key} in run ${run.id}`, 404);
    return { key: record.key, prompt: record.prompt, schema: record.schema, result: record.result, error: record.error };
  };

  /** The whole result, or one agent's full answer by its key or session id. */
  const result = async ({ runId, agent }, { sessionId } = {}) => {
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

  const list = async ({ sessionId }) => {
    const runs = await store.list();
    return runs.filter((run) => run.parentSessionId === sessionId).map(summarizeRun);
  };

  /**
   * The runs of every session in some directories, for the Workflows panel's
   * project view: a project's own folder and its worktrees.
   */
  const listByDirectory = async ({ directories }) => {
    const wanted = new Set(directories);
    const runs = await store.list();
    return runs.filter((run) => wanted.has(run.directory)).map(summarizeRun);
  };

  /**
   * The user's Run on a saved workflow: the run belongs to `sessionId`, or to
   * a new session made for it when none is open (a draft), and starts at once,
   * since the click is the approval. Like a run its agent proposed, its report
   * comes back into that session and wakes it.
   */
  const startSaved = async ({ directory, scriptDirectory, sessionId, name, args }) => {
    await assertEnabled();
    if (!directory) throw new OpenChamberControlError('directory is required', 400);
    if (!asNonEmptyString(name)) throw new OpenChamberControlError('name is required: a saved workflow', 400);
    const owner = asNonEmptyString(sessionId) ?? await agentSessions.createSession({ directory, title: name });
    const proposed = await propose({ name, args }, { sessionId: owner, directory, scriptDirectory: scriptDirectory ?? directory });
    await approve({ runId: proposed.runId });
    return { runId: proposed.runId, sessionId: owner };
  };

  /** Saves a script as a command-like workflow of the project, under .openchamber/workflows/. */
  const save = async (input, { directory }) => {
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

  const listSaved = async ({ directory }) => {
    if (!directory) return { workflows: [] };
    const folder = path.join(directory, ...SAVED_DIRECTORY);
    const names = await fsPromises.readdir(folder).catch(() => []);
    const workflows = [];
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

  let delivering = null;
  let restored = Promise.resolve();
  /**
   * Sends every report that has not gone out; safe to call again while it
   * runs. Waits for start(), so the reports of runs it just marked go too.
   */
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

  /**
   * After a restart the scripts that were running are gone: each such run is
   * marked stopped and says so. Reports go out with deliverPending once
   * OpenCode answers.
   */
  const start = () => {
    restored = (async () => {
      for (const run of await store.list()) {
        if (run.state !== 'running') continue;
        for (const agent of run.agents) {
          if (agent.state === 'running' || agent.state === 'queued') Object.assign(agent, { state: 'stopped', error: 'OpenChamber restarted' });
        }
        Object.assign(run, { state: 'stopped', endedAt: now(), error: 'OpenChamber restarted while the workflow ran.' });
        run.report = { messageId: createMessageId(now()), delivered: false, resume: false };
        await persist(run, { immediate: true });
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

  /**
   * The agent tool's workflow.* actions. The calling session scopes every run
   * action: an agent reads and stops only the runs it proposed.
   */
  const executeAction = async (action, input, { sessionId, directory }) => {
    if (!sessionId) throw new OpenChamberControlError('Workflow actions need the calling session', 400);
    const scope = { sessionId, directory };
    switch (action) {
      case 'workflow.check': return check(input, scope);
      case 'workflow.run': return propose(input, scope);
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
