// The journey of a space as the host drives it: made with its network choice and the project's
// code, listed with its state, started again with its network said again to a gatekeeper that
// forgot it, stopped, removed with everything the host kept for it, its journal read, and its
// work brought out and applied. Everything here is written once on top of the manager, the
// gatekeeper channel, code in and code out; the routes in `routes.js` only translate HTTP.
//
// A creation runs in the background: the request comes back at once with the space's id, and the
// steps are announced as `openchamber:space-progress` events on the host's hub, so the group in
// the sidebar can say what is happening now (journey step 2). A creation that fails
// after the containers exist removes them again, and its failure stays listed until the user
// dismisses it, so an error is never silent.
//
// Grants, since 5b: a model key the gatekeeper's window adds to the provider's requests, or an
// opened domain the window forwards to with no credential. The host keeps the grant without its
// value (decision 5) and says it again to the gatekeeper after every start; a value it cannot
// find again leaves the space "needs access" until the user grants once more. Since stage 7 a
// grant can be the host's own browser login for a provider: the short token goes to the window
// the same way, read from the host's OpenCode now and at every start, and the space gets a row
// that only names the method (decision 13).
//
// Repair, since 5d-2 (journey step 8 and decision 10): restart OpenCode inside, and
// restart the container with a fresh token for the server inside. A space whose gatekeeper is gone
// is listed as such, because no restart brings it back.
//
// Idle stop, since 5d-3 (decision 11): the server inside stops itself after the user's idle hours.
// The host tells it the setting at every start and whenever the user changes it, lists a space
// that stopped that way as such, and stops the gatekeeper it finds running beside a stopped space,
// which is what an idle stop leaves while OpenChamber is closed.
//
// Setup commands, since 5d-4 (see "Setup commands" in DOCUMENTATION.md): the project's worktree setup commands
// run inside the space once its code arrived, in the background, and again when the user asks.
//
// The chat archive, since 5e-2 (decision 9, journey step 7): a delete takes the space's chats to
// the host's archive first, starting a stopped space for it, and deletes nothing when they cannot
// all be saved, unless the user said to delete anyway. See `space-archive.js`.

import crypto from 'node:crypto';
import fsPromises from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import { SpaceError } from './errors.js';
import { DEFAULT_IDLE_STOP, idleStopSchema } from './idle-stop.js';
import { headerOfPackage, windowUpstreamOf } from './host-providers.js';
import { ROLE_GATEKEEPER, createSpaceId, hashProjectDirectory, spaceResourceName } from './labels.js';
import { spaceProjectPath, spaceWindowUrl } from './layout.js';
import { LOGIN_PROVIDERS, loginEndOf, loginEnded, loginGrantOf } from './space-opencode.js';
import { domainSchema, grantSchema, networkSchema, providerIdSchema, secretSourceSchema } from './space-records.js';
import { createSpaceToken } from './space-server.js';
import { createSpaceSetup, setupCommandsSchema } from './space-setup.js';

// The four choices of the create dialog, parsed at the boundary. Each field refuses with a code
// of its own, so the dialog can point at the field.
const createRequestSchema = z.object({
  // The place the space is made on; the first configured place, local Docker, unless the dialog says another.
  placeId: z.string().min(1).optional(),
  projectDirectory: z.string().min(1),
  name: z.string().trim().min(1),
  start: z.enum(['clean', 'uncommitted']).default('uncommitted'),
  network: networkSchema.default({ mode: 'allowlist', domains: [] }),
  // The project's worktree setup commands as the client resolved them, the shared ones only when
  // the user trusted them; they run once the code arrived (5d-4).
  setupCommands: setupCommandsSchema.default([]),
  // The model access chosen in the dialog, given by the host once the space runs, before it is
  // ready: the creation carries it, so nothing depends on the window that asked staying open.
  // A typed key lives only in this request and the gatekeeper, as with the grant dialog.
  grants: z.lazy(() => creationGrantsSchema).default([]),
});
const CREATE_REFUSALS = {
  placeId: ['place_not_found', 'A space is made on one of the configured places.'],
  projectDirectory: ['project_not_registered', 'A space is made for a project this OpenChamber knows. Add the project first, then create the space.'],
  name: ['invalid_space_name', 'A space needs a name.'],
  start: ['invalid_snapshot_mode', 'A space starts from a clean commit or with the uncommitted changes.'],
  network: ['invalid_network', 'The network of a space is allowlist or open, with a list of domain names for the allowlist.'],
  setupCommands: ['invalid_setup_commands', 'The setup commands are a list of at most 100 commands of at most 4000 characters each.'],
  grants: ['invalid_grant_request', 'The model access of a new space is a list of model keys, the host\'s own logins and providers of your own.'],
};
const setupRequestSchema = z.object({ commands: setupCommandsSchema }).strict();
// The grant dialog's request, parsed at the boundary. A model grant names the provider as the
// host's catalog does, the provider's API as the upstream, and where the key comes from: typed
// once, or an environment variable of the host's by name. The value of a typed key is used now
// and remembered nowhere. An opened domain has no key.
const MAX_SECRET_LENGTH = 8192;
const grantRequestSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('model'),
    provider: grantSchema.options[0].shape.provider,
    upstream: grantSchema.options[0].shape.upstream,
    secret: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('typed'), value: z.string().min(1).max(MAX_SECRET_LENGTH) }).strict(),
      secretSourceSchema.options[0],
    ]),
  }).strict(),
  z.object({ kind: z.literal('domain'), upstream: grantSchema.options[1].shape.upstream }).strict(),
  // The host's browser login for a provider; the token is read from the host's OpenCode here.
  z.object({ kind: z.literal('login'), provider: providerIdSchema }).strict(),
  // A provider the user defined on the host; its address, key and models are read from the host's configuration here.
  z.object({ kind: z.literal('custom'), provider: providerIdSchema }).strict(),
]);
// The model access a creation may carry: the grant dialog's kinds without the opened domain,
// which the network choice already covers, one per provider.
const MAX_CREATION_GRANTS = 16;
const creationGrantsSchema = z.array(z.discriminatedUnion('kind', [
  grantRequestSchema.options[0],
  grantRequestSchema.options[2],
  grantRequestSchema.options[3],
])).max(MAX_CREATION_GRANTS);
// The header the window sets for a provider: what its API reads a key from. Only providers
// named here are taken: one that reads its key another way or signs its requests, Azure,
// Bedrock or Vertex, would take the grant and fail every turn with a 401 upstream.
const HEADER_BY_PROVIDER = new Map([
  ['anthropic', 'x-api-key'],
  ['google', 'x-goog-api-key'],
  ...['openai', 'openrouter', 'groq', 'mistral', 'deepseek', 'xai'].map((provider) => [provider, 'authorization']),
]);

// A domain the user opens for a running space, from the grant dialog or from a blocked attempt
// in the journal: the allowlist's own rule for a name, read in any case.
const openDomainRequestSchema = z.object({
  domain: z.string().trim().toLowerCase().pipe(domainSchema),
}).strict();

const applyRequestSchema = z.discriminatedUnion('as', [
  z.object({ as: z.literal('branch'), branch: z.string(), removeAfterwards: z.boolean().default(false) }),
  z.object({ as: z.literal('changes'), removeAfterwards: z.boolean().default(false) }),
]);

// How long the login row's repair waits for an action on the space to finish: a grant is a few
// requests inside, well under this.
const REPAIR_BUSY_ATTEMPTS = 40;
const REPAIR_BUSY_PAUSE_MS = 250;
const pause = (milliseconds) => new Promise((resolve) => { setTimeout(resolve, milliseconds); });

const failureOf = (error) => ({
  code: error instanceof SpaceError ? error.code : 'space_journey_failed',
  message: error?.message ?? String(error),
  details: error instanceof SpaceError ? error.details ?? null : null,
});

