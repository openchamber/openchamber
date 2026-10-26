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
  // `chats_not_saved`: the titles of chats too large to save, and how many others failed. Titles
  // come from the space, so they are text to show.
  tooLarge: z.array(z.string()).optional(),
  failed: z.number().int().min(0).optional(),
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
  // The host's own browser login for a provider (7a): the record names the login's method and
  // never a token, and the id is the provider's, so a login and a key replace each other.
  z.object({ kind: z.literal('login'), id: z.string(), provider: z.string(), method: z.string(), url: z.string() }),
  // A provider of the user's own from Settings: the host reads its address, key and models again at every start.
  z.object({ kind: z.literal('custom'), id: z.string(), provider: z.string(), url: z.string() }),
  z.object({ kind: z.literal('domain'), id: z.string(), upstream: z.string(), url: z.string() }),
]);

export type SpaceGrant = z.infer<typeof grantSchema>;

/** The grant that gives a space a provider: a key or the host's login, under the provider's id. */
export const providerGrantOf = (grants: readonly SpaceGrant[], providerId: string): Extract<SpaceGrant, { kind: 'model' | 'login' | 'custom' }> | undefined =>
  grants.find((grant): grant is Extract<SpaceGrant, { kind: 'model' | 'login' | 'custom' }> => (grant.kind === 'model' || grant.kind === 'login' || grant.kind === 'custom') && grant.provider === providerId);

/** The steps of a creation, in order, as `openchamber:space-progress` announces them. */
// `downloading_image` and `preparing_tools` come inside `creating`, only when the place does that slow
// part now, and `creating` follows them again.
const SPACE_CREATION_STEPS = ['checking_place', 'creating', 'downloading_image', 'preparing_tools', 'setting_network', 'bringing_code', 'giving_access', 'ready'] as const;

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
  // The place the space lives on, as the host names it; the browser panel's container mark says it.
  placeId: z.string(),
  // The machine of a Docker over SSH place, as the user wrote it; null for this computer, and
  // for a place the host no longer has.
  machine: z.string().nullable().default(null),
  projectDirectory: z.string().nullable(),
  directory: z.string().nullable(),
  // The folder the space was made for, on the host, which a space whose project is no longer
  // registered still names; `found` is whether it is there now, null when not looked at. A host
  // before 5e-3 names none.
  projectFolder: z.object({ path: z.string().nullable(), found: z.boolean().nullable() }).default({ path: null, found: null }),
  // `unreachable`: the space is on a place that cannot be asked right now, the machine of a
  // Docker over SSH place being off among the reasons; the host lists it from its own record,
  // with the place's failure in `failure`: `place_not_found` when the machine left Settings.
  state: z.enum(['preparing', 'running', 'exited', 'missing', 'failed', 'unreachable']),
  // A stopped space that stopped itself after the idle hours, rather than by a hand or a crash.
  stoppedIdle: z.boolean().default(false),
  // The step a creation is at, or `failed` for a creation that failed, in this process or in one
  // that did not live to finish it; `failure` then says why. Null for a space that is made.
  step: z.union([spaceCreationStepSchema, z.literal('failed')]).nullable(),
  failure: failureSchema.nullable(),
  // Null when the host could not read what the user chose: unknown, never "open".
  network: networkSchema.nullable(),
  grants: z.array(grantSchema),
  access: z.enum(['granted', 'needs_access', 'unknown']).nullable(),
  needsAccess: z.array(z.string()),
  // The model access the creation carried and the host could not give, with the reason; gone once
  // a grant for the provider succeeds. Empty from a host before the creation carried its access.
  accessFailures: z.array(z.object({ provider: z.string(), code: z.string(), message: z.string() })).default([]),
  // What is broken in a damaged space: `repairable` comes back with a restart of the container,
  // `gatekeeper_gone` never does. Null for a space that is whole.
  damage: z.enum(['repairable', 'gatekeeper_gone']).nullable().default(null),
  // Null before any run of the setup commands, and from a host before 5d-4.
  setup: setupSchema.nullable().default(null),
});

