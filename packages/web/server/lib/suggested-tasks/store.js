// The inbox of one project: its suggestions, the history of its scans, and
// where the last complete scan of each branch stopped.
//
// `<projectsDir>/<project stem>/suggested-tasks.json`, beside the project's
// notes and memory. Every change is a read-modify-write under a cross-process
// lock, because a desktop app and a CLI `serve` can share the projects dir and
// both watch the same scan sessions.

import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { projectConfigFileStemOf } from '../projects/project-id.js';
import { withSourceControlFileLock } from '../source-control/file-lock.js';
import { LENS_ACTIONS, LEVELS, SEVERITIES } from './config.js';
import { evidenceSchema } from './scan-prompt.js';

const FILE_NAME = 'suggested-tasks.json';
const FILE_VERSION = 1;
const LOCK_WAIT_MS = 10_000;

const MAX_CLOSED = 200;
const MAX_RUNS = 30;

const time = z.number().finite().nonnegative();

const fileSchema = z.object({
  path: z.string().min(1),
  startLine: z.number().int().min(1).optional(),
  endLine: z.number().int().min(1).optional(),
});

const conversionSchema = z.object({
  kind: z.enum(['session', 'worktree', 'draft-pr', 'todo', 'issue', 'draft', 'bot']),
  auto: z.boolean().optional(),
  sessionId: z.string().min(1).optional(),
  directory: z.string().min(1).optional(),
  todoId: z.string().min(1).optional(),
  botId: z.string().min(1).optional(),
  itemId: z.string().min(1).optional(),
  url: z.string().min(1).optional(),
});

const suggestionSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  lensId: z.string().min(1),
  lensName: z.string().min(1),
  title: z.string().min(1),
  body: z.string(),
  evidence: evidenceSchema.optional(),
  files: z.array(fileSchema),
  confidence: z.enum(LEVELS),
  severity: z.enum(SEVERITIES),
  createdAt: time,
  status: z.enum(['open', 'snoozed', 'dismissed', 'approved']),
  snoozedUntil: time.optional(),
  dismissedAt: time.optional(),
  dismissReason: z.string().optional(),
  approvedAt: time.optional(),
  conversion: conversionSchema.optional(),
  conversionError: z.string().optional(),
  conversionPending: z.boolean().optional(),
  conversionRecoverable: z.boolean().optional(),
  conversionOwnerPid: z.number().int().positive().optional(),
  conversionOwnerHost: z.string().optional(),
});

const lensRunSchema = z.object({
  lensId: z.string().min(1),
  lensName: z.string().min(1),
  action: z.enum(LENS_ACTIONS),
  status: z.enum(['pending', 'running', 'done', 'failed', 'stopped']),
  startedAt: time,
  finishedAt: time.optional(),
  sessionId: z.string().min(1).optional(),
  directory: z.string().min(1).optional(),
  dispatch: z.enum(['created', 'sending', 'sent', 'uncertain']).optional(),
  error: z.string().optional(),
  reported: z.number().int().nonnegative().default(0),
  added: z.number().int().nonnegative().default(0),
  dropped: z.object({
    outOfScope: z.number().int().nonnegative(),
    belowMinimum: z.number().int().nonnegative(),
    duplicate: z.number().int().nonnegative(),
    overLimit: z.number().int().nonnegative(),
    invalid: z.number().int().nonnegative(),
  }).optional(),
  tokens: z.number().int().nonnegative().default(0),
  stopReason: z.enum(['budget', 'timeout', 'user']).optional(),
});

const runSchema = z.object({
  id: z.string().min(1),
  reason: z.enum(['manual', 'scheduled']),
  startedAt: time,
  finishedAt: time.optional(),
  status: z.enum(['running', 'done', 'partial', 'failed', 'skipped']),
  // Why a run that started nothing did not: quiet hours, nothing changed...
  skipped: z.enum(['quiet-hours', 'no-changes', 'no-lenses', 'disabled']).optional(),
  error: z.string().optional(),
  branch: z.string().optional(),
  commit: z.string().optional(),
  // A temporary worktree of `branch`, removed when every lens has finished.
  worktree: z.string().optional(),
  changedFiles: z.number().int().nonnegative().optional(),
  tokenBudget: z.number().int().positive().optional(),
  maxSuggestions: z.number().int().positive(),
  ownerPid: z.number().int().positive().optional(),
  ownerHost: z.string().optional(),
  finalized: z.boolean().optional(),
  stopRequested: z.boolean().optional(),
  openIssues: z.array(z.string()).optional(),
  warnings: z.array(z.string()).optional(),
  scope: z.object({ include: z.array(z.string()), exclude: z.array(z.string()), baseBranch: z.string(), incremental: z.boolean() }).optional(),
  limits: z.object({ maxSuggestions: z.number(), tokenBudget: z.number().nullable(), minConfidence: z.enum(LEVELS), minSeverity: z.enum(SEVERITIES) }).optional(),
  lenses: z.array(lensRunSchema),
});

