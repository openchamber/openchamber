// The host's routes of the isolated-spaces journey, `/api/openchamber/spaces`, as the screens call
// them. Every answer is parsed here, once, into the types the screens use; a failure is a thrown
// `SpacesRequestError` with the server's stable code, never an empty answer that would read as
// "no spaces". The contract is `packages/web/server/lib/spaces/DOCUMENTATION.md`, "The journey".

import { z } from 'zod';

import { runtimeFetch } from '@/lib/runtime-fetch';

const SPACES_ROUTE = '/api/openchamber/spaces';

const spaceIdSchema = z.string().regex(/^[0-9a-f]{12}$/);

const failureSchema = z.object({
  code: z.string(),
  message: z.string(),
});

export type SpaceFailure = z.infer<typeof failureSchema>;

// Paths the space reports, at most a hundred of them, with how many there are in all.
const reportedPathsSchema = z.object({ count: z.number().int().min(0), paths: z.array(z.string()) });

export type SpaceReportedPaths = z.infer<typeof reportedPathsSchema>;

// What a refusal names beside its code, where the screen shows it: the file an apply refused
// (`path`, and `other` for a name that differs only in case), the branch in the way, and for a
// refusal that closes the way of uncommitted changes the files it was about. Paths come from the
// space or the user's project, so they are text to show.
const failureDetailsSchema = z.object({
  path: z.string().optional(),
  other: z.string().nullable().optional(),
  branch: z.string().optional(),
  stillThere: reportedPathsSchema.optional(),
  ignoredInTheWay: reportedPathsSchema.optional(),
  filteredInTheWay: reportedPathsSchema.optional(),
});

export type SpaceFailureDetails = z.infer<typeof failureDetailsSchema>;

/** A refusal or failure of a journey route: the server's code, its message, and the HTTP status. */
export class SpacesRequestError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: SpaceFailureDetails;

  constructor(code: string, message: string, status: number, details: SpaceFailureDetails = {}) {
    super(message);
    this.name = 'SpacesRequestError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

const switchSpaceSchema = z.object({ id: spaceIdSchema, name: z.string(), state: z.string() });

// While on, `spaces` is what turning the switch off would stop; null with a failure when the place
// could not be asked, so the screen says the list is unknown instead of hiding the switch.
const switchStateSchema = z.discriminatedUnion('enabled', [
  z.object({ enabled: z.literal(false) }),
  z.object({ enabled: z.literal(true), spaces: z.array(switchSpaceSchema).nullable(), failure: failureSchema.optional() }),
]);

type SpacesSwitchState =
  | { enabled: false }
  | { enabled: true; spaces: z.infer<typeof switchSpaceSchema>[] }
  | { enabled: true; spaces: null; failure: SpaceFailure };

const stillRunningSchema = z.object({ id: spaceIdSchema, name: z.string(), code: z.string(), message: z.string() });

const switchChangeSchema = z.object({
  enabled: z.boolean(),
  stopped: z.array(z.object({ id: spaceIdSchema, name: z.string() })),
  stillRunning: z.array(stillRunningSchema),
  // The place could not list its spaces: the switch went off without knowing what still runs.
  unknown: failureSchema.optional(),
});

export type SpacesSwitchChange = z.infer<typeof switchChangeSchema>;

const networkSchema = z.object({
  mode: z.enum(['allowlist', 'open']),
  domains: z.array(z.string()),
});

export type SpaceNetwork = z.infer<typeof networkSchema>;

const grantSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('model'),
    id: z.string(),
    provider: z.string(),
    upstream: z.string(),
    source: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('typed') }),
      z.object({ kind: z.literal('env'), name: z.string() }),
    ]),
    url: z.string(),
  }),
  z.object({ kind: z.literal('domain'), id: z.string(), upstream: z.string(), url: z.string() }),
]);

export type SpaceGrant = z.infer<typeof grantSchema>;

/** The steps of a creation, in order, as `openchamber:space-progress` announces them. */
const SPACE_CREATION_STEPS = ['checking_place', 'creating', 'setting_network', 'bringing_code', 'ready'] as const;

export type SpaceCreationStep = (typeof SPACE_CREATION_STEPS)[number];