export type SpaceEntry = z.infer<typeof spaceEntrySchema>;

// `machine` is the SSH destination of the Docker over SSH place, as the user wrote it; null for this computer.
/** The actions that get Docker going on this computer, see `places/docker-setup.js` on the server. */
const DOCKER_SETUP_ACTIONS = ['install_all', 'install_cli', 'start_colima', 'start_desktop'] as const;
export type DockerSetupAction = typeof DOCKER_SETUP_ACTIONS[number];

// What gets Docker going on this computer: one action, or a step the user takes themselves.
const DOCKER_REMEDIES = [...DOCKER_SETUP_ACTIONS, 'get_brew', 'linux_install', 'linux_start', 'permission', 'windows_install', 'windows_start'] as const;
export type DockerRemedy = typeof DOCKER_REMEDIES[number];

// The action under way, or the last one that failed with the end of its command's output.
const dockerSetupJobSchema = z.object({
  action: z.enum(DOCKER_SETUP_ACTIONS),
  running: z.boolean(),
  failure: failureSchema.extend({ output: z.string().default('') }).nullable(),
});

export type DockerSetupJob = z.infer<typeof dockerSetupJobSchema>;

// This computer's place only: what gets Docker going, and how much memory Docker has while it answers.
const dockerSetupSchema = z.object({
  // A remedy a later host knows and this window does not reads as none: the place's own text stays.
  remedy: z.enum(DOCKER_REMEDIES).nullable().catch(null),
  job: dockerSetupJobSchema.nullable(),
  memory: z.object({ bytes: z.number().min(0), engine: z.enum(['colima', 'docker_desktop', 'other']).catch('other'), low: z.boolean() }).nullable(),
}).nullable().default(null);

const placeSchema = z.union([
  z.object({ id: z.string(), machine: z.string().nullable().default(null), available: z.literal(true), hostIsolation: z.boolean(), version: z.string().default(''), setup: dockerSetupSchema }),
  z.object({ id: z.string(), machine: z.string().nullable().default(null), available: z.literal(false), code: z.string(), message: z.string(), setup: dockerSetupSchema }),
]);

export type SpacePlace = z.infer<typeof placeSchema>;

/** The id of the Docker over SSH place, the one place a machine can be set for. */
export const SSH_PLACE_ID = 'docker-ssh';

export type SpaceStart = 'clean' | 'uncommitted';

export type CreateSpaceRequest = {
  projectDirectory: string;
  name: string;
  /** The place to make the space on; the host takes its first place without it. */
  placeId: string;
  start: SpaceStart;
  network: SpaceNetwork;
  /** The project's setup commands, resolved as for a new worktree, trust included. */
  setupCommands: string[];
  /** The model access chosen in the dialog; the host gives it before the space is ready. */
  grants: Extract<GrantRequest, { kind: 'model' | 'login' | 'custom' }>[];
};

export type GrantRequest =
  | { kind: 'model'; provider: string; upstream: string; secret: { kind: 'typed'; value: string } | { kind: 'env'; name: string } }
  | { kind: 'login'; provider: string }
  | { kind: 'custom'; provider: string }
  | { kind: 'domain'; upstream: string };

// A browser login of the host's a space can be given (7c), never its token: `usable` can be said
// to a space now, `expired` has run out and the host could not renew it, `unsupported` was made in
// a way the host cannot forward. `expires` is null for a token that has no end, Copilot's (7d).
const hostLoginSchema = z.object({
  provider: z.string(),
  method: z.string(),
  expires: z.string().nullable(),
  state: z.enum(['usable', 'expired', 'unsupported']),
});

export type SpaceHostLogin = z.infer<typeof hostLoginSchema>;

