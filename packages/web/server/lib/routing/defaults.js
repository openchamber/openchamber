/**
 * Built-in routing configuration. Everything here is the shipped default; the
 * user's `routing.json` stores only deviations from it, so a later change to a
 * built-in category reaches everyone who did not edit that category.
 *
 * Category descriptions are what Jev reads, verbatim, as the criteria of one
 * choice question. Keep them about the reasoning a request demands, never about
 * the length of the reply: that wording moved a long mechanical rename from
 * "hard" to "trivial" in the lab runs.
 */

import { z } from 'zod';

const AUTO_PROVIDER_ID = 'openchamber';
const AUTO_MODEL_ID = 'auto';

// v2 names a model `{ providerID, id }` (`Model.Ref`); OpenChamber's own stored
// config and the message queue's send config name it `{ providerID, modelID }`.
const autoModelSchema = z.object({ providerID: z.literal(AUTO_PROVIDER_ID), id: z.literal(AUTO_MODEL_ID) });
const autoStoredModelSchema = z.object({ providerID: z.literal(AUTO_PROVIDER_ID), modelID: z.literal(AUTO_MODEL_ID) });

export const isAutoModel = (model) => autoModelSchema.safeParse(model).success
  || autoStoredModelSchema.safeParse(model).success;

/** The sentinel itself, in the v2 `Model.Ref` shape. */
export const AUTO_MODEL_REF = { providerID: AUTO_PROVIDER_ID, id: AUTO_MODEL_ID };

/** The user's own TypeSafe key: their quota, their account, the `jev-latest` alias. */
export const JEV_API_URL = 'https://api.typesafe.ai/v1/systemone';
export const JEV_MODEL = 'jev-latest';

/**
 * OpenCode Zen serves the same System One endpoint and answers without any
 * credential while `jev-1.13-free` is free. Dax approved OpenChamber using it
 * (Slack, 2026-09-22) on terms this module keeps: the UI tells the user it is a
 * limited-time free model that will later need a Zen key, and every call names
 * OpenChamber so zen can see or throttle us. Zen rejects the `jev-latest`
 * alias, so the versioned free id is sent instead.
 */
export const ZEN_JEV_API_URL = 'https://opencode.ai/zen/v1/systemone';
export const ZEN_JEV_MODEL = 'jev-1.13-free';
export const ZEN_CLIENT_ID = 'openchamber';

/** Per-attempt timeout; the lab measured 250–700 ms warm, ~1 s on a cold TLS handshake. */
export const JEV_TIMEOUT_MS = 4000;

/**
 * The third line keeps a hard turn from dragging its follow-ups up. With a
 * plain "classify request only" wording, "дякую, все працює" after a hard fix
 * came back hard at ~40% and "запуш" trivial at ~50%, both under the threshold,
 * so the fallback model took them. Saying that history only resolves what the
 * request refers to, and that finished work carries no weight, put them at
 * 97% and ~75% trivial while "ok, do it" after a plan stayed implement and a
 * regression report stayed hard (jev-router lab, test/follow-up-instructions.js).
 */
export const ROUTING_INSTRUCTIONS = [
  'Pick the task category that best describes this coding request, judging the reasoning it demands rather than the length of the reply it asks for.',
  'A request that wants a one-line answer to a hard debugging or design question is still hard; a long but mechanical edit is still trivial.',
  'The thing to classify is `request`, the latest user message. Read `history` (earlier conversation, oldest first) only to understand what `request` refers to, then judge the reasoning `request` itself demands. Do not let the difficulty of work already done in `history` raise or lower the category.',
];

/**
 * Measured on 31 mixed bash/edit/mcp/webfetch permissions: this "should the agent
 * ask" wording scored 28/31 at threshold 0.6 with every miss on the safe side,
 * while "is it destructive" scored 23/31 and let through `brew install`, closing
 * a PR, and edits to ~/.zshrc and ~/.ssh.
 */
export const SAFETY_INSTRUCTIONS = [
  'An autonomous coding agent is about to perform this action inside a software project, and the user has allowed routine actions to proceed without asking.',
  'Should the agent stop and ask the user first, instead of proceeding automatically?',
  'Yes when the action is hard to undo, or reaches outside the project working tree (the system, the home directory, remote services, other people), or changes shared state others can see, or discards uncommitted work.',
  "No for reading, searching, building, testing, installing project dependencies, ordinary commits, pushes and rebases of the agent's own branch, and file edits inside the project.",
];

/** Effect kinds reported alongside the hold decision; the UI shows the chosen one as the reason. */
export const SAFETY_KINDS = {
  read_only: 'Reads, lists, searches, builds, tests, or fetches public information; changes nothing.',
  writes_project: 'Creates or edits files inside the project in a way version control can undo.',
  git_history: 'Rewrites, deletes, or force-pushes git history or branches, or discards uncommitted work.',
  deletes_data: 'Deletes files or data outside version control, drops databases, or wipes directories.',
  system_change: 'Installs, removes, or reconfigures software, services, or system settings.',
  external_side_effect: 'Changes state in an external system: posts, sends, deploys, pays, closes, or deletes something remotely.',
  data_exfiltration: 'Sends local files, secrets, or private data to an external host, or fetches and executes remote code.',
};

/** History excerpts: a user message keeps its head, an answer keeps head and tail. */
export const HISTORY_LIMITS = { turns: 3, user: 600, answerHead: 300, answerTail: 300 };

export const THINKING_LEVELS = ['off', 'low', 'medium', 'high'];

export const BUILTIN_CATEGORIES = [
  {
    id: 'trivial',
    name: 'Trivial',
    description: 'Trivial, mechanical, or purely factual work: rename a symbol, fix a typo, reformat, add a comment, answer a short factual question about a known file, run one obvious command and report the output. Not for anything requiring design judgement or multi-file reasoning.',
  },
  {
    id: 'research',
    name: 'Research',
    description: 'Read and explain existing code or behaviour without changing it: explain how a module works, find where something is implemented, summarise what a change does. Not for requests that ask for edits or a plan.',
  },
  {
    id: 'implement',
    name: 'Implement',
    description: 'Ordinary engineering with a clear, bounded shape: implement a well-specified function, endpoint, or component; write or fix tests for existing behaviour; a localised bug fix where the cause is already understood. Not for open-ended architecture, subtle concurrency, or unknown-cause debugging.',
  },
  {
    id: 'hard',
    name: 'Hard',
    description: 'Hard reasoning, ambiguity, planning, or high blast radius: debug a failure whose cause is unknown, plan or design a change across several modules, security, auth, concurrency, data-migration, or money-handling logic. Not for work a competent mid-level engineer would finish without thinking hard.',
  },
];

export const DEFAULT_MIN_CONFIDENCE = 0.6;
export const DEFAULT_SAFETY_THRESHOLD = 0.6;
