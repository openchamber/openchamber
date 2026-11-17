
import { z } from 'zod';

import { runtimeFetch } from '@/lib/runtime-fetch';

const SPACES_ROUTE = '/api/openchamber/spaces';

const spaceIdSchema = z.string().regex(/^[0-9a-f]{12}$/);
export const spaceTaskTitleSchema = z.object({ title: z.string().min(1).max(120), by: z.enum(['user', 'agent']) });
export type SpaceTaskTitle = z.infer<typeof spaceTaskTitleSchema>;

const failureSchema = z.object({
  code: z.string(),
  message: z.string(),
});

export type SpaceFailure = z.infer<typeof failureSchema>;

const reportedPathsSchema = z.object({ count: z.number().int().min(0), paths: z.array(z.string()) });

export type SpaceReportedPaths = z.infer<typeof reportedPathsSchema>;

const failureDetailsSchema = z.object({
  path: z.string().optional(),
  other: z.string().nullable().optional(),
  branch: z.string().optional(),
  stillThere: reportedPathsSchema.optional(),
  ignoredInTheWay: reportedPathsSchema.optional(),
  filteredInTheWay: reportedPathsSchema.optional(),
  tooLarge: z.array(z.string()).optional(),
  failed: z.number().int().min(0).optional(),
});

export type SpaceFailureDetails = z.infer<typeof failureDetailsSchema>;

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
      z.object({ kind: z.literal('stored'), integration: z.string() }),
    ]),
    url: z.string(),
  }),
  z.object({ kind: z.literal('login'), id: z.string(), provider: z.string(), method: z.string(), url: z.string() }),
  z.object({ kind: z.literal('custom'), id: z.string(), provider: z.string(), url: z.string() }),
  z.object({ kind: z.literal('domain'), id: z.string(), upstream: z.string(), url: z.string() }),
]);

export type SpaceGrant = z.infer<typeof grantSchema>;

export const providerGrantOf = (grants: readonly SpaceGrant[], providerId: string): Extract<SpaceGrant, { kind: 'model' | 'login' | 'custom' }> | undefined =>
  grants.find((grant): grant is Extract<SpaceGrant, { kind: 'model' | 'login' | 'custom' }> => (grant.kind === 'model' || grant.kind === 'login' || grant.kind === 'custom') && grant.provider === providerId);

const SPACE_CREATION_STEPS = ['checking_place', 'creating', 'downloading_image', 'preparing_tools', 'setting_network', 'bringing_code', 'giving_access', 'ready'] as const;

export type SpaceCreationStep = (typeof SPACE_CREATION_STEPS)[number];

export const spaceCreationStepSchema = z.enum(SPACE_CREATION_STEPS);

const setupSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('queued'), total: z.number().int().min(1) }),
  z.object({ state: z.literal('running'), index: z.number().int().min(0), total: z.number().int().min(1), command: z.string() }),
  z.object({ state: z.literal('done'), total: z.number().int().min(1) }),
  z.object({ state: z.literal('failed'), index: z.number().int().min(0), total: z.number().int().min(1), command: z.string(), exitCode: z.number().int().nullable(), timedOut: z.boolean(), startedAt: z.string().nullable().default(null), finishedAt: z.string().nullable().default(null) }),
  z.object({ state: z.literal('interrupted'), total: z.number().int().min(1) }),
]);

const spaceEntrySchema = z.object({
  id: spaceIdSchema,
  name: z.string(),
  taskTitle: spaceTaskTitleSchema.nullish(),
  placeId: z.string(),
  machine: z.string().nullable().default(null),
  projectDirectory: z.string().nullable(),
  directory: z.string().nullable(),
  projectFolder: z.object({ path: z.string().nullable(), found: z.boolean().nullable() }).default({ path: null, found: null }),
  state: z.enum(['preparing', 'running', 'exited', 'missing', 'failed', 'unreachable']),
  stoppedIdle: z.boolean().default(false),
  step: z.union([spaceCreationStepSchema, z.literal('failed')]).nullable(),
  failure: failureSchema.nullable(),
  network: networkSchema.nullable(),
  grants: z.array(grantSchema),
  access: z.enum(['granted', 'needs_access', 'unknown']).nullable(),
  needsAccess: z.array(z.string()),
  accessFailures: z.array(z.object({ provider: z.string(), code: z.string(), message: z.string() })).default([]),
  damage: z.enum(['repairable', 'gatekeeper_gone']).nullable().default(null),
  setup: setupSchema.nullable().default(null),
});

