
import { z } from 'zod';

const AUTO_PROVIDER_ID = 'openchamber';
const AUTO_MODEL_ID = 'auto';

const autoModelSchema = z.object({ providerID: z.literal(AUTO_PROVIDER_ID), id: z.literal(AUTO_MODEL_ID) });
const autoStoredModelSchema = z.object({ providerID: z.literal(AUTO_PROVIDER_ID), modelID: z.literal(AUTO_MODEL_ID) });

export const isAutoModel = (model: unknown): model is z.infer<typeof autoModelSchema> | z.infer<typeof autoStoredModelSchema> => autoModelSchema.safeParse(model).success
  || autoStoredModelSchema.safeParse(model).success;

export const AUTO_MODEL_REF = { providerID: AUTO_PROVIDER_ID, id: AUTO_MODEL_ID };

export const JEV_API_URL = 'https://api.typesafe.ai/v1/systemone';
export const JEV_MODEL = 'jev-latest';

export const ZEN_JEV_API_URL = 'https://opencode.ai/zen/v1/systemone';
export const ZEN_JEV_MODEL = 'jev-1.13-free';
export const ZEN_CLIENT_ID = 'openchamber';

export const ZEN_JEV_PROMOTION_ACTIVE = true;

export const ZEN_JEV_PAID_MODEL = 'jev-1.13';

export const OPENROUTER_JEV_API_URL = 'https://openrouter.ai/api/v1/systemone';
export const OPENROUTER_JEV_MODEL = 'jev-latest';
export const VERCEL_JEV_API_URL = 'https://ai-gateway.vercel.sh/typesafe/v1/systemone';
export const VERCEL_JEV_MODEL = 'typesafe-ai/jev';

export const GEMINI_DECISIONS_API_URL = 'https://generativelanguage.googleapis.com/v1beta/decisions';
export const GEMINI_DECISIONS_MODEL = 'gemini-decision-1';

export const JEV_TIMEOUT_MS = 4000;

export const JEV_BACKGROUND_TIMEOUT_MS = 15_000;

export const JEV_LINGER_MS = 5 * 60_000;

export const ROUTING_INSTRUCTIONS = [
  'Pick the task category that best describes this coding request, judging the reasoning it demands rather than the length of the reply it asks for.',
  'A request that wants a one-line answer to a hard debugging or design question is still hard; a long but mechanical edit is still trivial.',
  'The thing to classify is `request`, the latest user message. Read `history` (earlier conversation, oldest first) only to understand what `request` refers to, then judge the reasoning `request` itself demands. Do not let the difficulty of work already done in `history` raise or lower the category.',
  'A bare approval such as "go", "yes", "approve", or "do it" authorises the work just described in history: classify it as the category that work demands, not as trivial.',
].join('\n');

export const SAFETY_INSTRUCTIONS = [
  'An autonomous coding agent is about to perform this action inside a software project, and the user has allowed routine actions to proceed without asking.',
  'Should the agent stop and ask the user first, instead of proceeding automatically?',
].join('\n');

export const SAFETY_CRITERIA = {
  true: 'The action is hard to undo, or reaches outside the project working tree (global packages, the system, the home directory, remote services, other people), or changes shared state others can see (closing, cancelling or deleting issues, pull requests or tickets), or discards work (git checkout --, git restore, git reset --hard, deleting a branch).',
  false: "Reading, searching, building, testing, installing project dependencies, ordinary commits, pushes and rebases of the agent's own branch, and file edits inside the project.",
};

export const SAFETY_KINDS = {
  read_only: 'Reads, lists, searches, builds, tests, or fetches public information; changes nothing.',
  writes_project: 'Creates or edits files inside the project in a way version control can undo.',
  git_history: 'Rewrites, deletes, or force-pushes git history or branches, or discards uncommitted work.',
  deletes_data: 'Deletes files or data outside version control, drops databases, or wipes directories.',
  system_change: 'Installs, removes, or reconfigures software, services, or system settings.',
  external_side_effect: 'Changes state in an external system: posts, sends, deploys, pays, closes, or deletes something remotely.',
  data_exfiltration: 'Sends local files, secrets, or private data to an external host, or fetches and executes remote code.',
};

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
export const DEFAULT_PRESERVE_CACHE = true;
export const DEFAULT_SAFETY_THRESHOLD = 0.6;