export const spaceCreationStepSchema = z.enum(SPACE_CREATION_STEPS);

// The project's setup commands in the space (5d-4): queued until the code arrived, the command
// running now, how the last run ended, or a run the host did not live to see end. `command` is the
// project's text, to show only. A failed run says when it began and ended, so the output window can
// read the gatekeeper's refusals within; null from a host or a record from before that.
const setupSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('queued'), total: z.number().int().min(1) }),
  z.object({ state: z.literal('running'), index: z.number().int().min(0), total: z.number().int().min(1), command: z.string() }),
  z.object({ state: z.literal('done'), total: z.number().int().min(1) }),
  z.object({ state: z.literal('failed'), index: z.number().int().min(0), total: z.number().int().min(1), command: z.string(), exitCode: z.number().int().nullable(), timedOut: z.boolean(), startedAt: z.string().nullable().default(null), finishedAt: z.string().nullable().default(null) }),
  z.object({ state: z.literal('interrupted'), total: z.number().int().min(1) }),
]);

export type SpaceSetup = z.infer<typeof setupSchema>;

const spaceEntrySchema = z.object({
  id: spaceIdSchema,
  name: z.string(),
  projectDirectory: z.string().nullable(),
  directory: z.string().nullable(),
  state: z.enum(['preparing', 'running', 'exited', 'missing', 'failed']),
  // A stopped space that stopped itself after the idle hours, rather than by a hand or a crash.
  stoppedIdle: z.boolean().default(false),
  step: spaceCreationStepSchema.nullable(),
  failure: failureSchema.nullable(),
  // Null when the host could not read what the user chose: unknown, never "open".
  network: networkSchema.nullable(),
  grants: z.array(grantSchema),
  access: z.enum(['granted', 'needs_access', 'unknown']).nullable(),
  needsAccess: z.array(z.string()),
  // What is broken in a damaged space: `repairable` comes back with a restart of the container,
  // `gatekeeper_gone` never does. Null for a space that is whole.
  damage: z.enum(['repairable', 'gatekeeper_gone']).nullable().default(null),
  // Null before any run of the setup commands, and from a host before 5d-4.
  setup: setupSchema.nullable().default(null),
});

export type SpaceEntry = z.infer<typeof spaceEntrySchema>;

const placeSchema = z.union([
  z.object({ id: z.string(), available: z.literal(true), hostIsolation: z.boolean() }),
  z.object({ id: z.string(), available: z.literal(false), code: z.string(), message: z.string() }),
]);

export type SpacePlace = z.infer<typeof placeSchema>;

export type SpaceStart = 'clean' | 'uncommitted';

export type CreateSpaceRequest = {
  projectDirectory: string;
  name: string;
  start: SpaceStart;
  network: SpaceNetwork;
  /** The project's setup commands, resolved as for a new worktree, trust included. */
  setupCommands: string[];
};

export type GrantRequest =
  | { kind: 'model'; provider: string; upstream: string; secret: { kind: 'typed'; value: string } | { kind: 'env'; name: string } }
  | { kind: 'domain'; upstream: string };

const errorBodySchema = z.object({ code: z.string(), message: z.string(), details: failureDetailsSchema.nullable().optional().catch(null) });