export type SpaceEntry = z.infer<typeof spaceEntrySchema>;

const DOCKER_SETUP_ACTIONS = ['install_all', 'install_cli', 'start_colima', 'start_desktop'] as const;
export type DockerSetupAction = typeof DOCKER_SETUP_ACTIONS[number];

const DOCKER_REMEDIES = [...DOCKER_SETUP_ACTIONS, 'get_brew', 'linux_install', 'linux_start', 'permission', 'windows_install', 'windows_start'] as const;
export type DockerRemedy = typeof DOCKER_REMEDIES[number];

const dockerSetupJobSchema = z.object({
  action: z.enum(DOCKER_SETUP_ACTIONS),
  running: z.boolean(),
  failure: failureSchema.extend({ output: z.string().default('') }).nullable(),
});

export type DockerSetupJob = z.infer<typeof dockerSetupJobSchema>;

const dockerSetupSchema = z.object({
  remedy: z.enum(DOCKER_REMEDIES).nullable().catch(null),
  job: dockerSetupJobSchema.nullable(),
  memory: z.object({ bytes: z.number().min(0), engine: z.enum(['colima', 'docker_desktop', 'other']).catch('other'), low: z.boolean() }).nullable(),
}).nullable().default(null);

const placeSchema = z.union([
  z.object({ id: z.string(), machine: z.string().nullable().default(null), available: z.literal(true), hostIsolation: z.boolean(), version: z.string().default(''), setup: dockerSetupSchema }),
  z.object({ id: z.string(), machine: z.string().nullable().default(null), available: z.literal(false), code: z.string(), message: z.string(), setup: dockerSetupSchema }),
]);

export type SpacePlace = z.infer<typeof placeSchema>;

export const SSH_PLACE_ID = 'docker-ssh';

export type SpaceStart = 'clean' | 'uncommitted';

export type CreateSpaceRequest = {
  projectDirectory: string;
  name: string;
  placeId: string;
  start: SpaceStart;
  network: SpaceNetwork;
  setupCommands: string[];
  grants: Extract<GrantRequest, { kind: 'model' | 'login' | 'custom' }>[];
};

export type GrantRequest =
  | { kind: 'model'; provider: string; upstream?: string; secret: { kind: 'typed'; value: string } | { kind: 'env'; name: string } | { kind: 'stored' } }
  | { kind: 'login'; provider: string }
  | { kind: 'custom'; provider: string }
  | { kind: 'domain'; upstream: string };

const hostLoginSchema = z.object({
  provider: z.string(),
  method: z.string(),
  expires: z.string().nullable(),
  state: z.enum(['usable', 'expired', 'unsupported']),
});

export type SpaceHostLogin = z.infer<typeof hostLoginSchema>;

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

const catalogProviderSchema = z.object({
  id: z.string(),
  name: z.string(),
  supported: z.boolean(),
  storedKey: z.boolean(),
});

export type SpaceCatalogProvider = z.infer<typeof catalogProviderSchema>;

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

export const setSpaceMachine = async (machine: string): Promise<SpacePlace | null> =>
  (await request(`${SPACES_ROUTE}/machine`, z.object({ place: placeSchema.nullable() }), { method: 'PUT', body: JSON.stringify({ machine }) })).place;

const spaceDiskSchema = z.object({
  imageBytes: z.number().min(0).nullable(),
  imagePulling: z.boolean().default(false),
  imageFailure: failureSchema.nullable().default(null),
  toolsBytes: z.number().min(0),
  spacesBytes: z.number().min(0),
  bytesBySpace: z.record(z.string(), z.number().min(0)).default({}),
  freeBytes: z.number().min(0),
  freesImage: z.boolean(),
});

export type SpaceDisk = z.infer<typeof spaceDiskSchema>;

const spaceCleanUpSchema = z.object({
  freedBytes: z.number().min(0),
  kept: z.array(z.object({ kind: z.string(), reason: z.enum(['in_use', 'failed']) })),
  disk: spaceDiskSchema,
});

export type SpaceCleanUp = z.infer<typeof spaceCleanUpSchema>;

export const readSpaceDisk = (placeId: string, signal?: AbortSignal): Promise<SpaceDisk> =>
  request(`${SPACES_ROUTE}/places/${encodeURIComponent(placeId)}/disk`, spaceDiskSchema, { signal });