/**
 * `manager` is the space manager over every place, which routes a space's operations to the place
 * it lives on, and `places` the place registry, asked by id for a check, the disk and the image.
 * `listProjectDirectories` answers the host's registered projects; a space is made for one of them
 * and its label carries the project's hash. `announce(spaceId, payload)` enters an event into the
 * host's hub, `onSpacesChanged()` tells the host to read its list again at once. `spaceOpenCode`
 * writes OpenCode's files inside a space, and `readHostSecret(name)` is how a key named by an
 * environment variable of the host's is found again: its value or undefined, never stored.
 * `readHostLogin(provider)` reads the host's own browser login for a provider from its OpenCode,
 * `{ methodID, access, expires, metadata }` or null, for a login grant; it is never stored either.
 * `loginWindowOf(provider, login)` is the window grant that login makes, `space-opencode.js`'s
 * unless a live test points the upstream at a stand-in. `hostProviders` reads the providers the
 * user defined in the host's OpenCode configuration, `host-providers.js`, for a custom grant:
 * `read(providerId, directory)` one with its key, `list(directory)` all of them without.
 * `serverInside.writeToken(spaceId, token)` replaces the token the server inside reads when it
 * starts, and `restartOpenCodeInside(spaceId)` asks the server inside to restart its OpenCode.
 * `readIdleStop()` and `saveIdleStop(setting)` read and keep the user's idle stop setting, and
 * `serverInside.writeIdleStop(spaceId, setting)` tells it to the server inside.
 * `archiveChats({ spaceId, name, projectDirectory, running, allowUnsaved })` saves a space's chats
 * to the host's archive before it goes, see `space-archive.js`; without it the chats go with it.
 * `folderExists(directory)` says whether the project folder a space was made for is still a
 * folder on the host, for the list. `resolveDirectory` is the host's `path.resolve`, injectable so a
 * test can resolve Windows paths on another system.
 */