const storedFileSchema = z.object({
  version: z.literal(FILE_VERSION),
  suggestions: z.array(z.unknown()),
  runs: z.array(z.unknown()),
  lastScanned: z.record(z.string(), z.string()).default({}),
});

const errorCodeSchema = z.object({ code: z.string() });

const emptyInbox = () => ({ suggestions: [], runs: [], lastScanned: {} });

/** Keeps the file bounded: the newest open items, the newest closed ones, the newest runs. */
const trimInbox = (inbox) => {
  const newestFirst = (left, right) => right.createdAt - left.createdAt;
  const pending = inbox.suggestions.filter((entry) => entry.status === 'open' || entry.status === 'snoozed').sort(newestFirst);
  const closed = inbox.suggestions.filter((entry) => entry.status === 'dismissed' || entry.status === 'approved').sort(newestFirst);
  return {
    ...inbox,
    suggestions: [...pending, ...closed.slice(0, MAX_CLOSED)],
    runs: [...inbox.runs.filter((run) => run.status === 'running'), ...inbox.runs.filter((run) => run.status !== 'running').sort((left, right) => right.startedAt - left.startedAt).slice(0, MAX_RUNS)],
  };
};

export const createSuggestionStore = ({ projectsDirPath }) => {
  const projectIdSchema = z.string().regex(/^[a-zA-Z0-9_-][a-zA-Z0-9._:-]*$/);
  const filePathFor = (projectId) => path.join(projectsDirPath, projectConfigFileStemOf(projectIdSchema.parse(projectId)), FILE_NAME);

  /**
   * The inbox on disk. A missing file is an empty inbox; a file that is not
   * JSON or not an inbox throws, so it is never taken for "no suggestions"
   * and never overwritten. One unreadable entry is dropped alone.
   */
  const read = async (projectId) => {
    let raw;
    try {
      raw = await fs.promises.readFile(filePathFor(projectId), 'utf8');
    } catch (error) {
      if (errorCodeSchema.safeParse(error).data?.code === 'ENOENT') return emptyInbox();
      throw error;
    }
    let json;
    try {
      json = JSON.parse(raw);
    } catch {
      throw Object.assign(new Error(`${FILE_NAME} is not valid JSON`), { statusCode: 500 });
    }
    const stored = storedFileSchema.safeParse(json);
    if (!stored.success) throw Object.assign(new Error(`${FILE_NAME} is not a suggestions inbox`), { statusCode: 500 });
    return {
      suggestions: stored.data.suggestions.map((entry) => suggestionSchema.safeParse(entry).data).filter(Boolean),
      runs: stored.data.runs.map((entry) => runSchema.safeParse(entry).data).filter(Boolean),
      lastScanned: stored.data.lastScanned,
    };
  };

  const write = async (projectId, inbox) => {
    const filePath = filePathFor(projectId);
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    try {
      await fs.promises.writeFile(temporaryPath, JSON.stringify({ version: FILE_VERSION, ...inbox }, null, 2), { encoding: 'utf8', mode: 0o600 });
      await fs.promises.rename(temporaryPath, filePath);
    } catch (error) {
      await fs.promises.rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  };

  /**
   * Runs `change(inbox)` on the current inbox under the lock and writes what
   * it returns as `inbox`. `change` may return `{ inbox, result }`; without an
   * `inbox` nothing is written. Resolves to `result`.
   */
  const update = async (projectId, change) => {
    const filePath = filePathFor(projectId);
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    return withSourceControlFileLock(`${filePath}.lock`, async () => {
      const current = await read(projectId);
      const outcome = await change(current);
      if (outcome.inbox) await write(projectId, trimInbox(outcome.inbox));
      return outcome.result;
    }, { waitMs: LOCK_WAIT_MS });
  };

  return { read, update, filePathFor };
};