export const cleanUpSpaceDisk = (placeId: string): Promise<SpaceCleanUp> =>
  request(`${SPACES_ROUTE}/places/${encodeURIComponent(placeId)}/clean-up`, spaceCleanUpSchema, { method: 'POST' });

export const readDockerSetupJob = async (signal?: AbortSignal): Promise<DockerSetupJob | null> =>
  (await request(`${SPACES_ROUTE}/places/local/setup`, z.object({ job: dockerSetupJobSchema.nullable() }), { signal })).job;

export const startDockerSetup = async (action: DockerSetupAction): Promise<DockerSetupJob | null> =>
  (await request(`${SPACES_ROUTE}/places/local/setup`, z.object({ job: dockerSetupJobSchema.nullable() }), { method: 'POST', body: JSON.stringify({ action }) })).job;

export const pullSpaceImage = (placeId: string): Promise<SpaceDisk> =>
  request(`${SPACES_ROUTE}/places/${encodeURIComponent(placeId)}/image`, spaceDiskSchema, { method: 'POST' });

export const listSpaces = async (signal?: AbortSignal): Promise<SpaceEntry[]> =>
  (await request(SPACES_ROUTE, z.object({ spaces: z.array(spaceEntrySchema) }), { signal })).spaces;

export const createSpace = (body: CreateSpaceRequest): Promise<SpaceEntry> =>
  request(SPACES_ROUTE, spaceEntrySchema, { method: 'POST', body: JSON.stringify(body) });

export const readSpaceHostLogins = async (signal?: AbortSignal): Promise<SpaceHostLogin[]> =>
  (await request(`${SPACES_ROUTE}/logins`, z.object({ logins: z.array(hostLoginSchema) }), { signal })).logins;

export const readSpaceCustomProviders = async (projectDirectory: string, signal?: AbortSignal): Promise<SpaceCustomProvider[]> =>
  (await request(`${SPACES_ROUTE}/custom-providers?directory=${encodeURIComponent(projectDirectory)}`, z.object({ providers: z.array(customProviderSchema) }), { signal })).providers;

export const readSpaceCatalogProviders = async (projectDirectory: string, signal?: AbortSignal): Promise<SpaceCatalogProvider[]> =>
  (await request(`${SPACES_ROUTE}/catalog-providers?directory=${encodeURIComponent(projectDirectory)}`, z.object({ providers: z.array(catalogProviderSchema) }), { signal })).providers;

export const grantSpaceAccess = async (spaceId: string, body: GrantRequest): Promise<SpaceGrant> =>
  (await request(`${SPACES_ROUTE}/${spaceId}/grants`, z.object({ grant: grantSchema }), { method: 'POST', body: JSON.stringify(body) })).grant;

export const openSpaceDomain = async (spaceId: string, domain: string): Promise<SpaceNetwork> =>
  (await request(`${SPACES_ROUTE}/${spaceId}/network/domains`, z.object({ network: networkSchema }), { method: 'POST', body: JSON.stringify({ domain }) })).network;

const journalRecordSchema = z.object({
  at: z.string(),
  listener: z.string(),
  host: z.string(),
  port: z.number(),
  decision: z.string(),
});

export type SpaceJournalRecord = z.infer<typeof journalRecordSchema>;

const journalSchema = z.object({ records: z.array(journalRecordSchema), dropped: z.number(), since: z.string() });

export type SpaceJournal = z.infer<typeof journalSchema>;

export const readSpaceJournal = (spaceId: string, signal?: AbortSignal): Promise<SpaceJournal> =>
  request(`${SPACES_ROUTE}/${spaceId}/journal`, journalSchema, { signal });

const savedChatsSchema = z.object({ saved: z.number().int().min(0) });

const removalSchema = z.object({
  id: spaceIdSchema,
  removed: z.boolean(),
  failures: z.array(failureSchema),
  chats: savedChatsSchema.nullable().default(null),
});

type SpaceRemoval = z.infer<typeof removalSchema>;

export const startSpace = (spaceId: string): Promise<SpaceEntry> =>
  request(`${SPACES_ROUTE}/${spaceId}/start`, spaceEntrySchema, { method: 'POST' });

