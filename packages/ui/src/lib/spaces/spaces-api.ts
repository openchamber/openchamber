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

/** A refusal or failure of a journey route: the server's code, its message, and the HTTP status. */
export class SpacesRequestError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'SpacesRequestError';
    this.code = code;
    this.status = status;
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

const spaceEntrySchema = z.object({
  id: spaceIdSchema,
  name: z.string(),
  projectDirectory: z.string().nullable(),
  directory: z.string().nullable(),
  state: z.enum(['preparing', 'running', 'exited', 'missing', 'failed']),
  step: spaceCreationStepSchema.nullable(),
  failure: failureSchema.nullable(),
  // Null when the host could not read what the user chose: unknown, never "open".
  network: networkSchema.nullable(),
  grants: z.array(grantSchema),
  access: z.enum(['granted', 'needs_access', 'unknown']).nullable(),
  needsAccess: z.array(z.string()),
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
};

export type GrantRequest =
  | { kind: 'model'; provider: string; upstream: string; secret: { kind: 'typed'; value: string } | { kind: 'env'; name: string } }
  | { kind: 'domain'; upstream: string };

const errorBodySchema = z.object({ code: z.string(), message: z.string() });

const request = async <T>(path: string, schema: z.ZodType<T>, init: RequestInit = {}): Promise<T> => {
  const response = await runtimeFetch(path, {
    ...init,
    headers: init.body === undefined ? init.headers : { 'Content-Type': 'application/json', ...init.headers },
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = errorBodySchema.safeParse(body);
    throw error.success
      ? new SpacesRequestError(error.data.code, error.data.message, response.status)
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

export const removeSpace = (spaceId: string): Promise<SpaceRemoval> =>
  request(`${SPACES_ROUTE}/${spaceId}`, removalSchema, { method: 'DELETE' });
