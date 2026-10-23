// Suggested tasks: scans that read a project and propose work, and the inbox
// where the user approves, dismisses or snoozes what they propose.
//
// A scan is one scheduled task of the project (`suggestedScan`), so the
// scheduler times it, claims each occurrence across server processes and
// limits concurrency. When it fires, `runScan` starts one OpenCode session per
// lens, each with filesystem reads and explicitly selected MCP tools, and
// returns. The sessions run on their own; this runtime watches them on the
// shared event hub, reads each final answer when its turn ends, and turns it
// into suggestions. A lens that fails or is stopped never touches what the
// other lenses of the run added.

import { OpenCode } from '@opencode/client';
import { CronExpressionParser } from 'cron-parser';
import { DateTime } from 'luxon';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { z } from 'zod';
import { readDispatchOutcome } from '../dispatch-results/runtime.js';
import { assertOpenCodeApiResponse } from '../opencode/prompt-response.js';
import { unwrapOpenCodeResponse } from '../opencode/response-envelope.js';
import { createSessionActivityProbe } from '../opencode/session-activity.js';
import { withSourceControlFileLock } from '../source-control/file-lock.js';
import { mcpToolAliasName } from '../agent-tool/mcp-alias.js';
import { parseConfigEdit, readSuggestedTasksConfig } from './config.js';
import { buildIssueUrl, resolveIssueTargets } from './issue-links.js';
import { LENS_PRESETS } from './presets.js';
import { listRepositoryLenses } from './repo-lenses.js';
import { ScanOutputError, buildScanPrompt, isInScope, parseScanOutput, selectSuggestions } from './scan-prompt.js';

export const SCAN_TASK_ID = 'suggested-tasks-scan';
const SCAN_TASK_NAME = 'Suggested tasks scan';
// What an older OpenChamber sharing this config runs when it fires the task:
// it does not know `suggestedScan` and would send this as a prompt.
const SCAN_TASK_FALLBACK_PROMPT = 'This scheduled run belongs to Suggested tasks and needs a newer OpenChamber. Reply "skipped" and stop.';

const LENS_TIMEOUT_MS = 45 * 60_000;
const SWEEP_INTERVAL_MS = 60_000;
const QUIET_MS = 500;
const SETTLE_RECHECK_MS = 2_000;
const SETTLE_RECHECKS = 3;
const RETRY_BASE_DELAY_MS = 2_000;
const RETRY_MAX_DELAY_MS = 60_000;
const FETCH_TIMEOUT_MS = 15_000;
const MESSAGE_PAGE_LIMIT = 50;
const MAX_DISMISS_REASON_LENGTH = 500;
const MAX_SNOOZE_MS = 365 * 24 * 60 * 60_000;
const MAX_TODO_LENGTH = 1_000;
const MAX_FEEDBACK_ITEMS = 50;

const httpError = (message, statusCode) => Object.assign(new Error(message), { statusCode });

/**
 * The session rules of a lens session. OpenCode applies the last rule that
 * matches and puts a session's rules after the agent's, so these decide:
 * reading and searching are allowed, everything else (edits, shell, unlisted MCP
 * tools, subagents, questions, paths outside the checkout) is denied. `.env`
 * files stay unreadable, as in OpenCode's own default policy.
 */
export const scanPermissions = (web, mcp = []) => {
  const rules = [
    { action: '*', resource: '*', effect: 'deny' },
    { action: 'read', resource: '*', effect: 'allow' },
    { action: 'glob', resource: '*', effect: 'allow' },
    { action: 'grep', resource: '*', effect: 'allow' },
    { action: 'skill', resource: '*', effect: 'allow' },
    { action: 'read', resource: '*.env', effect: 'deny' },
    { action: 'read', resource: '*.env.*', effect: 'deny' },
    { action: 'read', resource: '*.env.example', effect: 'allow' },
  ];
  if (web) {
    rules.push({ action: 'webfetch', resource: '*', effect: 'allow' }, { action: 'websearch', resource: '*', effect: 'allow' });
  }
  const sanitize = (name) => name.replace(/[^A-Za-z0-9_-]/g, '_');
  for (const { server, tools } of mcp) {
    for (const [tool, effect] of Object.entries(tools)) {
      const action = `${sanitize(server)}_${sanitize(tool)}`;
      // MCP names must not reopen filesystem writes or managed memory.
      if (action === 'apply_patch' || action === 'external_directory' || action.startsWith('openchamber_')) continue;
      rules.push({ action, resource: '*', effect });
      // Managed OpenCode exposes a direct alias while the original executor
      // still enforces the MCP rule. External direct MCPs use the rule above.
      rules.push({ action: mcpToolAliasName(action), resource: '*', effect });
    }
  }
  return rules;
};

const minutesOf = (time) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

/** Whether `nowMs` falls in the quiet hours, read in the schedule's time zone. A window may span midnight. */
export const isInQuietHours = (quietHours, timezone, nowMs) => {
  if (!quietHours.enabled) return false;
  const start = minutesOf(quietHours.start);
  const end = minutesOf(quietHours.end);
  if (start === end) return false;
  const local = DateTime.fromMillis(nowMs, { zone: timezone || DateTime.local().zoneName });
  const minute = local.hour * 60 + local.minute;
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
};

/** The scheduled task that times a project's scans, from its config. */
export const scanTaskFor = (config) => {
  const { kind, time, weekdays, cron, timezone } = config.schedule;
  const schedule = kind === 'cron'
    ? { kind: 'cron', cron }
    : { kind: kind === 'weekly' ? 'weekly' : 'daily', times: [time] };
  if (kind === 'weekly') schedule.weekdays = weekdays;
  if (timezone) schedule.timezone = timezone;
  return {
    id: SCAN_TASK_ID,
    name: SCAN_TASK_NAME,
    // Manual scans still need the task: "Run now" goes through the scheduler.
    enabled: kind !== 'manual',
    suggestedScan: true,
    schedule,
    execution: { prompt: SCAN_TASK_FALLBACK_PROMPT, useDefaults: true },
  };
};

const fileLabel = (file) => {
  if (!file.startLine) return file.path;
  return file.endLine ? `${file.path}:${file.startLine}-${file.endLine}` : `${file.path}:${file.startLine}`;
};

/** The prompt a session started from a suggestion receives. */
const buildApprovalPrompt = (suggestion, action) => {
  const parts = [
    `Work on this task. A "${suggestion.lensName}" scan of OpenChamber's Suggested tasks proposed it, so check that it still applies before you change anything.`,
    `## ${suggestion.title}`,
  ];
  if (suggestion.body) parts.push(suggestion.body);
  if (suggestion.files.length > 0) parts.push(`Files:\n${suggestion.files.map((file) => `- ${fileLabel(file)}`).join('\n')}`);
  if (suggestion.evidence?.length) parts.push(`Evidence:\n${suggestion.evidence.map(({ source, summary, url }) => `- ${source}: ${summary}${url ? ` (${url})` : ''}`).join('\n')}`);
  if (action === 'draft-pr') {
    parts.push('When the change is done and verified, commit it on this worktree\'s branch, push the branch, and open a draft pull request that describes the change. Stop once the draft pull request exists.');
  }
  return parts.join('\n\n');
};

const worktreeNameFor = (suggestion) => {
  const slug = suggestion.title.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return `suggested-${slug || suggestion.id.slice(-8)}`;
};

const todoTextFor = (suggestion) => {
  const text = suggestion.body ? `${suggestion.title}\n\n${suggestion.body}` : suggestion.title;
  return text.length > MAX_TODO_LENGTH ? `${text.slice(0, MAX_TODO_LENGTH - 1)}…` : text;
};

const isPending = (suggestion) => suggestion.status === 'open' || suggestion.status === 'snoozed';