// A provider the user defined in Settings → Providers, as a space can be given it: never a key.
// `hasKey` says whether the host has one to give, `loopback` whether its address names the machine
// the space runs on, and `supported` whether the gatekeeper can carry its SDK's key.
const customProviderSchema = z.object({
  id: z.string(),
  name: z.string(),
  package: z.string(),
  baseURL: z.string().nullable(),
  loopback: z.boolean(),
  models: z.array(z.string()),
  hasKey: z.boolean(),
  supported: z.boolean(),
});

export type SpaceCustomProvider = z.infer<typeof customProviderSchema>;

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

/**
 * Sets the machine of the Docker over SSH place, the empty string taking the place away, and
 * answers that place checked, or null. The host refuses with `place_has_spaces` while spaces
 * are on the machine, and with `invalid_machine` for anything but `[user@]host[:port]`.
 */
export const setSpaceMachine = async (machine: string): Promise<SpacePlace | null> =>
  (await request(`${SPACES_ROUTE}/machine`, z.object({ place: placeSchema.nullable() }), { method: 'PUT', body: JSON.stringify({ machine }) })).place;

// The disk a place's spaces take, in bytes: the image (null when it is not there), the tools and
// the spaces' own volumes, and what a clean-up would free now, the image among it or not.
const spaceDiskSchema = z.object({
  imageBytes: z.number().min(0).nullable(),
  // A download of the image under way on the host, and how the last one ended while the image is absent.
  imagePulling: z.boolean().default(false),
  imageFailure: failureSchema.nullable().default(null),
  toolsBytes: z.number().min(0),
  spacesBytes: z.number().min(0),
  freeBytes: z.number().min(0),
  freesImage: z.boolean(),
});

export type SpaceDisk = z.infer<typeof spaceDiskSchema>;

// What a clean-up freed, and what Docker kept because something uses it or the removal failed.
const spaceCleanUpSchema = z.object({
  freedBytes: z.number().min(0),
  kept: z.array(z.object({ kind: z.string(), reason: z.enum(['in_use', 'failed']) })),
  disk: spaceDiskSchema,
});

export type SpaceCleanUp = z.infer<typeof spaceCleanUpSchema>;

export const readSpaceDisk = (placeId: string, signal?: AbortSignal): Promise<SpaceDisk> =>
  request(`${SPACES_ROUTE}/places/${encodeURIComponent(placeId)}/disk`, spaceDiskSchema, { signal });

/** Removes what OpenChamber can make again on the place; Docker keeps whatever is in use. */
export const cleanUpSpaceDisk = (placeId: string): Promise<SpaceCleanUp> =>
  request(`${SPACES_ROUTE}/places/${encodeURIComponent(placeId)}/clean-up`, spaceCleanUpSchema, { method: 'POST' });

/** Starts the download of the image ahead of the first space; answers the disk with `imagePulling` set. */
/** The Docker setup action under way on this computer, or the last one that failed; null for none. */
export const readDockerSetupJob = async (signal?: AbortSignal): Promise<DockerSetupJob | null> =>
  (await request(`${SPACES_ROUTE}/places/local/setup`, z.object({ job: dockerSetupJobSchema.nullable() }), { signal })).job;

/**
 * Starts `action` on this computer and answers at once; the host refuses one its Docker no longer
 * needs with `docker_setup_not_offered`, and a second one with `docker_setup_running`.
 */
export const startDockerSetup = async (action: DockerSetupAction): Promise<DockerSetupJob | null> =>
  (await request(`${SPACES_ROUTE}/places/local/setup`, z.object({ job: dockerSetupJobSchema.nullable() }), { method: 'POST', body: JSON.stringify({ action }) })).job;

export const pullSpaceImage = (placeId: string): Promise<SpaceDisk> =>
  request(`${SPACES_ROUTE}/places/${encodeURIComponent(placeId)}/image`, spaceDiskSchema, { method: 'POST' });