export function createSpaceJourney({
  manager,
  places,
  gatekeeper,
  codeIn,
  codeOut,
  records,
  spaceOpenCode,
  serverInside,
  restartOpenCodeInside,
  listProjectDirectories,
  archiveChats = null,
  readHostSecret = () => undefined,
  readHostLogin = async () => null,
  loginWindowOf = loginGrantOf,
  hostProviders = { read: async () => null, list: async () => [] },
  readIdleStop = async () => ({ ...DEFAULT_IDLE_STOP }),
  saveIdleStop = async () => {},
  folderExists = async (directory) => (await fsPromises.stat(directory).catch(() => null))?.isDirectory() === true,
  resolveDirectory = path.resolve,
  announce = () => {},
  onSpacesChanged = () => {},
  logger = console,
  now = () => new Date(),
}) {
  // Creations under way or failed, by space id, until they succeed or the user dismisses them.
  const pending = new Map();
  // The grants a creation could not give, by space, until a grant for the provider succeeds or the
  // space goes. Kept in this process only: after a restart the group says the space has no model.
  const creationAccessFailures = new Map();
  // Spaces with an action under way: start, stop, remove, journal or apply. One at a time per space,
  // so a remove cannot pull the refs from under an apply that is writing them.
  const busy = new Set();
  // Set while the switch is being turned off: no creation may slip in between the stop of the
  // spaces and the moment the feature is gone.
  let closing = false;
  // Every write of the idle stop setting, a change's and a start's, one after the other, so a
  // space never ends up with an older one.
  let idleStopTurn = Promise.resolve();
  // Stops of a gatekeeper left beside a stopped space, under way, by space id; a start waits for one.
  const strayStops = new Map();
  // Login rows being written again after a start, by space id; a grant waits for one, see "Grants".
  const rowRepairs = new Map();
  // The project's setup commands inside a space, since 5d-4; each step is announced so the
  // clients read the list again.
  const setup = createSpaceSetup({
    exec: manager.exec,
    records,
    announce: (spaceId) => announce(spaceId, { type: 'openchamber:space-setup', properties: { spaceId, timestamp: now().getTime() } }),
    logger,
    now,
  });

  const requirePlace = (placeId) => {
    const place = places.get(placeId);
    if (!place) throw new SpaceError('place_not_found', `There is no place ${placeId}`);
    return place;
  };

  // Which places could not be asked at the last list, so a place going away or coming back is
  // logged once and not at every read of the list.
  let unavailablePlaces = '';
  const listAll = async () => {
    const listed = await manager.listAllSpaces();
    const names = listed.unavailable.map((entry) => entry.placeId).sort().join(',');
    if (names !== unavailablePlaces) {
      for (const { placeId, failure } of listed.unavailable) logger.warn?.(`[spaces] place ${placeId} cannot be asked, its spaces are listed from the records: ${failure?.code ?? failure?.message ?? failure}`);
      if (names === '') logger.info?.('[spaces] every place answers again');
      unavailablePlaces = names;
    }
    return listed;
  };

  const exclusive = async (spaceId, work) => {
    if (busy.has(spaceId)) throw new SpaceError('space_busy', 'Another action on this space is still running. Wait for it to finish.');
    busy.add(spaceId);
    try {
      return await work();
    } finally {
      busy.delete(spaceId);
    }
  };

  /** Refuses an action on a creation under way, and names a failed one for what it is. */
  const requireNotPending = (spaceId) => {
    const waiting = pending.get(spaceId);
    if (!waiting) return;
    if (waiting.state === 'failed') throw new SpaceError('space_creation_failed', 'Making this space failed. Dismiss it, then create a new one.');
    throw new SpaceError('space_preparing', 'This space is still being made.');
  };

  const registeredProjects = async () => {
    const directories = await listProjectDirectories();
    return new Map(directories.map((directory) => [hashProjectDirectory(directory), directory]));
  };

  // The UI sends a project's folder in its own spelling, with forward slashes on Windows, while the
  // settings keep the system's; both resolve to the same path. The space is made for the folder as
  // the settings name it.
  const requireRegisteredProject = async (directory) => {
    const resolved = resolveDirectory(directory);
    const projects = await registeredProjects();
    if (projects.get(hashProjectDirectory(resolved)) !== resolved) {
      throw new SpaceError(...CREATE_REFUSALS.projectDirectory);
    }
    return resolved;
  };

  const progress = (entry, step, failure = null) => {
    entry.step = step;
    entry.state = step === 'failed' ? 'failed' : step === 'ready' ? 'running' : 'preparing';
    entry.failure = failure;
    announce(entry.id, { type: 'openchamber:space-progress', properties: { spaceId: entry.id, step, failure, timestamp: now().getTime() } });
  };

  /** Removes the space and everything the host kept for it, and says what did not go. */
  const removeEverything = async (spaceId, repository) => {
    creationAccessFailures.delete(spaceId);
    const outcome = { removed: false, refsRemoved: null, failures: [] };
    // The record goes with the space. It stays when the space could not be removed, so a space
    // whose place cannot be asked keeps its place in the list until the machine answers and the
    // delete goes through; the one exception is a place that is no longer configured, where
    // nothing from here can reach the space and the record is all there is to forget.
    let forgetRecord = true;
    try {
      await manager.removeSpace({ spaceId });
      outcome.removed = true;
    } catch (error) {
      outcome.failures.push(failureOf(error));
      forgetRecord = error instanceof SpaceError && error.code === 'place_not_found';
    }
    if (repository) {
      try {
        await codeIn.removeSpaceRefs({ repository, spaceId });
        outcome.refsRemoved = true;
      } catch (error) {
        outcome.refsRemoved = false;
        // A project folder that is gone, moved or deleted, took its refs with it: they cannot be
        // found from here, and nothing of the space is left to remove, so the delete went through.
        if (error instanceof SpaceError && error.code === 'project_folder_missing') {
          logger.warn?.(`[spaces] the service refs of space ${spaceId} stay in its project folder, which is no longer at its path`);
        } else {
          outcome.failures.push(failureOf(error));
        }
      }
    }
    if (forgetRecord) records.remove(spaceId);
    return outcome;
  };

  /**
   * Tells the server inside the idle stop setting. It saves memory and guards nothing, so a write
   * that fails is logged and the space runs with what it had: the setting of its last start, or
   * none, which stops nothing.
   */
  const writeIdleStop = async (spaceId, setting) => {
    try {
      await serverInside.writeIdleStop(spaceId, setting);
    } catch (error) {
      logger.warn?.(`[spaces] space ${spaceId} keeps its idle stop setting: ${error?.code ?? error?.message ?? error}`);
    }
  };

  /** The setting as kept now, told to a space that was made or started, in turn with the changes. */
  const deliverIdleStop = (spaceId) => {
    const delivery = idleStopTurn.then(async () => writeIdleStop(spaceId, await readIdleStop()));
    idleStopTurn = delivery.catch(() => {});
    return delivery.catch((error) => {
      logger.warn?.(`[spaces] space ${spaceId} keeps its idle stop setting: ${error?.code ?? error?.message ?? error}`);
    });
  };

  const sendHistoryInBackground = ({ repository, spaceId, spacePath, base }) => {
    codeIn.sendHistory({ repository, spaceId, spacePath, base })
      .then((result) => { records.update(spaceId, { history: result.status }); })
      .catch((error) => {
        logger.warn?.(`[spaces] the history of space ${spaceId} did not arrive: ${error?.details?.cause ?? error?.code ?? error?.message}`);
        records.update(spaceId, { history: 'failed' });
      });
  };

  const prepare = async (entry, { placeId, projectDirectory, name, start, network, setupCommands, grants }) => {
    let created = false;
    try {
      progress(entry, 'checking_place');
      const check = await requirePlace(placeId).check();
      if (!check.available) throw new SpaceError(check.code, check.message);
      if (network.mode === 'allowlist' && check.hostIsolation !== true) {
        throw new SpaceError('place_cannot_restrict_network', 'This place cannot keep a space away from the machine it runs on, so an allowlist would not hold. Use a newer Docker engine, or choose the open network with that in mind.');
      }
      progress(entry, 'creating');
      await manager.createSpace({ id: entry.id, placeId, projectDirectory, name, onStep: (step) => progress(entry, step) });
      created = true;
      // With the place, the name and the time, so the space is still listed while its place cannot be asked.
      records.write(entry.id, { placeId, name: entry.name, created: entry.created, network, repository: projectDirectory });
      progress(entry, 'setting_network');
      await gatekeeper.setNetwork(entry.id, network);
      progress(entry, 'bringing_code');
      const arrived = await codeIn.bringCodeIn({ repository: projectDirectory, spaceId: entry.id, mode: start });
      records.update(entry.id, { spacePath: arrived.spacePath, base: arrived.base });
      entry.identityCopied = arrived.identityCopied;
      await deliverIdleStop(entry.id);
      // The model access chosen in the dialog, before "ready", so the first message finds it. A
      // grant that fails leaves the space working and is listed with its reason until a later grant
      // for the provider succeeds; the group offers the grant dialog for it.
      if (grants.length > 0) {
        progress(entry, 'giving_access');
        const failures = [];
        for (const asked of grants) {
          try {
            await giveGrant(entry.id, asked);
          } catch (error) {
            failures.push({ provider: asked.provider, ...failureOf(error) });
          }
        }
        if (failures.length > 0) creationAccessFailures.set(entry.id, failures);
      }
      pending.delete(entry.id);
      progress(entry, 'ready');
      onSpacesChanged();
      // In the background, while the agent can already start (journey step 2).
      if (setupCommands.length > 0) setup.start(entry.id, { projectPath: arrived.spacePath, commands: setupCommands });
      sendHistoryInBackground({ repository: projectDirectory, spaceId: entry.id, spacePath: arrived.spacePath, base: arrived.base });
    } catch (error) {
      const failure = failureOf(error);
      if (created) {
        const cleanup = await removeEverything(entry.id, projectDirectory);
        if (cleanup.failures.length > 0) failure.cleanup = cleanup.failures;
      }
      logger.warn?.(`[spaces] creating space ${entry.id} failed at ${entry.step}: ${failure.code}`);
      progress(entry, 'failed', failure);
    }
  };

  /**
   * Starts making a space and answers at once with the entry the list will carry. The four
   * choices of the create dialog come in: the project, the name, the starting point and the
   * network. The place is checked inside, as decision 19 asks: nothing probes a runtime before
   * the user acts.
   */
  const createSpace = async (request) => {
    if (closing) throw new SpaceError('isolated_spaces_off', 'Isolated spaces are being turned off.');
    const parsed = createRequestSchema.safeParse(request ?? {});
    if (!parsed.success) {
      const [code, message] = CREATE_REFUSALS[parsed.error.issues[0]?.path?.[0]] ?? CREATE_REFUSALS.network;
      throw new SpaceError(code, message);
    }
    const { name, start, network, setupCommands, grants } = parsed.data;
    const placeId = parsed.data.placeId ?? places.list()[0]?.id;
    requirePlace(placeId);
    const projectDirectory = await requireRegisteredProject(parsed.data.projectDirectory);
    const id = createSpaceId();
    const entry = {
      id,
      name,
      placeId,
      projectDirectory,
      directory: spaceProjectPath(id, projectDirectory),
      created: now().toISOString(),
      state: 'preparing',
      step: 'checking_place',
      failure: null,
      network,
      setupTotal: setupCommands.length,
    };
    pending.set(entry.id, entry);
    void prepare(entry, { placeId, projectDirectory, name, start, network, setupCommands, grants });
    return describePending(entry);
  };

  /** A grant as the list and the grant route show it: everything the record holds, which holds no value. */
  const describeGrant = (grant) => ({ ...grant, url: spaceWindowUrl(grant.id) });

  /** Whether a grant has an entry in OpenCode's configuration inside: a key, a login or a custom provider. */
  const configuresProvider = (grant) => grant.kind === 'model' || grant.kind === 'login' || grant.kind === 'custom';

  /**
   * The window grant a custom provider's definition makes, or null for one the window cannot
   * serve: its base URL with "this machine" sent to the Docker host, its key under the header its
   * SDK reads, no header and no key for a provider that has none, and the provider's own headers
   * beside either, which the gatekeeper keeps with the key and the space never sees.
   */
  const customWindowOf = (definition) => {
    if (!definition) return null;
    const upstream = definition.baseURL === null ? null : windowUpstreamOf(definition.baseURL);
    const header = headerOfPackage(definition.package);
    if (upstream === null || header === null) return null;
    const window = definition.key === null ? { upstream, header: null, secret: null } : { upstream, header, secret: definition.key };
    if (Object.keys(definition.headers).length > 0) window.headers = definition.headers;
    return window;
  };

  /**
   * The host's definition of every custom provider among the grants, by id, without a key, for
   * the configuration inside. One the host cannot read now is left out and logged; the next start reads again.
   */
  const customDefinitionsOf = async (grants, repository) => {
    const definitions = new Map();
    for (const grant of grants) {
      if (grant.kind !== 'custom') continue;
      const definition = await hostProviders.read(grant.provider, repository).catch(() => null);
      if (!definition) {
        logger.warn?.(`[spaces] the custom provider ${grant.provider} is not in the host's configuration now; the space is not told about it`);
        continue;
      }
      const { key: _key, ...rest } = definition;
      definitions.set(grant.provider, rest);
    }
    return definitions;
  };

  /**
   * Says one grant of the record to the gatekeeper. Resolves whether it could: a typed key is
   * not remembered and needs the user again, and so does an environment variable that is not set
   * now; a gatekeeper that refuses or does not answer counts the same way and is logged, because
   * the space runs either way and the list must say that its access is missing.
   */
  const deliverGrant = async (spaceId, grant, login = null, repository = null) => {
    let secret = null;
    let upstream = grant.kind === 'login' || grant.kind === 'custom' ? null : grant.upstream;
    let header = grant.kind === 'model' ? grant.header : null;
    let headers;
    if (grant.kind === 'model') {
      if (grant.source.kind === 'typed') return false;
      secret = readHostSecret(grant.source.name);
      if (typeof secret !== 'string' || secret === '') return false;
    }
    if (grant.kind === 'login') {
      const window = login ? loginWindowOf(grant.provider, login) : null;
      if (!window) return false;
      ({ upstream, header, secret } = window);
    }
    if (grant.kind === 'custom') {
      const window = customWindowOf(await hostProviders.read(grant.provider, repository).catch(() => null));
      if (!window) return false;
      ({ upstream, header, secret, headers } = window);
    }
    try {
      const said = { id: grant.id, upstream, header, secret };
      if (headers) said.headers = headers;
      await gatekeeper.addGrant(spaceId, said);
      return true;
    } catch (error) {
      logger.warn?.(`[spaces] the grant ${grant.id} of space ${spaceId} could not be said again: ${error?.code ?? error?.message ?? error}`);
      return false;
    }
  };

  /**
   * OpenCode's configuration inside, written again from the record at a start: it survives a
   * stop in the home volume, but a write that failed at the grant is repaired only here. It
   * cooperates and enforces nothing, so a failure is logged and the start goes on.
   */
  const rewriteProviderConfig = async (spaceId, grants, repository) => {
    if (!grants.some((grant) => configuresProvider(grant))) return;
    try {
      await spaceOpenCode.writeProviderConfig(spaceId, grants, await customDefinitionsOf(grants, repository));
    } catch (error) {
      logger.warn?.(`[spaces] the provider configuration of space ${spaceId} was not written again: ${error?.code ?? error?.message ?? error}`);
    }
  };

  /**
   * The host's login a login grant can be said with, as it is now, or null: a host that is signed
   * out, one signed in by another method since the grant, whose requests the row inside would
   * send somewhere else than the window forwards to, and a token that has already ended, which
   * would fail every turn inside with nothing telling the user why, all need the user again.
   */
  const usableHostLogin = async (grant) => {
    const login = await readHostLogin(grant.provider).catch(() => null);
    if (!login || login.methodID !== grant.method || loginEnded(grant.provider, login, now().getTime())) return null;
    return login;
  };

  /** Every grant of the record said again after a start. Resolves the ids that went and the ids that need the user. */
  const restoreGrants = async (spaceId, grants, repository) => {
    const restored = [];
    const needsAccess = [];
    for (const grant of grants) {
      const login = grant.kind === 'login' ? await usableHostLogin(grant) : null;
      (await deliverGrant(spaceId, grant, login, repository) ? restored : needsAccess).push(grant.id);
    }
    return { restored, needsAccess };
  };

  /**
   * The login row inside, written again from the host's login at a start, or taken out when the
   * record holds no login grant the host can say: it survives a stop in the home volume, but a
   * write that failed at the grant, or a removal that failed when a key replaced a login, is
   * repaired only here. In the background, once the server inside answers, because the start
   * does not wait for it. What to write is decided then, from the record and the host's login
   * as they are then, so a grant that came in the meantime is not undone: the repair waits for
   * an action under way, and a grant that arrives while the repair writes waits for it, a few
   * hundred milliseconds, rather than being refused as busy right after a start. A grant still
   * under way after a short wait keeps its own row and the repair is skipped. The row cooperates
   * and enforces nothing, so a failure is logged.
   */
  const repairLoginRowInBackground = (spaceId) => {
    void (async () => {
      await serverInside.waitUntilReady(spaceId);
      for (let attempt = 0; busy.has(spaceId); attempt += 1) {
        if (attempt >= REPAIR_BUSY_ATTEMPTS) {
          logger.info?.(`[spaces] the login row of space ${spaceId} was left to the action under way`);
          return;
        }
        await pause(REPAIR_BUSY_PAUSE_MS);
      }
      const writing = (async () => {
        const { record } = records.read(spaceId);
        if (!record) return;
        const written = new Set();
        for (const grant of record.grants) {
          if (grant.kind !== 'login') continue;
          const login = await usableHostLogin(grant);
          if (!login) continue;
          await spaceOpenCode.writeLogin(spaceId, grant.provider, login);
          written.add(grant.provider);
        }
        for (const provider of LOGIN_PROVIDERS) if (!written.has(provider)) await spaceOpenCode.removeLogin(spaceId, provider);
      })();
      rowRepairs.set(spaceId, writing);
      try {
        await writing;
      } finally {
        if (rowRepairs.get(spaceId) === writing) rowRepairs.delete(spaceId);
      }
    })().catch((error) => {
      logger.warn?.(`[spaces] the login row of space ${spaceId} was not written again: ${error?.code ?? error?.message ?? error}`);
    });
  };
  /**
   * The host's own browser logins a space can be given, for the grant dialog to offer the choice
   * and to say why a login grant needs the user again (7c): for each provider the host has a
   * login for, its method, when it ends, null for a token with no end, and whether it can be said
   * now, `usable`, has `expired` and could not be renewed, or was made in a way the window does
   * not know, `unsupported`. Never the token. A host that cannot be asked throws, so a failed read
   * never reads as "signed out".
   */
  const readHostLogins = async () => {
    const logins = [];
    for (const provider of LOGIN_PROVIDERS) {
      const login = await readHostLogin(provider);
      if (!login) continue;
      const end = loginEndOf(provider, login);
      const state = !loginWindowOf(provider, login) ? 'unsupported' : loginEnded(provider, login, now().getTime()) ? 'expired' : 'usable';
      logins.push({ provider, method: login.methodID, expires: end === null ? null : new Date(end).toISOString(), state });
    }
    return { logins };
  };

  /**
   * The providers the user defined in the host's OpenCode configuration for a project, as the
   * grant dialogs offer them, never a key: a catalog provider overridden there is not among them,
   * since the dialogs offer those under their own names.
   */
  const readHostCustomProviders = async (directory) => {
    const providers = (await hostProviders.list(directory)).filter((provider) => !HEADER_BY_PROVIDER.has(provider.id) && !LOGIN_PROVIDERS.includes(provider.id));
    return { providers };
  };

  /** Waits for a login row repair that is writing now; its failure is its own and logged there. */
  const afterRowRepair = (spaceId) => (rowRepairs.get(spaceId) ?? Promise.resolve()).catch(() => {});

  /**
   * Tells a space's gatekeeper the host's login again, for the keeper of `login-keeper.js`
   * when the token changed: the same window grant, replaced in place. Resolves true when the
   * gatekeeper took it and false when it refused, logged. A space with an action under way is
   * left to it, which says the login itself at a start, and answers null so the keeper tries
   * again on its next look.
   */
  const sayLogin = async (spaceId, grant, login) => {
    if (busy.has(spaceId)) return null;
    return deliverGrant(spaceId, grant, login);
  };

  /**
   * The grants of every running space that its gatekeeper does not hold, said again from the
   * record, at the host's start: a start the previous host did not live to finish leaves them
   * unsaid, and the user would otherwise be asked for a key the record already names. Only what
   * the host can say on its own goes: an environment key read now, and an opened domain; a typed
   * key stays with the user. A space with an action under way is left to that action, and a
   * gatekeeper that cannot be asked is left alone and logged. Nothing here fails the start.
   */
  const restoreLostGrants = async () => {
    let spaces;
    try {
      ({ spaces } = await listAll());
    } catch (error) {
      logger.warn?.(`[spaces] could not list the spaces to say their grants again: ${error?.code ?? error?.message ?? error}`);
      return;
    }
    for (const space of spaces) {
      if (space.state !== 'running' || busy.has(space.id)) continue;
      const record = records.read(space.id).record;
      const grants = (record?.grants ?? []).filter((grant) => grant.kind !== 'model' || grant.source.kind === 'env');
      if (grants.length === 0) continue;
      let held;
      try {
        held = new Set((await gatekeeper.readPolicy(space.id)).grants);
      } catch (error) {
        logger.warn?.(`[spaces] the gatekeeper of space ${space.id} did not say what it holds: ${error?.code ?? error?.message ?? error}`);
        continue;
      }
      const lost = grants.filter((grant) => !held.has(grant.id));
      if (lost.length === 0) continue;
      try {
        const { restored } = await exclusive(space.id, () => restoreGrants(space.id, lost, record.repository));
        if (restored.length > 0) logger.info?.(`[spaces] said the grants ${restored.join(', ')} of space ${space.id} again`);
      } catch (error) {
        logger.warn?.(`[spaces] the grants of space ${space.id} were not said again: ${error?.code ?? error?.message ?? error}`);
      }
    }
    onSpacesChanged();
  };

  /**
   * Which grants of the record a running gatekeeper holds now, read from the gatekeeper itself:
   * after a machine restart it holds none, and the space "needs access" (see "The gatekeeper" in DOCUMENTATION.md).
   * A gatekeeper that cannot be asked leaves the answer unknown, never "granted".
   */
  const readAccess = async (space, grants) => {
    // A start that is still saying the grants again, or a grant on its way, would read as
    // "needs access" for a moment; while an action holds the space the answer is not given.
    if (space.state !== 'running' || grants.length === 0 || busy.has(space.id)) return { access: null, needsAccess: [] };
    try {
      const held = new Set((await gatekeeper.readPolicy(space.id)).grants);
      const needsAccess = grants.filter((grant) => !held.has(grant.id)).map((grant) => grant.id);
      return { access: needsAccess.length === 0 ? 'granted' : 'needs_access', needsAccess };
    } catch (error) {
      logger.warn?.(`[spaces] the gatekeeper of space ${space.id} did not say what it holds: ${error?.code ?? error?.message ?? error}`);
      return { access: 'unknown', needsAccess: [] };
    }
  };

  /**
   * What is broken in a damaged space, for the group's status line: `gatekeeper_gone` when its
   * gatekeeper container no longer exists, which no start makes again (see "Lifecycle" in
   * DOCUMENTATION.md), and `repairable` for the rest, a gatekeeper that stopped while the space runs among
   * them, which the next start brings back. The place's list names the gatekeeper as missing in
   * both cases; its verification tells them apart, and is asked only for a space that is damaged
   * that way. A verification that cannot answer leaves it `repairable`, so the user is offered
   * the restart rather than told the space is lost on a guess.
   */
  const readDamage = async (space) => {
    if (!space.damaged) return null;
    if (!space.missing.includes(spaceResourceName(space.id, ROLE_GATEKEEPER))) return 'repairable';
    try {
      const violations = await manager.verify(space.id);
      return violations.some((violation) => violation.check === 'gatekeeper_missing') ? 'gatekeeper_gone' : 'repairable';
    } catch (error) {
      if (error instanceof SpaceError && error.code === 'gatekeeper_missing') return 'gatekeeper_gone';
      logger.warn?.(`[spaces] space ${space.id} could not be verified: ${error?.code ?? error?.message ?? error}`);
      return 'repairable';
    }
  };

  const describePending = (entry) => ({
    id: entry.id,
    name: entry.name,
    placeId: entry.placeId,
    machine: places.get(entry.placeId)?.machine ?? null,
    projectDirectory: entry.projectDirectory,
    directory: entry.directory,
    projectFolder: { path: entry.projectDirectory, found: null },
    created: entry.created,
    state: entry.state,
    stoppedIdle: false,
    step: entry.step,
    failure: entry.failure,
    network: entry.network,
    history: 'pending',
    // The client waits for the setup only when the host said it will run one; a host before 5d-4 never says so.
    setup: entry.setupTotal > 0 ? { state: 'queued', total: entry.setupTotal } : null,
    grants: [],
    accessFailures: [],
    access: null,
    needsAccess: [],
    damaged: false,
    damage: null,
    missing: [],
    orphans: [],
  });

  /**
   * Every space of this host: the place's list with what the host remembers about each, the
   * creations under way in their place, and the failed ones after it. A record the host cannot read leaves `network` null,
   * which the UI must show as "unknown" and never as "open". With `access` each running space
   * with grants is asked what its gatekeeper holds, one request per such space, so the list can
   * say "needs access"; without it `access` stays null.
   *
   * `projectFolder` names the folder the space was made for, from the record, so a space whose
   * project is no longer registered can still say where it came from; `found` says whether that
   * folder is there now, and is null while a creation is under way or when nothing names it.
   */
  const listSpaces = async ({ access = false } = {}) => {
    const [{ spaces, unavailable }, projects] = await Promise.all([listAll(), registeredProjects()]);
    // An unreachable space carries its place's failure, so the group can say why and whether a
    // delete would do anything: `place_not_found` forgets the record, any other failure removes nothing.
    const placeFailureOf = (placeId) => failureOf(unavailable.find((entry) => entry.placeId === placeId)?.failure);
    const listed = await Promise.all(spaces.map(async (space) => {
      const projectDirectory = projects.get(space.project) ?? null;
      const { record } = records.read(space.id);
      const grants = record?.grants ?? [];
      const projectPath = record?.repository ?? projectDirectory;
      // A record without a space path is a creation that a previous host did not live to finish:
      // the containers run, the code never arrived, and the user would otherwise send the agent
      // into an empty folder. It is listed as a failed creation, whose one way out is Remove; a
      // creation under way in this process is replaced by its own entry below.
      const codeNeverArrived = space.state !== 'unreachable' && record !== null && record.spacePath === null;
      return {
        id: space.id,
        name: space.name,
        placeId: space.placeId,
        // The machine of a Docker over SSH place, for the screens; null locally and for a place that is gone.
        machine: places.get(space.placeId)?.machine ?? null,
        projectDirectory,
        directory: projectDirectory === null ? null : spaceProjectPath(space.id, projectDirectory),
        projectFolder: { path: projectPath, found: projectPath === null ? null : await folderExists(projectPath) },
        created: space.created,
        state: codeNeverArrived ? 'failed' : space.state,
        stoppedIdle: space.stoppedIdle === true,
        step: codeNeverArrived ? 'failed' : null,
        failure: codeNeverArrived
          ? { code: 'space_code_never_arrived', message: 'OpenChamber closed before the code arrived. Delete the space and create it again.', details: null }
          : space.state === 'unreachable' ? placeFailureOf(space.placeId) : null,
        network: record?.network ?? null,
        history: record?.history ?? 'unknown',
        setup: setup.describe(space.id, record),
        grants: grants.map(describeGrant),
        accessFailures: creationAccessFailures.get(space.id) ?? [],
        ...(access ? await readAccess(space, grants) : { access: null, needsAccess: [] }),
        damaged: space.damaged,
        damage: await readDamage(space),
        missing: space.missing,
        orphans: space.orphans,
      };
    }));
    for (const space of spaces) {
      if (space.state === 'exited' && space.gatekeeperRunning === true && !pending.has(space.id)) stopStrayGatekeeper(space.id);
    }
    // A creation under way wins over the place's view of it: the containers run before the code is there.
    const waiting = new Map(Array.from(pending.values(), (entry) => [entry.id, describePending(entry)]));
    const merged = listed.map((space) => waiting.get(space.id) ?? space);
    const known = new Set(listed.map((space) => space.id));
    return [...merged, ...Array.from(waiting.values()).filter((entry) => !known.has(entry.id))];
  };

  /**
   * Stops the gatekeeper found running beside a stopped space: a space that stopped itself for the
   * idle stop leaves it running, because it cannot reach it (the maintainer's call of 2026-09-28).
   * It serves nobody then, and a key typed into it goes with it, as with a stop by hand. The place's
   * stop of a stopped space stops only what still runs. A space that another action holds is left
   * for the next look, since a start is what brings a gatekeeper up before its space; a start that
   * comes while this runs waits for it, rather than being refused as busy.
   */
  const stopStrayGatekeeper = (spaceId) => {
    if (busy.has(spaceId) || strayStops.has(spaceId)) return;
    const stopping = manager.stopSpace({ spaceId })
      .catch((error) => {
        logger.warn?.(`[spaces] the gatekeeper beside stopped space ${spaceId} still runs: ${error?.code ?? error?.message ?? error}`);
      })
      .finally(() => { strayStops.delete(spaceId); });
    strayStops.set(spaceId, stopping);
  };

  const requireListed = async (spaceId) => {
    const space = (await listSpaces()).find((entry) => entry.id === spaceId);
    if (!space) throw new SpaceError('space_not_found', `There is no space ${spaceId}`);
    return space;
  };

  /**
   * Starts a stopped space. Its gatekeeper comes up allowing nothing, so the network the user
   * chose is said again from the record; without a readable record the space stays closed, and
   * the answer says so with `networkRestored` false.
   */
  const startUnlocked = async (spaceId) => {
    // As for a creation: no start may slip in while the switch is stopping the spaces one by one.
    if (closing) throw new SpaceError('isolated_spaces_off', 'Isolated spaces are being turned off.');
    requireNotPending(spaceId);
    await strayStops.get(spaceId);
    await manager.startSpace({ spaceId });
    const { record } = records.read(spaceId);
    let networkRestored = false;
    let grants = { restored: [], needsAccess: [] };
    if (record) {
      await gatekeeper.setNetwork(spaceId, record.network);
      networkRestored = true;
      grants = await restoreGrants(spaceId, record.grants, record.repository);
      await rewriteProviderConfig(spaceId, record.grants, record.repository);
      if (record.grants.some((grant) => grant.kind === 'model' || grant.kind === 'login')) repairLoginRowInBackground(spaceId);
      // A history that never arrived, or that failed, is sent again: a stop right after the
      // creation is the usual way it fails, and the space would otherwise stay shallow for good.
      if ((record.history === 'pending' || record.history === 'failed') && record.repository && record.spacePath && record.base) {
        sendHistoryInBackground({ repository: record.repository, spaceId, spacePath: record.spacePath, base: record.base });
      }
    }
    await deliverIdleStop(spaceId);
    onSpacesChanged();
    return { ...(await requireListed(spaceId)), networkRestored, grantsRestored: grants.restored, needsAccess: grants.needsAccess };
  };
  const startSpace = (spaceId) => exclusive(spaceId, () => startUnlocked(spaceId));

  /**
   * Restarts the container of a running space, the second of the repair actions, and gives the
   * server inside a fresh token on the way (see "Dispatcher" in DOCUMENTATION.md): the new
   * token is written while the space runs, and the server reads it when it starts again. The
   * token is not a secret from the agent, so one that cannot be written is logged and the restart
   * goes on; the dispatcher reads the token again when the server inside refuses the old one.
   * A stop, then a start with the network and the grants said again, exactly as the two apart.
   */
  const restartSpace = (spaceId) => exclusive(spaceId, async () => {
    if (closing) throw new SpaceError('isolated_spaces_off', 'Isolated spaces are being turned off.');
    requireNotPending(spaceId);
    const space = await requireListed(spaceId);
    if (space.state !== 'running') throw new SpaceError('space_not_running', 'This space is stopped. Start it instead.');
    try {
      await serverInside.writeToken(spaceId, createSpaceToken());
    } catch (error) {
      logger.warn?.(`[spaces] the server inside space ${spaceId} keeps its token: ${error?.code ?? error?.message ?? error}`);
    }
    await manager.stopSpace({ spaceId });
    return startUnlocked(spaceId);
  });

  /**
   * Restarts OpenCode inside a running space, the softest of the repair actions: the server inside
   * restarts the OpenCode it manages and answers once it is ready again. The container, its
   * gatekeeper and the grants stay as they are.
   */
  const restartOpenCode = (spaceId) => exclusive(spaceId, async () => {
    requireNotPending(spaceId);
    const space = await requireListed(spaceId);
    if (space.state !== 'running') throw new SpaceError('space_not_running', 'OpenCode runs inside a running space. Start the space.');
    await restartOpenCodeInside(spaceId);
    onSpacesChanged();
    return requireListed(spaceId);
  });

  /**
   * Gives a running space a grant: the key goes to the gatekeeper, the grant without its value
   * goes to the record, and for a model grant OpenCode inside is told to send that provider's
   * calls through the window. A second grant for the same provider replaces the first, which is
   * how a key is changed; a grant is never taken back (decision 4). The value of a typed key is
   * in this request and in the gatekeeper's memory, and nowhere else afterwards. A login grant
   * reads the host's own login for the provider from its OpenCode: its short token goes to the
   * gatekeeper, and OpenCode inside gets a row naming the login's method, so that it sends the
   * requests that login's upstream wants (decision 13). The host's token is given as it is: one
   * that has already ended is refused, and one that ends later ends inside the space too.
   */
  /**
   * Gives a parsed grant request to a running space: the gatekeeper first, then the record, then
   * OpenCode's configuration inside. Answers the grant as the record keeps it. The grant dialog's
   * route and a creation both come here; each checks first that the space runs.
   */
  const giveGrant = async (spaceId, asked) => {
    const current = records.read(spaceId);
    if (current.status !== 'ok') throw new SpaceError('space_record_unreadable', 'The host\'s record of this space cannot be read, so a grant could not be remembered. Remove the space and create it again.');
      if (asked.kind === 'model' && !HEADER_BY_PROVIDER.has(asked.provider)) {
      throw new SpaceError('provider_not_supported', `A key for ${asked.provider} cannot be given through the network filter yet: it reads its key in a way the network filter does not know.`);
    }
    let grant;
    let window;
    let login = null;
    if (asked.kind === 'custom') {
      const definition = await hostProviders.read(asked.provider, current.record.repository);
      if (!definition) throw new SpaceError('provider_not_found', `${asked.provider} is not a provider of your own in Settings. Add it there, then grant.`);
      if (headerOfPackage(definition.package) === null) throw new SpaceError('provider_not_supported', `${definition.name} cannot be given through the network filter yet: its SDK reads a key in a way the network filter does not know.`);
      window = customWindowOf(definition);
      if (!window) throw new SpaceError('provider_not_supported', `${definition.name} has no http(s) address in Settings.`);
      grant = { kind: 'custom', id: asked.provider, provider: asked.provider };
    } else if (asked.kind === 'model') {
      const source = asked.secret.kind === 'typed' ? { kind: 'typed' } : { kind: 'env', name: asked.secret.name };
      const secret = asked.secret.kind === 'typed' ? asked.secret.value : readHostSecret(asked.secret.name);
      if (typeof secret !== 'string' || secret === '') {
        throw new SpaceError('secret_source_missing', `The environment variable ${asked.secret.name} is not set for OpenChamber, so there is no key to give.`);
      }
      grant = { kind: 'model', id: asked.provider, provider: asked.provider, upstream: asked.upstream, header: HEADER_BY_PROVIDER.get(asked.provider), source };
      window = { upstream: grant.upstream, header: grant.header, secret };
    } else if (asked.kind === 'login') {
      login = await readHostLogin(asked.provider);
      if (!login) throw new SpaceError('login_not_found', `OpenChamber is not signed in to ${asked.provider} on this computer. Sign in first, or give a key instead.`);
      window = loginWindowOf(asked.provider, login);
      if (!window) throw new SpaceError('login_not_supported', `The ${asked.provider} login on this computer was made in a way the network filter does not know (${login.methodID}).`);
      if (loginEnded(asked.provider, login, now().getTime())) throw new SpaceError('login_expired', `The ${asked.provider} login on this computer has run out and could not be renewed. Sign in to ${asked.provider} again, then grant.`);
      grant = { kind: 'login', id: asked.provider, provider: asked.provider, method: login.methodID };
    } else {
      grant = { kind: 'domain', id: `open-${crypto.randomBytes(6).toString('hex')}`, upstream: asked.upstream };
      window = { upstream: grant.upstream, header: null, secret: null };
    }
    // A key that replaces a login takes the login's row with it first, or OpenCode inside would
    // keep the login's headers and model list for requests the window now sends with the key; a
    // removal that fails answers the grant before anything changed.
    const replaced = current.record.grants.find((entry) => entry.id === grant.id);
    if (grant.kind !== 'login' && replaced?.kind === 'login') await spaceOpenCode.removeLogin(spaceId, grant.provider);
    await gatekeeper.addGrant(spaceId, { id: grant.id, ...window });
    const grants = [...current.record.grants.filter((entry) => entry.id !== grant.id), grant];
    if (records.update(spaceId, { grants }).status !== 'ok') {
      throw new SpaceError('space_record_unreadable', 'The grant reached the network filter and could not be remembered, so it is gone at the next start. Remove the space and create it again.');
    }
    // A failure here answers the grant with it; the key is in the gatekeeper and the record, and
    // the next start writes the configuration and the row again.
    if (configuresProvider(grant)) await spaceOpenCode.writeProviderConfig(spaceId, grants, await customDefinitionsOf(grants, current.record.repository));
    if (grant.kind === 'login') await spaceOpenCode.writeLogin(spaceId, grant.provider, login);
    return grant;
  };

  const grantAccess = async (spaceId, request) => {
    await afterRowRepair(spaceId);
    return grantUnlocked(spaceId, request);
  };
  const grantUnlocked = (spaceId, request) => exclusive(spaceId, async () => {
    requireNotPending(spaceId);
    const parsed = grantRequestSchema.safeParse(request ?? {});
    if (!parsed.success) throw new SpaceError('invalid_grant_request', 'A grant is a model key for a provider, typed or named by a host environment variable, the host\'s own login for a provider, or an opened domain.');
    const space = await requireListed(spaceId);
    if (space.state !== 'running') throw new SpaceError('space_not_running', 'A grant goes to the gatekeeper of a running space. Start the space, then grant.');
    const grant = await giveGrant(spaceId, parsed.data);
    const failures = (creationAccessFailures.get(spaceId) ?? []).filter((failure) => failure.provider !== grant.provider);
    if (failures.length > 0) creationAccessFailures.set(spaceId, failures);
    else creationAccessFailures.delete(spaceId);
    return { grant: describeGrant(grant) };
  });

  /**
   * Adds a domain to a running space's allowlist, live: the gatekeeper is told first, then the
   * record, so the next start says it again. A record that cannot be written after the gatekeeper
   * took the domain leaves it open until the next start, which closes it: the safe direction.
   * The name may come from the journal, which the agent wrote; what makes it a decision is the
   * user reading it and pressing "Open", and the name rule refuses anything that is not a name.
   */
  const openDomain = (spaceId, request) => exclusive(spaceId, async () => {
    requireNotPending(spaceId);
    const parsed = openDomainRequestSchema.safeParse(request ?? {});
    if (!parsed.success) throw new SpaceError('invalid_domain', 'A domain is a name such as registry.npmjs.org: letters, digits and hyphens, with a dot.');
    const { domain } = parsed.data;
    const space = await requireListed(spaceId);
    if (space.state !== 'running') throw new SpaceError('space_not_running', 'A domain is opened by the gatekeeper of a running space. Start the space, then open it.');
    const current = records.read(spaceId);
    if (current.status !== 'ok') throw new SpaceError('space_record_unreadable', 'The host\'s record of this space cannot be read, so an opened domain could not be remembered. Remove the space and create it again.');
    const { network } = current.record;
    if (network.mode === 'open') throw new SpaceError('network_is_open', 'The network of this space is open, so there is no list to add a domain to.');
    if (network.domains.includes(domain)) return { network };
    const next = networkSchema.safeParse({ mode: network.mode, domains: [...network.domains, domain] });
    if (!next.success) throw new SpaceError('too_many_domains', 'This space already has as many opened domains as a list holds.');
    await gatekeeper.setNetwork(spaceId, next.data);
    if (records.update(spaceId, { network: next.data }).status !== 'ok') {
      throw new SpaceError('space_record_unreadable', 'The domain is open now and could not be remembered, so it closes at the next start. Remove the space and create it again.');
    }
    return { network: next.data };
  });

  /**
   * Runs the project's setup commands again in a running space, from the "⋯" menu or after a run
   * that failed or was interrupted. The client resolves them as for a new space, trust included.
   * Answers the listed entry once the run began; the run goes on in the background.
   */
  const runSetup = (spaceId, request) => exclusive(spaceId, async () => {
    requireNotPending(spaceId);
    const parsed = setupRequestSchema.safeParse(request ?? {});
    if (!parsed.success) throw new SpaceError(...CREATE_REFUSALS.setupCommands);
    const space = await requireListed(spaceId);
    if (space.state !== 'running') throw new SpaceError('space_not_running', 'The setup commands run inside a running space. Start the space.');
    const { record } = records.read(spaceId);
    if (!record?.spacePath) throw new SpaceError('space_record_unreadable', 'The host\'s record of this space cannot be read, so it does not know where the project is inside. Remove the space and create it again.');
    setup.start(spaceId, { projectPath: record.spacePath, commands: parsed.data.commands });
    return requireListed(spaceId);
  });

  /** The setup as the list carries it, with the end of the failed command's output. */
  const readSetup = async (spaceId) => {
    const space = await requireListed(spaceId);
    return { setup: space.setup, output: setup.outputOf(records.read(spaceId).record) };
  };

  const stopSpace = (spaceId) => exclusive(spaceId, async () => {
    requireNotPending(spaceId);
    await manager.stopSpace({ spaceId });
    onSpacesChanged();
    return requireListed(spaceId);
  });

  /**
   * Saves the space's chats to the archive, starting a stopped one for it; a space that does not
   * start has no chats to give, which the archive reports as not saved. A space started only for
   * this, whose chats could not be saved, is stopped again, so the refused delete leaves it as it
   * was. Its gatekeeper allows nothing meanwhile: the network is not said again for a delete.
   * Null without an archive.
   */
  const saveChatsOf = async (space, allowUnsaved) => {
    if (!archiveChats) return null;
    let running = space.state === 'running';
    let started = false;
    if (!running && space.state === 'exited') {
      try {
        await manager.startSpace({ spaceId: space.id });
        running = true;
        started = true;
      } catch (error) {
        logger.warn?.(`[spaces] space ${space.id} did not start to give its chats: ${error?.code ?? error?.message ?? error}`);
      }
    }
    try {
      return await archiveChats({ spaceId: space.id, name: space.name, projectDirectory: space.projectDirectory ?? null, running, allowUnsaved });
    } catch (error) {
      if (started) {
        await manager.stopSpace({ spaceId: space.id }).catch((stopError) => {
          logger.warn?.(`[spaces] space ${space.id} started for its chats is still running: ${stopError?.code ?? stopError?.message ?? stopError}`);
        });
      }
      throw error;
    }
  };

  /**
   * Removes a space and everything the host kept for it: the containers, networks and volumes,
   * the service refs in the user's repository and the record. A failed creation is forgotten here.
   * Its chats go to the archive first (decision 9); when they cannot all be saved the space stays
   * and the answer is `chats_not_saved`, unless `allowUnsaved` says to save what can be and go on.
   */
  const removeUnlocked = async (spaceId, { allowUnsaved = false } = {}) => {
    const waiting = pending.get(spaceId);
    if (waiting) {
      if (waiting.state !== 'failed') throw new SpaceError('space_preparing', 'This space is still being made. Wait for it, then remove it.');
      pending.delete(spaceId);
      // A failed creation whose clean-up failed still has containers; those go now, or the space
      // comes back in the list as damaged. One that was cleaned up has nothing left to remove.
      const still = (await listAll()).spaces.some((space) => space.id === spaceId);
      if (!still) return { id: spaceId, removed: true, refsRemoved: null, failures: [], chats: null };
      return { id: spaceId, ...(await removeEverything(spaceId, waiting.projectDirectory)), chats: null };
    }
    const space = await requireListed(spaceId);
    // A creation that a previous host did not live to finish is a failed creation too: no chat
    // could have run in it, so nothing is saved and the archive is not asked.
    const chats = space.state === 'failed' ? null : await saveChatsOf(space, allowUnsaved);
    const { record } = records.read(spaceId);
    const outcome = await removeEverything(spaceId, record?.repository ?? space.projectDirectory);
    onSpacesChanged();
    return { id: spaceId, ...outcome, chats };
  };
  const removeSpace = (spaceId, options) => exclusive(spaceId, () => removeUnlocked(spaceId, options));

  /**
   * Stops every running space, for the switch being turned off. Each space is tried on its own:
   * one that could not be stopped is reported as still running, never counted as stopped. When
   * the place cannot even list them, Docker being down among the reasons, the turn-off still goes
   * through and says so in `unknown`: the switch must stay reachable, and what runs cannot be
   * stopped from here either way (decision 18).
   */
  const stopAllSpaces = async () => {
    const preparing = Array.from(pending.values()).filter((entry) => entry.state === 'preparing');
    if (preparing.length > 0) throw new SpaceError('space_preparing', `${preparing.length === 1 ? 'A space is' : `${preparing.length} spaces are`} still being made. Wait for that to finish first.`, { spaces: preparing.map((entry) => entry.id) });
    closing = true;
    let spaces;
    let unavailable;
    try {
      ({ spaces, unavailable } = await listAll());
    } catch (error) {
      logger.warn?.(`[spaces] turning off without knowing which spaces run: ${error?.code ?? error?.message ?? error}`);
      return { stopped: [], stillRunning: [], unknown: failureOf(error) };
    }
    const stopped = [];
    const stillRunning = [];
    for (const space of spaces) {
      // A space on a place that cannot be asked may well run, and nothing from here stops it.
      if (space.state === 'unreachable') {
        const failure = unavailable.find((entry) => entry.placeId === space.placeId)?.failure;
        stillRunning.push({ id: space.id, name: space.name, ...failureOf(failure) });
        continue;
      }
      if (space.state !== 'running') {
        // A gatekeeper left by an idle stop goes too, and the space is not counted: it was stopped.
        if (space.gatekeeperRunning === true && !busy.has(space.id)) await manager.stopSpace({ spaceId: space.id }).catch(() => {});
        continue;
      }
      try {
        await manager.stopSpace({ spaceId: space.id });
        stopped.push({ id: space.id, name: space.name });
      } catch (error) {
        stillRunning.push({ id: space.id, name: space.name, ...failureOf(error) });
      }
    }
    // A place that could not be asked may run spaces the host does not remember: the answer says so.
    return unavailable.length === 0 ? { stopped, stillRunning } : { stopped, stillRunning, unknown: failureOf(unavailable[0].failure) };
  };

  /** The user's idle stop setting, as the settings screen shows it. */
  const readIdleStopSetting = () => readIdleStop();

  /**
   * Keeps a new idle stop setting and tells every running space, one change after the other. A
   * space that cannot be told keeps its old setting until its next start, which says the new one;
   * a stopped space hears it at its start. Answers the setting as kept.
   */
  const changeIdleStop = (request) => {
    const parsed = idleStopSchema.safeParse(request ?? {});
    if (!parsed.success) return Promise.reject(new SpaceError('invalid_idle_stop', 'The idle stop is on or off, with a whole number of hours from 1 to 168.'));
    const setting = parsed.data;
    const change = idleStopTurn.then(async () => {
      await saveIdleStop(setting);
      const { spaces } = await listAll();
      for (const space of spaces) {
        if (space.state === 'running' && !pending.has(space.id)) await writeIdleStop(space.id, setting);
      }
      return setting;
    });
    idleStopTurn = change.catch(() => {});
    return change;
  };

  /** The disk the spaces take on a place, and what a clean-up would free now (journey step 9). */
  const readDisk = async (placeId) => requirePlace(placeId).readDisk();

  /**
   * Removes what OpenChamber can make again on a place, see `places/docker-disk.js`; Docker keeps
   * whatever is in use. Refused while a space is being made, which pulls the image and fills the
   * tools before any container holds them. Answers what was freed, what Docker kept, and the disk after.
   */
  const cleanUpDisk = async (placeId) => {
    const place = requirePlace(placeId);
    if (Array.from(pending.values()).some((entry) => entry.state === 'preparing')) {
      throw new SpaceError('space_preparing', 'A space is being made. Clean up when it is ready.');
    }
    if (place.imagePulling()) {
      throw new SpaceError('image_pulling', 'The image is being downloaded. Clean up when it is done.');
    }
    const { freedBytes, kept, machine } = await place.cleanUpDisk();
    for (const item of kept.filter((entry) => entry.reason === 'failed')) {
      logger.warn?.(`[spaces] clean-up could not remove ${item.kind} ${item.name}: ${item.message}`);
    }
    if (machine.state === 'failed') logger.warn?.(`[spaces] the Colima machine did not trim its disk: ${machine.message}`);
    if (machine.state === 'trimmed') logger.info?.('[spaces] the Colima machine trimmed its disk after a clean-up');
    return { freedBytes, kept: kept.map(({ kind, reason }) => ({ kind, reason })), disk: await place.readDisk() };
  };

  /**
   * Downloads the base image on a place ahead of the first space (journey step 0), so no create
   * dialog waits for it. The place runs one download at a time and a creation under way shares it.
   * Answers the disk at once, `imagePulling` set; the page reads the disk again until it is not,
   * and `imageFailure` says why the image is still absent after a download that failed.
   */
  const pullImage = async (placeId) => {
    const place = requirePlace(placeId);
    place.pullImage().catch((error) => { logger.warn?.(`[spaces] the image download failed: ${error.code ?? error.message}`); });
    return place.readDisk();
  };

  /** For a turn-off that did not go through after the spaces were stopped: creations are taken again. */
  const reopen = () => { closing = false; };

  /** Whether no creation and no action is under way: a host may be replaced only then, since both live in its memory. */
  const isIdle = () => busy.size === 0 && Array.from(pending.values()).every((entry) => entry.state !== 'preparing');

  /** What the gatekeeper allowed and refused since it last started; a stopped space has no journal. */
  const readJournal = (spaceId) => exclusive(spaceId, async () => {
    const space = await requireListed(spaceId);
    if (space.state !== 'running') {
      throw new SpaceError('space_not_running', 'The journal lives in the memory of the space\'s gatekeeper and is gone with a stop. Start the space to record new attempts.');
    }
    return gatekeeper.readJournal(spaceId);
  });

  const requireRepository = async (spaceId) => {
    requireNotPending(spaceId);
    const space = await requireListed(spaceId);
    const { record } = records.read(spaceId);
    const repository = record?.repository ?? space.projectDirectory;
    if (!repository) throw new SpaceError('project_not_registered', 'The project this space was made for is no longer registered, so its work has nowhere to go.');
    // Code out reaches into the space, so a stopped one would fail there as a generic failure of
    // the place; the dialog needs to know it can offer a start instead.
    if (space.state !== 'running') throw new SpaceError('space_not_running', 'The space is stopped. Start it to apply its work.');
    return { space, repository, spacePath: record?.spacePath ?? space.directory };
  };

  /** Brings the work out and describes what an apply would do, for the apply dialog. */
  const previewApply = (spaceId) => exclusive(spaceId, async () => {
    const { repository, spacePath } = await requireRepository(spaceId);
    const brought = await codeOut.bringCodeOut({ repository, spaceId, spacePath });
    const state = await codeOut.describeApplyState({ repository, spaceId });
    return { ...brought, ...state };
  });

  /**
   * Brings the work out once more and applies it as a branch or as uncommitted changes. What is
   * applied is what this call fetched, whatever a preview showed. With `removeAfterwards` the
   * space goes once the apply went through, and only then; when its chats cannot all be saved it
   * stays, and `kept` says why, because the work is applied either way.
   */
  const applySpace = (spaceId, request) => exclusive(spaceId, async () => {
    const parsed = applyRequestSchema.safeParse(request ?? {});
    if (!parsed.success) throw new SpaceError('invalid_apply_request', 'The work is applied as a branch, with its name, or as uncommitted changes.');
    const { as, removeAfterwards } = parsed.data;
    const branch = as === 'branch' ? parsed.data.branch : null;
    const { repository, spacePath } = await requireRepository(spaceId);
    const brought = await codeOut.bringCodeOut({ repository, spaceId, spacePath });
    const applied = as === 'branch'
      ? { status: 'applied', ...(await codeOut.applyAsBranch({ repository, spaceId, branch })) }
      : await codeOut.applyAsChanges({ repository, spaceId });
    let removal = null;
    let kept = null;
    if (removeAfterwards && applied.status === 'applied') {
      try {
        removal = await removeUnlocked(spaceId);
      } catch (error) {
        if (error?.code !== 'chats_not_saved') throw error;
        kept = failureOf(error);
      }
    }
    return { brought, applied, removal, kept };
  });

  return { createSpace, listSpaces, startSpace, stopSpace, restartSpace, restartOpenCode, removeSpace, stopAllSpaces, reopen, isIdle, grantAccess, sayLogin, readHostLogins, readHostCustomProviders, openDomain, restoreLostGrants, readJournal, previewApply, applySpace, readIdleStopSetting, changeIdleStop, runSetup, readSetup, readDisk, cleanUpDisk, pullImage };
}