/** A snoozed suggestion whose time has come reads as open again; nothing has to wake it. */
const presentSuggestion = (suggestion, nowMs) => (
  suggestion.status === 'snoozed' && (suggestion.snoozedUntil ?? 0) <= nowMs
    ? { ...suggestion, status: 'open', snoozedUntil: undefined }
    : suggestion
);

const runStatusOf = (lenses) => {
  if (lenses.some((lens) => lens.status === 'running' || lens.status === 'pending')) return 'running';
  if (lenses.every((lens) => lens.status === 'done')) return 'done';
  if (lenses.every((lens) => lens.status === 'failed')) return 'failed';
  return 'partial';
};

const tokenTotal = (tokens) => (tokens.input ?? 0) + (tokens.output ?? 0) + (tokens.reasoning ?? 0);

// Boundary schemas for the event hub and OpenCode answers.
const statusEventSchema = z.object({
  type: z.literal('session.status'),
  properties: z.object({ sessionID: z.string().min(1), status: z.object({ type: z.string().min(1) }) }),
});
const usageEventSchema = z.object({
  type: z.literal('session.updated'),
  properties: z.object({
    sessionID: z.string().min(1),
    info: z.object({
      tokens: z.object({ input: z.number().optional(), output: z.number().optional(), reasoning: z.number().optional() }),
    }),
  }),
});
const deletedEventSchema = z.object({
  type: z.literal('session.deleted'),
  properties: z.object({ sessionID: z.string().min(1) }),
});
const messagePageSchema = z.object({ data: z.array(z.unknown()) });
const sessionIdSchema = z.object({ id: z.string().min(1) });
const sessionUsageSchema = z.object({ tokens: z.object({ input: z.number(), output: z.number(), reasoning: z.number() }) });
const inboxItemsSchema = z.array(z.object({ id: z.string().min(1) }));
const mcpServersSchema = z.array(z.object({ name: z.string(), status: z.object({ status: z.string() }) }));

const STOP_MESSAGES = {
  budget: 'Stopped: the run used up its token budget.',
  timeout: 'Stopped: the lens ran longer than 45 minutes.',
  user: 'Stopped before it finished.',
};