export const listSpaces = async (signal?: AbortSignal): Promise<SpaceEntry[]> =>
  (await request(SPACES_ROUTE, z.object({ spaces: z.array(spaceEntrySchema) }), { signal })).spaces;

export const createSpace = (body: CreateSpaceRequest): Promise<SpaceEntry> =>
  request(SPACES_ROUTE, spaceEntrySchema, { method: 'POST', body: JSON.stringify(body) });

/** The host's browser logins a space can be given, by provider; a host that cannot be asked throws. */
export const readSpaceHostLogins = async (signal?: AbortSignal): Promise<SpaceHostLogin[]> =>
  (await request(`${SPACES_ROUTE}/logins`, z.object({ logins: z.array(hostLoginSchema) }), { signal })).logins;

/** The providers of the user's own a space of this project can be given, read from the host's configuration; a host that cannot be asked throws. */
export const readSpaceCustomProviders = async (projectDirectory: string, signal?: AbortSignal): Promise<SpaceCustomProvider[]> =>
  (await request(`${SPACES_ROUTE}/custom-providers?directory=${encodeURIComponent(projectDirectory)}`, z.object({ providers: z.array(customProviderSchema) }), { signal })).providers;

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

// What went to the Archive page when a space was deleted: how many chats were saved. Null for a
// space whose making failed, which has none, and from a host before 5e-2.
const savedChatsSchema = z.object({ saved: z.number().int().min(0) });

// A removal can go through in part: `failures` names what stayed, and the screen says so.
const removalSchema = z.object({
  id: spaceIdSchema,
  removed: z.boolean(),
  failures: z.array(failureSchema),
  chats: savedChatsSchema.nullable().default(null),
});

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

/**
 * Deletes a space after its chats went to the Archive page. When they cannot all be saved the
 * space stays and the answer is `chats_not_saved`; `deleteUnsavedChats` is the user's "Delete
 * anyway", which saves what can be and deletes the space.
 */
export const removeSpace = (spaceId: string, { deleteUnsavedChats = false }: { deleteUnsavedChats?: boolean } = {}): Promise<SpaceRemoval> =>
  request(`${SPACES_ROUTE}/${spaceId}${deleteUnsavedChats ? '?unsavedChats=delete' : ''}`, removalSchema, { method: 'DELETE' });

// A deleted space whose chats are on the Archive page: the directory that holds them names it.
const archiveSchema = z.object({ spaceId: spaceIdSchema, name: z.string(), directory: z.string() });

export type SpaceArchive = z.infer<typeof archiveSchema>;

/** The archives of deleted spaces. It reads a file of the host's and runs nothing of the feature. */
export const listSpaceArchives = async (signal?: AbortSignal): Promise<SpaceArchive[]> =>
  (await request(`${SPACES_ROUTE}/archives`, z.object({ archives: z.array(archiveSchema) }), { signal })).archives;

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

// `removal` is null unless the space was removed after the apply went through; `kept` says why a
// space asked to be deleted afterwards stayed: its chats could not all be saved.
const applyOutcomeSchema = z.object({
  applied: appliedSchema,
  removal: removalSchema.nullable(),
  kept: failureSchema.nullable().default(null),
});

export type SpaceApplyOutcome = z.infer<typeof applyOutcomeSchema>;

/** Brings the space's work out and says what an apply would do; writes nothing of the user's files. */
export const previewSpaceApply = (spaceId: string, signal?: AbortSignal): Promise<SpaceApplyPreview> =>
  request(`${SPACES_ROUTE}/${spaceId}/apply`, applyPreviewSchema, { signal });

/** Brings the work out once more and applies it; what is applied is what this call brought. */
export const applySpaceWork = (spaceId: string, body: SpaceApplyRequest): Promise<SpaceApplyOutcome> =>
  request(`${SPACES_ROUTE}/${spaceId}/apply`, applyOutcomeSchema, { method: 'POST', body: JSON.stringify(body) });