export const setSpaceTaskTitle = async (spaceId: string, title: string): Promise<void> => {
  await request(`${SPACES_ROUTE}/${spaceId}/task-title`, z.object({ applied: z.boolean(), taskTitle: spaceTaskTitleSchema.nullable() }), { method: 'PUT', body: JSON.stringify({ title }) });
};

export const stopSpace = (spaceId: string): Promise<SpaceEntry> =>
  request(`${SPACES_ROUTE}/${spaceId}/stop`, spaceEntrySchema, { method: 'POST' });

export const restartSpace = (spaceId: string): Promise<SpaceEntry> =>
  request(`${SPACES_ROUTE}/${spaceId}/restart`, spaceEntrySchema, { method: 'POST' });

export const restartSpaceOpenCode = (spaceId: string): Promise<SpaceEntry> =>
  request(`${SPACES_ROUTE}/${spaceId}/restart-opencode`, spaceEntrySchema, { method: 'POST' });

export const SPACE_IDLE_STOP_MIN_HOURS = 1;
export const SPACE_IDLE_STOP_MAX_HOURS = 168;

const idleStopSchema = z.object({
  enabled: z.boolean(),
  hours: z.number().int().min(SPACE_IDLE_STOP_MIN_HOURS).max(SPACE_IDLE_STOP_MAX_HOURS),
});

export type SpaceIdleStop = z.infer<typeof idleStopSchema>;

export const readSpaceIdleStop = (signal?: AbortSignal): Promise<SpaceIdleStop> =>
  request(`${SPACES_ROUTE}/idle-stop`, idleStopSchema, { signal });

export const setSpaceIdleStop = (setting: SpaceIdleStop): Promise<SpaceIdleStop> =>
  request(`${SPACES_ROUTE}/idle-stop`, idleStopSchema, { method: 'PUT', body: JSON.stringify(setting) });

export const runSpaceSetup = (spaceId: string, commands: readonly string[]): Promise<SpaceEntry> =>
  request(`${SPACES_ROUTE}/${spaceId}/setup`, spaceEntrySchema, { method: 'POST', body: JSON.stringify({ commands }) });

const setupOutputSchema = z.object({ setup: setupSchema.nullable(), output: z.string().nullable() });

export type SpaceSetupOutput = z.infer<typeof setupOutputSchema>;

export const readSpaceSetup = (spaceId: string, signal?: AbortSignal): Promise<SpaceSetupOutput> =>
  request(`${SPACES_ROUTE}/${spaceId}/setup`, setupOutputSchema, { signal });

export const removeSpace = (spaceId: string, { deleteUnsavedChats = false }: { deleteUnsavedChats?: boolean } = {}): Promise<SpaceRemoval> =>
  request(`${SPACES_ROUTE}/${spaceId}${deleteUnsavedChats ? '?unsavedChats=delete' : ''}`, removalSchema, { method: 'DELETE' });

const archiveSchema = z.object({ spaceId: spaceIdSchema, name: z.string(), directory: z.string() });

export type SpaceArchive = z.infer<typeof archiveSchema>;

export const listSpaceArchives = async (signal?: AbortSignal): Promise<SpaceArchive[]> =>
  (await request(`${SPACES_ROUTE}/archives`, z.object({ archives: z.array(archiveSchema) }), { signal })).archives;

const applyPreviewSchema = z.object({
  changedPaths: z.number().int().min(0),
  changedBytes: z.number().min(0),
  nestedRepositories: reportedPathsSchema,
  unmerged: reportedPathsSchema,
  changesRoute: z.enum(['open', 'closed']),
  lastApplied: z.string().nullable(),
  newPaths: z.number().int().min(0).nullable(),
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

const applyOutcomeSchema = z.object({
  applied: appliedSchema,
  removal: removalSchema.nullable(),
  kept: failureSchema.nullable().default(null),
});

export type SpaceApplyOutcome = z.infer<typeof applyOutcomeSchema>;

export const previewSpaceApply = (spaceId: string, signal?: AbortSignal): Promise<SpaceApplyPreview> =>
  request(`${SPACES_ROUTE}/${spaceId}/apply`, applyPreviewSchema, { signal });

export const applySpaceWork = (spaceId: string, body: SpaceApplyRequest): Promise<SpaceApplyOutcome> =>
  request(`${SPACES_ROUTE}/${spaceId}/apply`, applyOutcomeSchema, { method: 'POST', body: JSON.stringify(body) });