export const createSuggestedTasksRuntime = (deps) => {
  const {
    projectConfigRuntime,
    scheduledTasksRuntime,
    store,
    listProjects,
    projectContextRuntime,
    sessionService,
    deliverSuggestionToBot,
    sessionKnowledgeRuntime,
    permissionAutoAcceptRuntime,
    // Returns OpenCode mcp.list's unwrapped array of { name, status: { status } }.
    // No reader means availability is unknown, so configured rules are omitted.
    readMcpServers,
    readSessionDefaults,
    globalEventHub,
    git,
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    notify,
    broadcast,
    isLinearConnected = () => false,
    readProjectOpenIssues,
    scanCheckoutsDir,
    // A directory-scoped OpenCode client; tests pass their own.
    createClient = null,
    fetchImpl = fetch,
    now = Date.now,
    logger = console,
    lensTimeoutMs = LENS_TIMEOUT_MS,
    quietMs = QUIET_MS,
    settleRecheckMs = SETTLE_RECHECK_MS,
    sweepIntervalMs = SWEEP_INTERVAL_MS,
  } = deps;

  const clientFor = createClient ?? ((directory) => OpenCode.make({
    baseUrl: new URL(buildOpenCodeUrl('/api/info', '')).origin,
    headers: { ...getOpenCodeAuthHeaders(), 'x-opencode-directory': encodeURIComponent(directory) },
    fetch: async (...args) => {
      const response = await fetchImpl(...args);
      assertOpenCodeApiResponse(response);
      return response;
    },
  }));
  const activityProbe = createSessionActivityProbe({ buildOpenCodeUrl, getOpenCodeAuthHeaders, timeoutMs: FETCH_TIMEOUT_MS, fetchImpl });

  const changed = (projectId) => {
    try {
      broadcast({ type: 'openchamber:suggested-tasks-changed', properties: { projectId } });
    } catch (error) {
      logger.warn?.('[suggested-tasks] could not announce a change:', error?.message ?? error);
    }
  };

  // --- projects and config ---------------------------------------------------

  const findProject = async (projectId) => {
    const project = (await listProjects()).find((entry) => entry?.id === projectId && entry?.path);
    if (!project) throw httpError('Project not found', 404);
    return { id: project.id, path: project.path, label: project.label || path.basename(project.path) };
  };

  const readConfig = async (projectId) => {
    const read = readSuggestedTasksConfig(await projectConfigRuntime.readSuggestedTasksSection(projectId));
    if (!read.ok) throw httpError(`The Suggested tasks settings of this project cannot be read (${read.error}). Save them again to repair them.`, 500);
    return read.config;
  };

  const syncScanTask = async (projectId, config) => {
    const tasks = await projectConfigRuntime.listScheduledTasks(projectId);
    const existing = tasks.find((task) => task.id === SCAN_TASK_ID);
    if (!config.enabled) {
      if (existing) await projectConfigRuntime.deleteScheduledTask(projectId, SCAN_TASK_ID);
    } else {
      await projectConfigRuntime.upsertScheduledTask(projectId, scanTaskFor(config));
    }
    await scheduledTasksRuntime.syncProject(projectId);
  };

  const presets = LENS_PRESETS.map(({ id, web, prompt }) => ({ id, web, prompt }));

  /** What the settings page shows: the config, the repository's lenses, the presets and the next scheduled scan. */
  const getSettings = async (projectId) => {
    const project = await findProject(projectId);
    const config = await readConfig(projectId);
    const [repoLenses, tasks] = await Promise.all([
      listRepositoryLenses(project.path, config.lensApprovals),
      projectConfigRuntime.listScheduledTasks(projectId),
    ]);
    const task = tasks.find((entry) => entry.id === SCAN_TASK_ID);
    const { lensApprovals: _approvals, ...editable } = config;
    return {
      config: editable,
      repoLenses,
      presets,
      nextRunAt: task?.enabled ? task.state?.nextRunAt ?? null : null,
    };
  };

  const saveConfig = async (projectId, input) => {
    await findProject(projectId);
    const edit = parseConfigEdit(input);
    if (edit.schedule.kind === 'cron') {
      try {
        CronExpressionParser.parse(edit.schedule.cron, { tz: edit.schedule.timezone || DateTime.local().zoneName });
      } catch {
        throw httpError('schedule.cron: not a valid cron expression', 400);
      }
    }
    if (edit.schedule.timezone && !DateTime.local().setZone(edit.schedule.timezone).isValid) {
      throw httpError('schedule.timezone: unknown time zone', 400);
    }
    let saved = null;
    await projectConfigRuntime.updateSuggestedTasksSection(projectId, (current) => {
      // Approvals survive an edit even when the rest of the stored key no longer validates.
      const approvals = z.object({ lensApprovals: z.record(z.string(), z.string()) }).safeParse(current).data?.lensApprovals ?? {};
      saved = { ...edit, lensApprovals: approvals };
      return saved;
    });
    await syncScanTask(projectId, saved);
    changed(projectId);
    return getSettings(projectId);
  };

  const setRepoLensEnabled = async (projectId, file, enabled) => {
    const project = await findProject(projectId);
    const config = await readConfig(projectId);
    const lens = (await listRepositoryLenses(project.path, config.lensApprovals)).find((entry) => entry.file === file);
    if (!lens) throw httpError('Lens file not found', 404);
    if (enabled && lens.status === 'invalid') throw httpError(`This lens file cannot be read: ${lens.error}`, 400);
    await projectConfigRuntime.updateSuggestedTasksSection(projectId, (current) => {
      const latest = readSuggestedTasksConfig(current);
      if (!latest.ok) throw httpError(latest.error, 500);
      const approvals = { ...latest.config.lensApprovals };
      if (enabled) approvals[file] = lens.fingerprint;
      else delete approvals[file];
      return { ...current, lensApprovals: approvals };
    });
    changed(projectId);
    return getSettings(projectId);
  };

  // --- running a scan ----------------------------------------------------------

  /** In memory: which lenses a manual run asked for, handed from `runNow` to the scheduler's call of `runScan`. */
  const manualLensSelection = new Map();

  /** sessionId -> { projectId, runId, lensId, startedAt } for every lens session still running. */
  const watched = new Map();
  const tokensBySession = new Map();
  const stopReasons = new Map();
  const interruptedSessions = new Set();
  const settledDispatches = new Set();
  const timers = new Map();
  const failures = new Map();
  const settleChecks = new Map();
  const ticking = new Set();
  const inFlight = new Set();
  const track = (promise) => {
    inFlight.add(promise);
    promise.then(() => inFlight.delete(promise), () => inFlight.delete(promise));
    return promise;
  };
  let stopped = false;
  let sweepTimer = null;
  let releaseHub = null;
  let restoring = false;
  let pendingRecovery = false;

  const lensesToRun = (config, repoLenses, selection) => {
    const personal = config.lenses
      .filter((lens) => lens.enabled)
      .map((lens) => ({ ...lens }));
    const repository = repoLenses
      .filter((lens) => lens.status === 'enabled')
      .map((lens) => ({ ...lens }));
    const all = [...personal, ...repository];
    return selection ? all.filter((lens) => selection.includes(lens.id)) : all;
  };

  const knownFor = async (projectId, inbox, config, issues) => {
    const nowMs = now();
    const pending = inbox.suggestions.filter(isPending).map((entry) => presentSuggestion(entry, nowMs));
    const dismissed = config.dedupe.dismissed
      ? inbox.suggestions.filter((entry) => entry.status === 'dismissed').slice(0, MAX_FEEDBACK_ITEMS)
      : [];
    let todos = [];
    if (config.dedupe.todos) {
      todos = (await projectContextRuntime.readContext(projectId)).todos.filter((todo) => !todo.completed).map((todo) => todo.text);
    }
    return {
      open: pending.map((entry) => entry.title),
      handled: inbox.suggestions.filter((entry) => entry.status === 'approved').map((entry) => entry.title),
      dismissed: dismissed.map((entry) => ({ title: entry.title, reason: entry.dismissReason ?? '' })),
      todos,
      issues,
    };
  };

  const hasRunningScan = (inbox) => inbox.runs.some((run) => run.status === 'running');
  const needsOwnerRecovery = (inbox) => inbox.runs.some((run) => run.status === 'running' && run.lenses.some((lens) => lens.status === 'pending' || lens.dispatch === 'created'))
    || inbox.suggestions.some((suggestion) => suggestion.conversionPending && !suggestion.conversionRecoverable);

  const recordRun = (projectId, run) => store.update(projectId, (inbox) => ({ inbox: { ...inbox, runs: [run, ...inbox.runs] }, result: run }));

  const startLensSession = async ({ projectId, run, lens, scanDirectory, prompt }) => {
    const selection = lens.model.useDefaults
      ? await Promise.resolve(readSessionDefaults(projectId)).catch(() => null)
      : lens.model;
    const client = clientFor(scanDirectory);
    const input = {
      title: `${lens.name} · Suggested tasks`,
      location: { directory: scanDirectory },
      // Kept out of In work like a scheduled run: nobody sent it.
      metadata: { openchamber: {
        kind: 'scheduled', suggestedScan: { runId: run.id, lensId: lens.id },
        automation: { source: 'suggested-tasks', runId: run.id, lensId: lens.id, notify: 'attention' },
      } },
      permissions: scanPermissions(lens.web, lens.mcp),
    };
    if (selection?.providerID && selection?.modelID) {
      input.model = { providerID: selection.providerID, id: selection.modelID };
      if (selection.variant) input.model.variant = selection.variant;
    }
    if (selection?.agent) input.agent = selection.agent;
    const session = sessionIdSchema.parse(await client.session.create(input));
    await store.update(projectId, (inbox) => ({
      inbox: { ...inbox, runs: inbox.runs.map((entry) => entry.id === run.id ? {
        ...entry, lenses: entry.lenses.map((entryLens) => entryLens.lensId === lens.id ? {
          ...entryLens, sessionId: session.id, directory: scanDirectory, status: 'pending', dispatch: 'created',
        } : entryLens),
      } : entry) },
    }));
    try {
      // Fail closed if the policy cannot be installed. Settings must not
      // auto-answer a lens's explicit ask rules.
      await permissionAutoAcceptRuntime.setSessionPolicy(session.id, 'ask', scanDirectory);
      try {
        await sessionKnowledgeRuntime.sync(session.id, scanDirectory, { includeMemorySaveRule: false });
      } catch (error) {
        logger.warn?.('[suggested-tasks] could not sync lens knowledge:', error?.message ?? error);
      }
      const currentRun = (await store.read(projectId)).runs.find((entry) => entry.id === run.id);
      if (currentRun?.stopRequested || !(await readConfig(projectId)).enabled) throw httpError('The scan was stopped before this lens was dispatched', 409);
      await store.update(projectId, (inbox) => ({ inbox: { ...inbox, runs: inbox.runs.map((entry) => entry.id === run.id ? {
        ...entry, lenses: entry.lenses.map((entryLens) => entryLens.lensId === lens.id ? { ...entryLens, status: 'running', dispatch: 'sending' } : entryLens),
      } : entry) } }));
    } catch (error) {
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), { sessionId: session.id });
    }
    watched.set(session.id, { projectId, runId: run.id, lensId: lens.id, startedAt: now() });
    let dispatch = 'sent';
    let dispatchError;
    try {
      await client.session.prompt({ sessionID: session.id, text: prompt }, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    } catch (error) {
      // A rejected response does not prove OpenCode rejected the prompt.
      // Keep the watch, budget and checkout until authoritative reconciliation.
      dispatch = 'uncertain';
      dispatchError = `Prompt delivery is uncertain: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      settledDispatches.add(session.id);
    }
    await store.update(projectId, (inbox) => ({ inbox: { ...inbox, runs: inbox.runs.map((entry) => entry.id === run.id ? {
      ...entry, lenses: entry.lenses.map((entryLens) => entryLens.lensId === lens.id ? { ...entryLens, dispatch, error: entryLens.status === 'running' ? dispatchError : entryLens.error } : entryLens),
    } : entry) } })).catch((error) => logger.warn?.('[suggested-tasks] could not record prompt delivery:', error?.message ?? error));
    const reason = stopReasons.get(session.id);
    if (reason) {
      stopReasons.delete(session.id);
      interruptedSessions.delete(session.id);
      await stopLens(session.id, reason).catch((error) => logger.warn?.('[suggested-tasks] could not stop a delivered prompt:', error?.message ?? error));
    }
    return session.id;
  };

  const removeScanCheckout = async (projectPath, worktree) => {
    if (!worktree) return;
    if (path.dirname(path.resolve(worktree)) !== path.resolve(scanCheckoutsDir)) throw new Error('Refusing to remove a checkout outside the scan directory');
    await git.removeDetachedWorktree(projectPath, worktree);
  };

  /**
   * One scan of a project, started by the scheduler (`reason` scheduled) or
   * by "Run now" (manual). Starts the lens sessions and returns; they finish
   * on their own. Answers what the scheduler records: the first session, the
   * directory, or why nothing ran.
   */
  const runScan = async (projectId, reason) => {
    const selection = reason === 'manual' ? manualLensSelection.get(projectId) ?? null : null;
    const project = await findProject(projectId);
    const config = await readConfig(projectId);
    const startedAt = now();
    const run = {
      id: `run_${startedAt}_${randomUUID().slice(0, 8)}`,
      reason,
      startedAt,
      status: 'running',
      maxSuggestions: config.limits.maxSuggestions,
      ownerPid: process.pid,
      ownerHost: os.hostname(),
      lenses: [],
    };
    if (config.limits.tokenBudget) run.tokenBudget = config.limits.tokenBudget;

    const skip = async (why) => {
      await recordRun(projectId, { ...run, status: 'skipped', skipped: why, finishedAt: now() });
      changed(projectId);
      return { skipped: why };
    };

    if (!config.enabled) return skip('disabled');
    if (reason === 'scheduled' && isInQuietHours(config.quietHours, config.schedule.timezone, startedAt)) return skip('quiet-hours');
    const inbox = await store.read(projectId);
    // A run still going takes precedence; the next occurrence tries again.
    if (hasRunningScan(inbox)) {
      if (reason === 'manual') throw httpError('A scan of this project is still running', 409);
      return { skipped: 'busy' };
    }
    const repoLenses = await listRepositoryLenses(project.path, config.lensApprovals);
    const lenses = lensesToRun(config, repoLenses, selection);
    if (lenses.length === 0) return skip('no-lenses');
    run.scope = config.scope;
    run.limits = config.limits;
    run.lenses = lenses.map((lens) => ({ lensId: lens.id, lensName: lens.name, action: lens.action, status: 'pending', startedAt, reported: 0, added: 0, tokens: 0 }));
    const claimed = await store.update(projectId, (current) => hasRunningScan(current)
      ? { result: false }
      : { inbox: { ...current, runs: [run, ...current.runs] }, result: true });
    if (!claimed) throw httpError('A scan of this project is still running', 409);

    try {

    let scanDirectory = project.path;
    const { baseBranch, incremental } = config.scope;
    let checkout = null;
    try {
      checkout = await git.readScanCheckout(project.path);
    } catch (error) {
      // A folder that is not a repository can still be read; only a branch
      // or an incremental scan needs Git.
      if (baseBranch || incremental) throw error;
    }
    if (baseBranch && checkout && baseBranch !== checkout.branch) {
      run.worktree = path.join(scanCheckoutsDir, run.id);
      await store.update(projectId, (current) => ({ inbox: { ...current, runs: current.runs.map((entry) => entry.id === run.id ? { ...entry, worktree: run.worktree } : entry) } }));
      await fs.promises.mkdir(scanCheckoutsDir, { recursive: true });
      await git.addDetachedWorktree(project.path, run.worktree, baseBranch);
      scanDirectory = run.worktree;
      checkout = await git.readScanCheckout(run.worktree);
    }
    const branchKey = baseBranch || checkout?.branch || 'HEAD';
    if (checkout) {
      run.branch = branchKey;
      run.commit = checkout.commit;
    }

    let changedFiles = null;
    const previous = inbox.lastScanned[branchKey];
    if (incremental && checkout && previous) {
      const listed = await git.listChangedPathsSince(scanDirectory, previous, checkout.commit);
      if (listed) {
        changedFiles = listed.filter((file) => isInScope(file, config.scope));
        if (changedFiles.length === 0) {
          await removeScanCheckout(project.path, run.worktree);
          await store.update(projectId, (current) => ({ inbox: { ...current, runs: current.runs.map((entry) => entry.id === run.id ? { ...run, lenses: [], status: 'skipped', skipped: 'no-changes', finishedAt: now() } : entry) } }));
          changed(projectId);
          return { skipped: 'no-changes' };
        }
        run.changedFiles = changedFiles.length;
      }
    }

    const openIssues = await readProjectOpenIssues(project.path);
    run.openIssues = openIssues.titles;
    run.warnings = openIssues.warnings.map((warning) => warning.message);
    let availableServers = [];
    if (lenses.some((lens) => lens.mcp.length > 0)) {
      try {
        if (!readMcpServers) throw new Error('MCP availability reader is unavailable');
        availableServers = mcpServersSchema.parse(await readMcpServers(scanDirectory));
      } catch (error) {
        run.warnings.push(`Could not read MCP availability: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const runnableLenses = lenses.map((lens) => ({ ...lens, mcp: lens.mcp.filter(({ server }) => {
      if (availableServers.some((entry) => entry.name === server && entry.status.status === 'connected')) return true;
      run.warnings.push(`MCP server "${server}" is unavailable for lens "${lens.name}"; its tools were omitted.`);
      return false;
    }) }));
    const known = await knownFor(projectId, inbox, config, openIssues.titles);
    await store.update(projectId, (current) => ({ inbox: { ...current, runs: current.runs.map((entry) => entry.id === run.id ? { ...run, stopRequested: entry.stopRequested } : entry) } }));
    changed(projectId);

    let firstSessionId = null;
    for (const lens of runnableLenses) {
      const lensRun = { lensId: lens.id, lensName: lens.name, action: lens.action, status: 'running', startedAt: now(), reported: 0, added: 0, tokens: 0 };
      try {
        const latestRun = (await store.read(projectId)).runs.find((entry) => entry.id === run.id);
        if (latestRun?.stopRequested) throw httpError('The scan was stopped', 409);
        if (latestRun?.tokenBudget && latestRun.lenses.reduce((sum, entry) => sum + entry.tokens, 0) >= latestRun.tokenBudget) throw httpError('The scan used up its token budget', 409);
        const prompt = buildScanPrompt({ lens, scope: config.scope, maxSuggestions: config.limits.maxSuggestions, changedFiles, known });
        lensRun.sessionId = await startLensSession({ projectId, run, lens, scanDirectory, prompt });
        lensRun.directory = scanDirectory;
        firstSessionId ??= lensRun.sessionId;
      } catch (error) {
        lensRun.status = 'failed';
        lensRun.finishedAt = now();
        lensRun.error = `Could not start the lens: ${error instanceof Error ? error.message : String(error)}`;
        if (error?.sessionId) lensRun.sessionId = error.sessionId;
      }
      const finished = await store.update(projectId, (current) => {
        const stored = current.runs.find((entry) => entry.id === run.id);
        if (!stored) return { result: false };
        const lensesNow = stored.lenses.map((entry) => entry.lensId === lens.id && (entry.status === 'running' || entry.status === 'pending') ? { ...entry, ...lensRun, tokens: Math.max(entry.tokens, tokensBySession.get(lensRun.sessionId) ?? 0) } : entry);
        const status = runStatusOf(lensesNow);
        const next = { ...stored, lenses: lensesNow, status };
        if (status !== 'running') next.finishedAt = now();
        return { inbox: { ...current, runs: current.runs.map((entry) => (entry.id === run.id ? next : entry)) }, result: status !== 'running' };
      });
      // Every lens failed to start: nothing will finish the run later.
      if (finished) await finishRun(projectId, run.id);
      changed(projectId);
    }
    for (const sessionId of watched.keys()) if (watched.get(sessionId).runId === run.id) arm(sessionId);
    return { sessionID: firstSessionId, directory: scanDirectory };
    } catch (error) {
      await store.update(projectId, (current) => ({ inbox: { ...current, runs: current.runs.map((entry) => entry.id === run.id ? {
        ...entry, status: entry.lenses.some((lens) => lens.status === 'running') ? 'running' : 'failed', error: error instanceof Error ? error.message : String(error),
        lenses: entry.lenses.map((lens) => lens.status === 'pending' ? { ...lens, status: 'failed', finishedAt: now(), error: 'The scan could not start this lens.' } : lens),
      } : entry) } }));
      if (![...watched.values()].some((entry) => entry.runId === run.id)) await removeScanCheckout(project.path, run.worktree);
      changed(projectId);
      throw error;
    }
  };

  /** "Run now": every enabled lens, or the ones named. Goes through the scheduler like a timed run. */
  const runNow = async (projectId, lensIds) => {
    await findProject(projectId);
    const config = await readConfig(projectId);
    if (!config.enabled) throw httpError('Turn on Suggested tasks for this project first', 409);
    if (hasRunningScan(await store.read(projectId))) throw httpError('A scan of this project is still running', 409);
    if (manualLensSelection.has(projectId)) throw httpError('A scan of this project is starting', 409);
    manualLensSelection.set(projectId, lensIds && lensIds.length > 0 ? lensIds : null);
    let result;
    try {
      result = await scheduledTasksRuntime.runNow(projectId, SCAN_TASK_ID);
    } finally {
      manualLensSelection.delete(projectId);
    }
    if (result.running || result.queued) throw httpError('A scan of this project is starting', 409);
    if (result.skipped) throw httpError('Turn on Suggested tasks for this project first', 409);
    if (!result.ok) throw httpError(result.error || 'The scan could not start', result.statusCode || 500);
    return getInbox(projectId);
  };

  // --- finishing lenses --------------------------------------------------------

  /** Cleanup once every lens of a run has finished: checkout, archive, notification. */
  async function finishRun(projectId, runId) {
    return withSourceControlFileLock(`${store.filePathFor(projectId)}.finish.lock`, async () => {
    const project = await findProject(projectId).catch(() => null);
    const config = await readConfig(projectId).catch(() => null);
    const run = (await store.read(projectId)).runs.find((entry) => entry.id === runId);
    if (!run || run.status === 'running' || run.finalized) return;
    if (project) await removeScanCheckout(project.path, run.worktree);
    const sessionIds = run.lenses.map((lens) => lens.sessionId).filter(Boolean);
    if (config?.archiveScanSessions && sessionIds.length > 0) {
      await sessionService.archive({ ids: sessionIds }).catch((error) => {
        logger.warn?.('[suggested-tasks] could not archive the scan sessions:', error?.message ?? error);
      });
    }
    const added = run.lenses.reduce((sum, lens) => sum + lens.added, 0);
    if (config?.notify && added > 0 && project) {
      await Promise.resolve(notify({
        title: 'Suggested tasks',
        body: added === 1 ? `1 new suggestion for ${project.label}` : `${added} new suggestions for ${project.label}`,
        tag: `suggested-tasks:${projectId}`,
        directory: project.path,
      })).catch((error) => logger.warn?.('[suggested-tasks] could not notify:', error?.message ?? error));
    }
    await store.update(projectId, (inbox) => ({ inbox: { ...inbox, runs: inbox.runs.map((entry) => entry.id === runId ? { ...entry, finalized: true, worktree: undefined } : entry) } }));
    }, { waitMs: 10_000 });
  }

  const applyAutomaticActions = async (projectId, suggestions, action) => {
    if (action === 'suggest') return;
    for (const suggestion of suggestions) {
      try {
        const config = await readConfig(projectId);
        const project = await findProject(projectId);
        const repository = await listRepositoryLenses(project.path, config.lensApprovals);
        if (!config.enabled || !lensesToRun(config, repository, null).some((lens) => lens.id === suggestion.lensId && lens.action === action)) continue;
        await approve(projectId, suggestion.id, { action, auto: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn?.('[suggested-tasks] automatic action failed:', message);
        await store.update(projectId, (inbox) => ({
          inbox: { ...inbox, suggestions: inbox.suggestions.map((entry) => (entry.id === suggestion.id ? { ...entry, conversionError: message } : entry)) },
        }));
      }
    }
  };

  /**
   * Turns a lens session's end into suggestions. Idempotent: a lens that is
   * no longer running (another process finished it first) is left alone.
   */
  const completeLens = async (sessionId, outcome) => {
    const meta = watched.get(sessionId);
    if (!meta) return;
    const { projectId, runId, lensId } = meta;
    const project = await findProject(projectId);
    const config = await readConfig(projectId);
    const inboxBefore = await store.read(projectId);
    const runBefore = inboxBefore.runs.find((entry) => entry.id === runId);
    const known = await knownFor(projectId, inboxBefore, config, runBefore?.openIssues ?? []);
    const root = runBefore?.worktree ?? project.path;

    let parsed = null;
    let parseError = null;
    if (outcome.text) {
      try {
        parsed = parseScanOutput(outcome.text, root);
      } catch (error) {
        if (!(error instanceof ScanOutputError)) throw error;
        parseError = error.message;
      }
    } else {
      parseError = 'The scan ended without an answer.';
    }

    const result = await store.update(projectId, (inbox) => {
      const run = inbox.runs.find((entry) => entry.id === runId);
      // A short turn can end before `runScan` recorded the lens: try again shortly.
      if (run?.status === 'running' && !run.lenses.some((entry) => entry.sessionId === sessionId)) return { result: 'not-recorded' };
      const lens = run?.lenses.find((entry) => entry.lensId === lensId && entry.sessionId === sessionId);
      if (!run || !lens || lens.status !== 'running') return { result: null };
      const finishedAt = now();
      const stopReason = lens.stopReason ?? stopReasons.get(sessionId) ?? null;
      const nextLens = { ...lens, finishedAt, error: undefined, tokens: tokensBySession.get(sessionId) ?? lens.tokens };
      let added = [];
      if (parsed) {
        const slots = Math.min(run.maxSuggestions - run.lenses.reduce((sum, entry) => sum + entry.added, 0), 500 - inbox.suggestions.filter(isPending).length);
        const knownSuggestions = inbox.suggestions.filter((entry) => entry.status !== 'dismissed' || config.dedupe.dismissed);
        const knownTitles = [...known.issues, ...known.todos.map((text) => text.split('\n', 1)[0])];
        const selected = selectSuggestions({ reported: parsed.suggestions, scope: run.scope ?? config.scope, limits: run.limits ?? config.limits, knownTitles, knownSuggestions, slots });
        added = selected.suggestions.map((suggestion, index) => ({
          ...suggestion,
          id: `sug_${finishedAt}_${index}_${randomUUID().slice(0, 8)}`,
          runId,
          lensId,
          lensName: lens.lensName,
          createdAt: finishedAt,
          status: 'open',
        }));
        nextLens.reported = parsed.suggestions.length;
        nextLens.added = added.length;
        nextLens.dropped = { ...selected.counts, invalid: parsed.invalid };
      }
      if (stopReason) {
        nextLens.status = 'stopped';
        nextLens.error = STOP_MESSAGES[stopReason];
      } else if (outcome.state === 'completed' && parsed) {
        nextLens.status = 'done';
      } else if (outcome.state === 'cancelled') {
        nextLens.status = 'stopped';
        nextLens.error = STOP_MESSAGES.user;
      } else {
        nextLens.status = 'failed';
        nextLens.error = outcome.state === 'error'
          ? (outcome.errorMessage ? `The session failed: ${outcome.errorMessage}` : 'The session failed.')
          : parseError ?? 'The scan failed.';
      }
      const lenses = run.lenses.map((entry) => (entry === lens ? nextLens : entry));
      const status = runStatusOf(lenses);
      const nextRun = { ...run, lenses, status };
      const lastScanned = { ...inbox.lastScanned };
      if (status !== 'running') {
        nextRun.finishedAt = finishedAt;
        // Only a run every lens finished moves the incremental baseline: a
        // failed lens must see these changes again next time.
        if (status === 'done' && run.branch && run.commit) lastScanned[run.branch] = run.commit;
      }
      return {
        inbox: {
          ...inbox,
          suggestions: [...added, ...inbox.suggestions],
          runs: inbox.runs.map((entry) => (entry.id === runId ? nextRun : entry)),
          lastScanned,
        },
        result: { added, finished: status !== 'running', action: lens.action },
      };
    });

    if (result === 'not-recorded') {
      arm(sessionId, settleRecheckMs);
      return;
    }
    watched.delete(sessionId);
    tokensBySession.delete(sessionId);
    stopReasons.delete(sessionId);
    interruptedSessions.delete(sessionId);
    settledDispatches.delete(sessionId);
    if (!result) return;
    changed(projectId);
    await applyAutomaticActions(projectId, result.added, result.action);
    if (result.finished) await finishRun(projectId, runId);
  };

  // --- watching lens sessions ------------------------------------------------

  const readRecords = async (sessionId) => {
    const url = new URL(buildOpenCodeUrl(`/api/session/${encodeURIComponent(sessionId)}/message`, ''));
    url.searchParams.set('limit', String(MESSAGE_PAGE_LIMIT));
    url.searchParams.set('order', 'desc');
    const response = await fetchImpl(url, { headers: { Accept: 'application/json', ...getOpenCodeAuthHeaders() }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (response.status === 404) return { deleted: true };
    if (!response.ok) throw new Error(`OpenCode answered ${response.status}`);
    const body = unwrapOpenCodeResponse(await response.json().catch(() => null));
    const page = messagePageSchema.safeParse(body);
    if (page.success) return { records: page.data.data };
    // A page without a cursor loses its envelope in `unwrapOpenCodeResponse`.
    const records = z.array(z.unknown()).safeParse(body);
    if (!records.success) throw new Error('OpenCode answered with something that is not a message page');
    return { records: records.data };
  };

  const clearTimer = (sessionId) => {
    const timer = timers.get(sessionId);
    if (timer) clearTimeout(timer);
    timers.delete(sessionId);
  };

  function arm(sessionId, delayMs = quietMs) {
    if (stopped || !watched.has(sessionId)) return;
    clearTimer(sessionId);
    const timer = setTimeout(() => {
      timers.delete(sessionId);
      track(tick(sessionId)).catch((error) => logger.warn?.('[suggested-tasks] tick failed:', error?.message ?? error));
    }, Math.max(0, delayMs));
    timer.unref?.();
    timers.set(sessionId, timer);
  }

  const retryLater = (sessionId) => {
    const count = (failures.get(sessionId) ?? 0) + 1;
    failures.set(sessionId, count);
    arm(sessionId, Math.min(RETRY_BASE_DELAY_MS * 2 ** (count - 1), RETRY_MAX_DELAY_MS));
  };

  // Unknown is never "finished": a failed read retries instead of guessing.
  async function tick(sessionId) {
    if (stopped || !watched.has(sessionId)) return;
    if (ticking.has(sessionId)) {
      arm(sessionId);
      return;
    }
    ticking.add(sessionId);
    try {
      const statuses = await activityProbe.fetchActiveSessionStatuses();
      if (!statuses) {
        retryLater(sessionId);
        return;
      }
      if (statuses[sessionId]) {
        const meta = watched.get(sessionId);
        const run = (await store.read(meta.projectId)).runs.find((entry) => entry.id === meta.runId);
        const reason = run?.lenses.find((lens) => lens.sessionId === sessionId)?.stopReason ?? (run?.stopRequested ? 'user' : null);
        if (reason) await stopLens(sessionId, reason);
        return;
      }
      const read = await readRecords(sessionId);
      failures.delete(sessionId);
      if (read.deleted) {
        await completeLens(sessionId, { state: 'cancelled', text: '', errorMessage: '' });
        return;
      }
      const outcome = readDispatchOutcome(read.records, 0, null);
      if (!outcome) {
        const meta = watched.get(sessionId);
        const run = (await store.read(meta.projectId)).runs.find((entry) => entry.id === meta.runId);
        const lens = run?.lenses.find((entry) => entry.sessionId === sessionId);
        const reason = lens?.stopReason ?? (run?.stopRequested ? 'user' : null);
        if (reason) {
          if (!interruptedSessions.has(sessionId)) {
            await stopLens(sessionId, reason);
            arm(sessionId, settleRecheckMs);
            return;
          }
          const project = await findProject(meta.projectId);
          const queued = inboxItemsSchema.parse(await clientFor(project.path).session.inbox.list({ sessionID: sessionId }));
          if (queued.length > 0) {
            stopReasons.delete(sessionId);
            interruptedSessions.delete(sessionId);
            await stopLens(sessionId, reason);
            arm(sessionId, settleRecheckMs);
            return;
          }
          let ownerAlive = false;
          if (lens?.dispatch === 'sending' && !settledDispatches.has(sessionId) && run.ownerHost === os.hostname() && run.ownerPid) {
            try { process.kill(run.ownerPid, 0); ownerAlive = true; } catch (error) { ownerAlive = error?.code === 'EPERM'; }
          }
          if (!ownerAlive && lens?.dispatch !== 'created') {
            await completeLens(sessionId, { state: 'cancelled', text: '', errorMessage: '' });
            return;
          }
        }
        const spent = settleChecks.get(sessionId) ?? 0;
        if (spent < SETTLE_RECHECKS) {
          settleChecks.set(sessionId, spent + 1);
          arm(sessionId, settleRecheckMs);
        }
        return;
      }
      settleChecks.delete(sessionId);
      const meta = watched.get(sessionId);
      const project = await findProject(meta.projectId);
      const usage = sessionUsageSchema.safeParse(await clientFor(project.path).session.get({ sessionID: sessionId }));
      if (usage.success) {
        tokensBySession.set(sessionId, Math.max(tokensBySession.get(sessionId) ?? 0, tokenTotal(usage.data.tokens)));
        await persistUsage(sessionId);
        await enforceBudget(sessionId);
      }
      await completeLens(sessionId, outcome);
    } catch (error) {
      logger.warn?.(`[suggested-tasks] reading lens session ${sessionId} failed:`, error?.message ?? error);
      retryLater(sessionId);
    } finally {
      ticking.delete(sessionId);
    }
  }

  const stopLens = async (sessionId, reason) => {
    const meta = watched.get(sessionId);
    if (!meta || stopReasons.has(sessionId)) return;
    stopReasons.set(sessionId, reason);
    await store.update(meta.projectId, (inbox) => ({ inbox: { ...inbox, runs: inbox.runs.map((run) => run.id === meta.runId ? {
      ...run, lenses: run.lenses.map((lens) => lens.sessionId === sessionId ? { ...lens, stopReason: reason } : lens),
    } : run) } }));
    try {
      const project = await findProject(meta.projectId);
      const client = clientFor(project.path);
      await client.session.interrupt({ sessionID: sessionId });
      const queued = inboxItemsSchema.parse(await client.session.inbox.list({ sessionID: sessionId }));
      for (const item of queued) await client.session.inbox.cancel({ sessionID: sessionId, inboxID: item.id });
      interruptedSessions.add(sessionId);
    } catch (error) {
      stopReasons.delete(sessionId);
      logger.warn?.('[suggested-tasks] could not stop a lens session:', error?.message ?? error);
    }
    arm(sessionId);
  };

  const enforceBudget = async (sessionId) => {
    const meta = watched.get(sessionId);
    if (!meta) return;
    const inbox = await store.read(meta.projectId);
    const run = inbox.runs.find((entry) => entry.id === meta.runId);
    if (!run?.tokenBudget) return;
    const used = run.lenses.reduce((sum, lens) => sum + (tokensBySession.get(lens.sessionId) ?? lens.tokens), 0);
    if (used < run.tokenBudget) return;
    for (const [candidate, entry] of watched) {
      if (entry.runId === meta.runId) await stopLens(candidate, 'budget');
    }
  };

  const processPayload = (payload) => {
    if (stopped) return;
    const deleted = deletedEventSchema.safeParse(payload);
    if (deleted.success) {
      if (watched.has(deleted.data.properties.sessionID)) arm(deleted.data.properties.sessionID);
      return;
    }
    const usage = usageEventSchema.safeParse(payload);
    if (usage.success) {
      const sessionId = usage.data.properties.sessionID;
      if (!watched.has(sessionId)) return;
      tokensBySession.set(sessionId, Math.max(tokensBySession.get(sessionId) ?? 0, tokenTotal(usage.data.properties.info.tokens)));
      void track(persistUsage(sessionId).then(() => enforceBudget(sessionId))).catch((error) => logger.warn?.('[suggested-tasks] budget check failed:', error?.message ?? error));
      return;
    }
    const status = statusEventSchema.safeParse(payload);
    if (!status.success || !watched.has(status.data.properties.sessionID)) return;
    if (status.data.properties.status.type === 'idle') {
      settleChecks.delete(status.data.properties.sessionID);
      arm(status.data.properties.sessionID);
    } else {
      clearTimer(status.data.properties.sessionID);
    }
  };

  const persistUsage = async (sessionId) => {
    const meta = watched.get(sessionId);
    if (!meta) return;
    await store.update(meta.projectId, (inbox) => ({ inbox: { ...inbox, runs: inbox.runs.map((run) => run.id === meta.runId ? {
      ...run, lenses: run.lenses.map((lens) => lens.sessionId === sessionId ? { ...lens, tokens: Math.max(lens.tokens, tokensBySession.get(sessionId) ?? 0) } : lens),
    } : run) } }));
  };

  const sweepTimeouts = () => {
    const nowMs = now();
    for (const [sessionId, meta] of watched) {
      if (nowMs - meta.startedAt > lensTimeoutMs) void track(stopLens(sessionId, 'timeout')).catch((error) => logger.warn?.('[suggested-tasks] timeout stop failed:', error?.message ?? error));
      else if (!timers.has(sessionId) && !ticking.has(sessionId)) arm(sessionId);
    }
    if (pendingRecovery) void track(restoreWatches()).catch((error) => logger.warn?.('[suggested-tasks] recovery sweep failed:', error?.message ?? error));
  };

  /** After a restart: watch every lens session a stored run still waits for. */
  const restoreWatches = async () => {
    if (restoring || stopped) return;
    restoring = true;
    let pending = false;
    try {
    for (const project of await listProjects()) {
      if (!project?.id) continue;
      try {
        await store.update(project.id, (inbox) => {
          let changedRun = false;
          const runs = inbox.runs.map((run) => {
            if (run.status !== 'running' || !run.lenses.some((lens) => lens.status === 'pending' || lens.dispatch === 'created')) return run;
            let ownerAlive = false;
            if (run.ownerHost === os.hostname() && run.ownerPid) {
              try { process.kill(run.ownerPid, 0); ownerAlive = true; } catch (error) { ownerAlive = error?.code === 'EPERM'; }
            }
            if (ownerAlive || (run.ownerHost !== os.hostname() && now() - run.startedAt < lensTimeoutMs)) return run;
            const lenses = run.lenses.map((lens) => lens.status === 'pending' || lens.dispatch === 'created' ? { ...lens, status: 'failed', finishedAt: now(), error: 'Server stopped before this lens was dispatched.' } : lens);
            const status = runStatusOf(lenses);
            changedRun = true;
            return { ...run, lenses, status, finishedAt: status === 'running' ? undefined : now() };
          });
          const suggestions = inbox.suggestions.map((suggestion) => {
            if (!suggestion.conversionPending || suggestion.conversionRecoverable || suggestion.conversionOwnerHost !== os.hostname()) return suggestion;
            try { process.kill(suggestion.conversionOwnerPid, 0); return suggestion; } catch (error) { if (error?.code === 'EPERM') return suggestion; }
            changedRun = true;
            if (suggestion.conversion?.sessionId || suggestion.conversion?.todoId || suggestion.conversion?.itemId) return { ...suggestion, status: 'approved', approvedAt: now(), conversionPending: false, conversionError: 'Server stopped after creating this work. Check its outcome before continuing.' };
            return { ...suggestion, conversionRecoverable: true, conversionError: 'Server stopped during conversion. Check the session and todo lists before restoring this suggestion to retry.' };
          });
          return changedRun ? { inbox: { ...inbox, runs, suggestions } } : {};
        });
        const inbox = await store.read(project.id);
        pending ||= needsOwnerRecovery(inbox);
        const restoredSessions = [];
        for (const run of inbox.runs) {
          if (run.status !== 'running') {
            if (!run.finalized) await finishRun(project.id, run.id);
            continue;
          }
          for (const lens of run.lenses) {
            if (lens.status === 'running' && lens.sessionId && !watched.has(lens.sessionId)) {
              watched.set(lens.sessionId, { projectId: project.id, runId: run.id, lensId: lens.lensId, startedAt: lens.startedAt });
              tokensBySession.set(lens.sessionId, lens.tokens);
              if (lens.stopReason) await stopLens(lens.sessionId, lens.stopReason);
              restoredSessions.push(lens.sessionId);
            }
          }
        }
        for (const sessionId of restoredSessions) {
          const usage = sessionUsageSchema.safeParse(await clientFor(project.path).session.get({ sessionID: sessionId }).catch(() => null));
          if (usage.success) {
            tokensBySession.set(sessionId, Math.max(tokensBySession.get(sessionId) ?? 0, tokenTotal(usage.data.tokens)));
            await persistUsage(sessionId);
          }
          await enforceBudget(sessionId);
          arm(sessionId);
        }
      } catch (error) {
        pending = true;
        logger.warn?.('[suggested-tasks] could not restore the scans of a project', { projectId: project.id, error: error?.message ?? error });
      }
    }
    pendingRecovery = pending;
    } finally {
      restoring = false;
    }
  };

  // --- the inbox -------------------------------------------------------------

  const issueProvidersFor = async (project) => {
    const remotes = await git.getRepositoryRemoteUrls(project.path).catch(() => []);
    return resolveIssueTargets({ remotes, linearConnected: Boolean(isLinearConnected()) });
  };

  const getInbox = async (projectId) => {
    const project = await findProject(projectId);
    const inbox = await store.read(projectId);
    pendingRecovery ||= needsOwnerRecovery(inbox);
    const nowMs = now();
    const targets = await issueProvidersFor(project);
    return {
      suggestions: inbox.suggestions.map((entry) => presentSuggestion(entry, nowMs)),
      runs: inbox.runs,
      issueProviders: targets.map((target) => target.provider),
    };
  };

  /** Open suggestions per project, for the sidebar badge. A project whose inbox cannot be read says so. */
  const getSummary = async () => {
    const nowMs = now();
    const projects = (await listProjects()).filter((project) => project?.id && project?.path);
    return Promise.all(projects.map(async (project) => {
      try {
        const inbox = await store.read(project.id);
        const open = inbox.suggestions.map((entry) => presentSuggestion(entry, nowMs)).filter((entry) => entry.status === 'open').length;
        return { projectId: project.id, open, running: hasRunningScan(inbox) };
      } catch {
        return { projectId: project.id, error: true };
      }
    }));
  };

  const changeSuggestion = async (projectId, suggestionId, change) => {
    await findProject(projectId);
    const result = await store.update(projectId, (inbox) => {
      const current = inbox.suggestions.find((entry) => entry.id === suggestionId);
      if (!current) throw httpError('Suggestion not found', 404);
      const next = change(current);
      return { inbox: { ...inbox, suggestions: inbox.suggestions.map((entry) => (entry.id === suggestionId ? next : entry)) }, result: next };
    });
    changed(projectId);
    return result;
  };

  const withoutDecision = (suggestion) => {
    const { snoozedUntil: _snoozed, dismissedAt: _dismissedAt, dismissReason: _reason, approvedAt: _approvedAt, conversion: _conversion, conversionError: _error, ...rest } = suggestion;
    return rest;
  };

  const dismiss = (projectId, suggestionId, reason) => changeSuggestion(projectId, suggestionId, (current) => {
    if (current.conversionPending) throw httpError('A conversion is pending. Check its outcome before changing this suggestion.', 409);
    if (!isPending(current)) throw httpError('Only an open suggestion can be dismissed', 409);
    const next = { ...withoutDecision(current), status: 'dismissed', dismissedAt: now() };
    const trimmed = (reason ?? '').trim().slice(0, MAX_DISMISS_REASON_LENGTH);
    if (trimmed) next.dismissReason = trimmed;
    return next;
  });

  const snooze = async (projectId, suggestionId, until) => {
    if (!Number.isSafeInteger(until) || until <= now() || until > now() + MAX_SNOOZE_MS) {
      throw httpError('until must be a time in the next year', 400);
    }
    return changeSuggestion(projectId, suggestionId, (current) => {
      if (current.conversionPending) throw httpError('A conversion is pending. Check its outcome before changing this suggestion.', 409);
      if (!isPending(current)) throw httpError('Only an open suggestion can be snoozed', 409);
      return { ...withoutDecision(current), status: 'snoozed', snoozedUntil: until };
    });
  };

  const restore = (projectId, suggestionId) => changeSuggestion(projectId, suggestionId, (current) => {
    if (current.conversionPending && current.conversion?.kind === 'bot') throw httpError('Retry delivery to the same bot to reconcile this suggestion.', 409);
    if (current.conversionPending && (!current.conversionRecoverable || converting.has(`${projectId}:${suggestionId}`))) throw httpError('A conversion is still running.', 409);
    return { ...withoutDecision(current), status: 'open', conversionPending: false, conversionRecoverable: false };
  });

  const converting = new Set();

  /**
   * Turns a suggestion into work: a todo, a session in the project or in a
   * new worktree, a worktree session that works until a draft pull request,
   * an issue form in the tracker, or a draft the client opened. The work is
   * reserved before work is created; partial creation records the session
   * identity and ambiguous failures require explicit reconciliation.
   */
  async function approve(projectId, suggestionId, { action, provider, botId, auto = false }) {
    const key = `${projectId}:${suggestionId}`;
    if (converting.has(key)) throw httpError('This suggestion is already being converted', 409);
    converting.add(key);
    let conversion;
    let reserved = false;
    try {
      const project = await findProject(projectId);
      if (!['todo', 'session', 'worktree', 'draft-pr', 'issue', 'draft', 'bot'].includes(action)) throw httpError('Unknown action', 400);
      if (action === 'bot' && (!botId || auto || !deliverSuggestionToBot)) throw httpError('Select an enabled bot for this suggestion.', 400);
      const suggestion = await changeSuggestion(projectId, suggestionId, (current) => {
        const sameBot = action === 'bot' && current.conversion?.kind === 'bot' && current.conversion.botId === botId;
        if (sameBot && current.status === 'approved' && current.conversion.itemId) return current;
        if ((current.conversionPending && !(sameBot && current.conversionRecoverable)) || !isPending(current) || (auto && current.status !== 'open')) throw httpError('This suggestion was already handled or is being converted', 409);
        const pending = { ...current, conversionPending: true, conversionRecoverable: false, conversionError: undefined, conversionOwnerPid: process.pid, conversionOwnerHost: os.hostname() };
        if (action === 'bot') pending.conversion = { kind: 'bot', botId };
        return pending;
      });
      if (action === 'bot' && suggestion.status === 'approved') return suggestion;
      reserved = true;
      conversion = { kind: action };
      if (auto) conversion.auto = true;
      if (action === 'bot') {
        conversion.botId = botId;
        const result = await deliverSuggestionToBot({ projectId, botId, suggestion });
        conversion.itemId = z.string().min(1).parse(result.itemId);
        await changeSuggestion(projectId, suggestionId, (current) => ({ ...current, conversion }));
      } else if (action === 'todo') {
        const { todo } = await projectContextRuntime.createTodo(projectId, { text: todoTextFor(suggestion) });
        conversion.todoId = todo.id;
      } else if (action === 'session' || action === 'worktree' || action === 'draft-pr') {
        let permissionMode = 'default';
        if (auto) {
          const config = await readConfig(projectId);
          const repository = await listRepositoryLenses(project.path, config.lensApprovals);
          const lens = lensesToRun(config, repository, null).find((entry) => entry.id === suggestion.lensId && entry.action === action);
          if (!config.enabled || !lens) throw httpError('The automatic lens action is no longer enabled', 409);
          permissionMode = lens.permissionMode;
        }
        const payload = { projectId, title: suggestion.title, prompt: buildApprovalPrompt(suggestion, action) };
        if (action !== 'session') payload.worktree = { name: worktreeNameFor(suggestion) };
        if (action === 'draft-pr') payload.goal = true;
        const options = {
          onSessionCreated: async (createdSession) => {
            conversion.sessionId = createdSession.sessionId;
            conversion.directory = createdSession.directory;
            await changeSuggestion(projectId, suggestionId, (current) => ({ ...current, conversion }));
            if (auto && permissionMode !== 'default') {
              await permissionAutoAcceptRuntime.setSessionPolicy(createdSession.sessionId, permissionMode, createdSession.directory);
            }
          },
        };
        if (auto) options.metadata = { openchamber: {
          kind: 'scheduled',
          automation: { source: 'suggested-tasks', projectId, suggestionId, lensId: suggestion.lensId, notify: 'attention' },
        } };
        const created = await sessionService.create(payload, options);
        conversion.sessionId = created.sessionId;
        conversion.directory = created.directory;
      } else if (action === 'issue') {
        const target = (await issueProvidersFor(project)).find((entry) => entry.provider === provider);
        if (!target) throw httpError('This project has no issue tracker for that provider', 400);
        conversion.url = buildIssueUrl(target, { title: suggestion.title, body: `${suggestion.body}\n\n${suggestion.files.map((file) => `- \`${fileLabel(file)}\``).join('\n')}`.trim() });
      } else if (action !== 'draft') {
        throw httpError('Unknown action', 400);
      }

      return await changeSuggestion(projectId, suggestionId, (current) => ({
        ...withoutDecision(current),
        conversionPending: false,
        status: 'approved',
        approvedAt: now(),
        conversion,
      }));
    } catch (error) {
      if (reserved) {
        if (error?.partial && error.sessionId) {
          conversion.sessionId = error.sessionId;
          conversion.directory = error.directory;
        }
        const created = Boolean(conversion?.sessionId || conversion?.todoId || conversion?.itemId);
        await changeSuggestion(projectId, suggestionId, (current) => ({
          ...current,
          status: created ? 'approved' : current.status,
          conversion: created ? conversion : current.conversion,
          conversionPending: !created && !(error?.statusCode >= 400 && error.statusCode < 500),
          conversionRecoverable: !created,
          conversionError: error instanceof Error ? error.message : String(error),
        }));
      }
      throw error;
    } finally {
      converting.delete(key);
    }
  }

  const stopRun = async (projectId, runId) => {
    await findProject(projectId);
    await store.update(projectId, (inbox) => ({ inbox: { ...inbox, runs: inbox.runs.map((run) => run.id === runId ? { ...run, stopRequested: true } : run) } }));
    for (const [sessionId, meta] of watched) {
      if (meta.projectId === projectId && meta.runId === runId) await stopLens(sessionId, 'user');
    }
  };

  // --- lifecycle -------------------------------------------------------------

  const start = () => {
    if (releaseHub) return releaseHub;
    const unsubscribeEvent = globalEventHub.subscribeEvent((event) => {
      for (const payload of event?.translated?.() ?? []) processPayload(payload);
    });
    const unsubscribeStatus = globalEventHub.subscribeStatus((status) => {
      if (status?.type === 'connect') for (const sessionId of watched.keys()) arm(sessionId);
    });
    sweepTimer = setInterval(sweepTimeouts, sweepIntervalMs);
    sweepTimer.unref?.();
    void track(restoreWatches()).catch((error) => logger.warn?.('[suggested-tasks] could not restore running scans:', error?.message ?? error));
    releaseHub = () => {
      unsubscribeEvent();
      unsubscribeStatus();
    };
    return releaseHub;
  };

  const stop = async () => {
    stopped = true;
    releaseHub?.();
    releaseHub = null;
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    if (sweepTimer) clearInterval(sweepTimer);
    await Promise.allSettled([...inFlight]);
  };

  return {
    start,
    stop,
    runScan,
    runNow,
    stopRun,
    getSettings,
    saveConfig,
    setRepoLensEnabled,
    getInbox,
    getSummary,
    dismiss,
    snooze,
    restore,
    approve,
    processPayload,
  };
};