const request = async <T>(path: string, schema: z.ZodType<T>, init: RequestInit = {}): Promise<T> => {
  const response = await runtimeFetch(path, {
    ...init,
    headers: init.body === undefined ? init.headers : { 'Content-Type': 'application/json', ...init.headers },
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = errorBodySchema.safeParse(body);
    throw error.success
      ? new SpacesRequestError(error.data.code, error.data.message, response.status, error.data.details ?? {})
      : new SpacesRequestError('space_request_failed', `The server answered ${response.status}.`, response.status);
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new SpacesRequestError('space_answer_malformed', 'The server answered in a shape this version does not know.', response.status);
  return parsed.data;
};

const toSwitchState = (answer: z.infer<typeof switchStateSchema>): SpacesSwitchState => {
  if (!answer.enabled) return { enabled: false };
  if (answer.spaces !== null) return { enabled: true, spaces: answer.spaces };
  return { enabled: true, spaces: null, failure: answer.failure ?? { code: 'space_journey_failed', message: '' } };
};

export const readSpacesSwitch = async (signal?: AbortSignal): Promise<SpacesSwitchState> =>
  toSwitchState(await request(`${SPACES_ROUTE}/switch`, switchStateSchema, { signal }));

export const setSpacesSwitch = (enabled: boolean): Promise<SpacesSwitchChange> =>
  request(`${SPACES_ROUTE}/switch`, switchChangeSchema, { method: 'PUT', body: JSON.stringify({ enabled }) });

export const listSpacePlaces = async (signal?: AbortSignal): Promise<SpacePlace[]> =>
  (await request(`${SPACES_ROUTE}/places`, z.object({ places: z.array(placeSchema) }), { signal })).places;

export const listSpaces = async (signal?: AbortSignal): Promise<SpaceEntry[]> =>
  (await request(SPACES_ROUTE, z.object({ spaces: z.array(spaceEntrySchema) }), { signal })).spaces;

export const createSpace = (body: CreateSpaceRequest): Promise<SpaceEntry> =>
  request(SPACES_ROUTE, spaceEntrySchema, { method: 'POST', body: JSON.stringify(body) });

export const grantSpaceAccess = async (spaceId: string, body: GrantRequest): Promise<SpaceGrant> =>
  (await request(`${SPACES_ROUTE}/${spaceId}/grants`, z.object({ grant: grantSchema }), { method: 'POST', body: JSON.stringify(body) })).grant;

/** Adds a domain to a running space's allowlist, live; answers the network as it now is. */
export const openSpaceDomain = async (spaceId: string, domain: string): Promise<SpaceNetwork> =>
  (await request(`${SPACES_ROUTE}/${spaceId}/network/domains`, z.object({ network: networkSchema }), { method: 'POST', body: JSON.stringify({ domain }) })).network;

// One attempt the gatekeeper recorded: never a path, a body or a secret. `host` is what the agent
// asked for, so it is data to show, never to act on without the user.
const journalRecordSchema = z.object({
  at: z.string(),
  listener: z.string(),
  host: z.string(),
  port: z.number(),
  decision: z.string(),
});

export type SpaceJournalRecord = z.infer<typeof journalRecordSchema>;

// The gatekeeper's memory since it last started: `since` is when, and `dropped` counts the oldest
// records the ring had no room for.
const journalSchema = z.object({ records: z.array(journalRecordSchema), dropped: z.number(), since: z.string() });

export type SpaceJournal = z.infer<typeof journalSchema>;

export const readSpaceJournal = (spaceId: string, signal?: AbortSignal): Promise<SpaceJournal> =>
  request(`${SPACES_ROUTE}/${spaceId}/journal`, journalSchema, { signal });

// A removal can go through in part: `failures` names what stayed, and the screen says so.
const removalSchema = z.object({ id: spaceIdSchema, removed: z.boolean(), failures: z.array(failureSchema) });

type SpaceRemoval = z.infer<typeof removalSchema>;

/** Starts a stopped space; its network and the grants the host can say again come back with it. */
export const startSpace = (spaceId: string): Promise<SpaceEntry> =>
  request(`${SPACES_ROUTE}/${spaceId}/start`, spaceEntrySchema, { method: 'POST' });

/** Stops a running space and its gatekeeper; its files stay. */
export const stopSpace = (spaceId: string): Promise<SpaceEntry> =>
  request(`${SPACES_ROUTE}/${spaceId}/stop`, spaceEntrySchema, { method: 'POST' });

/** Restarts the container of a running space, with a fresh token for the server inside. */
export const restartSpace = (spaceId: string): Promise<SpaceEntry> =>
  request(`${SPACES_ROUTE}/${spaceId}/restart`, spaceEntrySchema, { method: 'POST' });

/** Restarts OpenCode inside a running space and answers once it is ready again. */
export const restartSpaceOpenCode = (spaceId: string): Promise<SpaceEntry> =>
  request(`${SPACES_ROUTE}/${spaceId}/restart-opencode`, spaceEntrySchema, { method: 'POST' });

// The idle stop (decision 11): on or off, and after how many whole hours with no session working.
export const SPACE_IDLE_STOP_MIN_HOURS = 1;
export const SPACE_IDLE_STOP_MAX_HOURS = 168;

const idleStopSchema = z.object({
  enabled: z.boolean(),
  hours: z.number().int().min(SPACE_IDLE_STOP_MIN_HOURS).max(SPACE_IDLE_STOP_MAX_HOURS),
});

export type SpaceIdleStop = z.infer<typeof idleStopSchema>;

export const readSpaceIdleStop = (signal?: AbortSignal): Promise<SpaceIdleStop> =>
  request(`${SPACES_ROUTE}/idle-stop`, idleStopSchema, { signal });

/** Keeps the setting and tells every running space; answers the setting as kept. */
export const setSpaceIdleStop = (setting: SpaceIdleStop): Promise<SpaceIdleStop> =>
  request(`${SPACES_ROUTE}/idle-stop`, idleStopSchema, { method: 'PUT', body: JSON.stringify(setting) });

/** Runs the setup commands again in a running space; answers once they began. */
export const runSpaceSetup = (spaceId: string, commands: readonly string[]): Promise<SpaceEntry> =>
  request(`${SPACES_ROUTE}/${spaceId}/setup`, spaceEntrySchema, { method: 'POST', body: JSON.stringify({ commands }) });

// The end of the failed command's output: printed by the project's code, so plain text to show.
const setupOutputSchema = z.object({ setup: setupSchema.nullable(), output: z.string().nullable() });

export type SpaceSetupOutput = z.infer<typeof setupOutputSchema>;

export const readSpaceSetup = (spaceId: string, signal?: AbortSignal): Promise<SpaceSetupOutput> =>
  request(`${SPACES_ROUTE}/${spaceId}/setup`, setupOutputSchema, { signal });

export const removeSpace = (spaceId: string): Promise<SpaceRemoval> =>
  request(`${SPACES_ROUTE}/${spaceId}`, removalSchema, { method: 'DELETE' });

// What an apply would do, read while the dialog is open: the work brought out of the space now, and
// where the space stands for an apply as uncommitted changes. `changedPaths` counts against the
// space's start; `newPaths` is what the next apply as changes writes, null when it cannot be told.
const applyPreviewSchema = z.object({
  changedPaths: z.number().int().min(0),
  changedBytes: z.number().min(0),
  nestedRepositories: reportedPathsSchema,
  unmerged: reportedPathsSchema,
  changesRoute: z.enum(['open', 'closed']),
  lastApplied: z.string().nullable(),
  newPaths: z.number().int().min(0).nullable(),
  // Reading the project back ran out of time: an apply as changes would be refused.
  newPathsUndecided: z.boolean().default(false),
});

export type SpaceApplyPreview = z.infer<typeof applyPreviewSchema>;

export type SpaceApplyRequest =
  | { as: 'branch'; branch: string; removeAfterwards: boolean }
  | { as: 'changes'; removeAfterwards: boolean };

const appliedSchema = z.union([
  z.object({ status: z.literal('applied'), branch: z.string() }),
  z.object({ status: z.literal('applied'), appliedPaths: z.number().int().min(0) }),
  z.object({ status: z.literal('nothing_to_apply') }),
]);

// `removal` is null unless the space was removed after the apply went through.
const applyOutcomeSchema = z.object({ applied: appliedSchema, removal: removalSchema.nullable() });

export type SpaceApplyOutcome = z.infer<typeof applyOutcomeSchema>;

/** Brings the space's work out and says what an apply would do; writes nothing of the user's files. */
export const previewSpaceApply = (spaceId: string, signal?: AbortSignal): Promise<SpaceApplyPreview> =>
  request(`${SPACES_ROUTE}/${spaceId}/apply`, applyPreviewSchema, { signal });

/** Brings the work out once more and applies it; what is applied is what this call brought. */
export const applySpaceWork = (spaceId: string, body: SpaceApplyRequest): Promise<SpaceApplyOutcome> =>
  request(`${SPACES_ROUTE}/${spaceId}/apply`, applyOutcomeSchema, { method: 'POST', body: JSON.stringify(body) });
