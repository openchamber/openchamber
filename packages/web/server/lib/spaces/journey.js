
import crypto from 'node:crypto';
import fsPromises from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import { SpaceError } from './errors.js';
import { DEFAULT_IDLE_STOP, idleStopSchema } from './idle-stop.js';
import { headerOfProvider, windowUpstreamOf } from './host-providers.js';
import { createModelGrants, isProviderKnownByName } from './model-grants.js';
import { permissionDefaultOf } from './space-permission-default.js';
import { ROLE_GATEKEEPER, createSpaceId, hashProjectDirectory, spaceResourceName } from './labels.js';
import { spaceProjectPath, spaceWindowUrl } from './layout.js';
import { LOGIN_PROVIDERS, buildStartConfig, loginEndOf, loginEnded, loginGrantOf } from './space-opencode.js';
import { domainSchema, grantSchema, networkSchema, providerIdSchema, secretSourceSchema } from './space-records.js';
import { createSpaceToken } from './space-server.js';
import { createSpaceSetup, setupCommandsSchema } from './space-setup.js';

const createRequestSchema = z.object({
  placeId: z.string().min(1).optional(),
  projectDirectory: z.string().min(1),
  name: z.string().trim().min(1),
  start: z.enum(['clean', 'uncommitted']).default('uncommitted'),
  network: networkSchema.default({ mode: 'allowlist', domains: [] }),
  setupCommands: setupCommandsSchema.default([]),
  grants: z.lazy(() => creationGrantsSchema).default([]),
});
const withUpperDrive = (directory) => directory.replace(/^[a-z]:/, (drive) => drive.toUpperCase());

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
const MAX_SECRET_LENGTH = 8192;
const grantRequestSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('model'),
    provider: grantSchema.options[0].shape.provider,
    upstream: grantSchema.options[0].shape.upstream.optional(),
    secret: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('typed'), value: z.string().min(1).max(MAX_SECRET_LENGTH) }).strict(),
      secretSourceSchema.options[0],
      z.object({ kind: z.literal('stored') }).strict(),
    ]),
  }).strict(),
  z.object({ kind: z.literal('domain'), upstream: grantSchema.options[1].shape.upstream }).strict(),
  z.object({ kind: z.literal('login'), provider: providerIdSchema }).strict(),
  z.object({ kind: z.literal('custom'), provider: providerIdSchema }).strict(),
]);
const MAX_CREATION_GRANTS = 16;
const creationGrantsSchema = z.array(z.discriminatedUnion('kind', [
  grantRequestSchema.options[0],
  grantRequestSchema.options[2],
  grantRequestSchema.options[3],
])).max(MAX_CREATION_GRANTS);

const openDomainRequestSchema = z.object({
  domain: z.string().trim().toLowerCase().pipe(domainSchema),
}).strict();

const applyRequestSchema = z.discriminatedUnion('as', [
  z.object({ as: z.literal('branch'), branch: z.string(), removeAfterwards: z.boolean().default(false) }),
  z.object({ as: z.literal('changes'), removeAfterwards: z.boolean().default(false) }),
]);

const REPAIR_BUSY_ATTEMPTS = 40;
const REPAIR_BUSY_PAUSE_MS = 250;
const pause = (milliseconds) => new Promise((resolve) => { setTimeout(resolve, milliseconds); });

const failureOf = (error) => ({
  code: error instanceof SpaceError ? error.code : 'space_journey_failed',
  message: error?.message ?? String(error),
  details: error instanceof SpaceError ? error.details ?? null : null,
});

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
  hostCatalog = { read: async () => null, list: async () => [], readStoredKey: async () => null },
  readIdleStop = async () => ({ ...DEFAULT_IDLE_STOP }),
  saveIdleStop = async () => {},
  readPermissionDefault = async () => permissionDefaultOf(null),
  folderExists = async (directory) => (await fsPromises.stat(directory).catch(() => null))?.isDirectory() === true,
  resolveDirectory = path.resolve,
  announce = () => {},
  onSpacesChanged = () => {},
  logger = console,
  now = () => new Date(),
}) {
  const modelGrants = createModelGrants({ hostCatalog, readHostSecret });
  const pending = new Map();
  const creationAccessFailures = new Map();
  const busy = new Set();
  let closing = false;
  let settingsTurn = Promise.resolve();
  const strayStops = new Map();
  const rowRepairs = new Map();
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

  const requireRegisteredProject = async (directory) => {
    const resolved = withUpperDrive(resolveDirectory(directory));
    const registered = (await listProjectDirectories()).find((candidate) => withUpperDrive(candidate) === resolved);
    if (registered === undefined) throw new SpaceError(...CREATE_REFUSALS.projectDirectory);
    return registered;
  };

  const progress = (entry, step, failure = null) => {
    entry.step = step;
    entry.state = step === 'failed' ? 'failed' : step === 'ready' ? 'running' : 'preparing';
    entry.failure = failure;
    announce(entry.id, { type: 'openchamber:space-progress', properties: { spaceId: entry.id, step, failure, timestamp: now().getTime() } });
  };

  const removeEverything = async (spaceId, repository) => {
    creationAccessFailures.delete(spaceId);
    const outcome = { removed: false, refsRemoved: null, failures: [] };
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

  const writeIdleStop = async (spaceId, setting) => {
    try {
      await serverInside.writeIdleStop(spaceId, setting);
    } catch (error) {
      logger.warn?.(`[spaces] space ${spaceId} keeps its idle stop setting: ${error?.code ?? error?.message ?? error}`);
    }
  };

  const writePermissionDefault = async (spaceId, setting) => {
    try {
      await serverInside.writePermissionDefault(spaceId, setting);
    } catch (error) {
      logger.warn?.(`[spaces] space ${spaceId} keeps its default permission mode: ${error?.code ?? error?.message ?? error}`);
    }
  };

  const deliverSettings = (spaceId) => {
    const delivery = settingsTurn.then(async () => {
      await writeIdleStop(spaceId, await readIdleStop());
      await writePermissionDefault(spaceId, await readPermissionDefault());
      await deliverUserTaskTitle(spaceId);
    });
    settingsTurn = delivery.catch(() => {});
    return delivery.catch((error) => {
      logger.warn?.(`[spaces] space ${spaceId} keeps its settings: ${error?.code ?? error?.message ?? error}`);
    });
  };

  const deliverUserTaskTitle = async (spaceId) => {
    const taskTitle = records.read(spaceId).record?.taskTitle;
    try {
      await serverInside.writeUserTaskTitle(spaceId, { title: taskTitle?.by === 'user' ? taskTitle.title : '' });
    } catch (error) {
      logger.warn?.(`[spaces] space ${spaceId} keeps its copy of the user task title: ${error?.code ?? error?.message ?? error}`);
    }
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
      const startConfig = buildStartConfig([...(await customDefinitionsOf(grants, projectDirectory)).keys()]);
      await manager.createSpace({ id: entry.id, placeId, projectDirectory, name, onStep: (step) => progress(entry, step), startConfig });
      created = true;
      records.write(entry.id, { placeId, name: entry.name, created: entry.created, network, repository: projectDirectory });
      progress(entry, 'setting_network');
      await gatekeeper.setNetwork(entry.id, network);
      progress(entry, 'bringing_code');
      const arrived = await codeIn.bringCodeIn({ repository: projectDirectory, spaceId: entry.id, mode: start });
      records.update(entry.id, { spacePath: arrived.spacePath, base: arrived.base });
      entry.identityCopied = arrived.identityCopied;
      await deliverSettings(entry.id);
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

  const describeGrant = (grant) => ({ ...grant, url: spaceWindowUrl(grant.id) });

  const configuresProvider = (grant) => grant.kind === 'model' || grant.kind === 'login' || grant.kind === 'custom';

  const customWindowOf = (definition) => {
    if (!definition) return null;
    const upstream = definition.baseURL === null ? null : windowUpstreamOf(definition.baseURL);
    const header = headerOfProvider(definition);
    if (upstream === null || header === null) return null;
    const window = definition.key === null ? { upstream, header: null, secret: null } : { upstream, header, secret: definition.key };
    if (Object.keys(definition.headers).length > 0) window.headers = definition.headers;
    return window;
  };

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

  const writeProviderConfig = async (spaceId, grants, repository) => {
    const catalog = await modelGrants.catalogDefinitionsOf(grants, repository);
    await spaceOpenCode.writeProviderConfig(spaceId, grants, await customDefinitionsOf(grants, repository), catalog);
  };

  const deliverGrant = async (spaceId, grant, login = null, repository = null) => {
    let secret = null;
    let upstream = grant.kind === 'login' || grant.kind === 'custom' ? null : grant.upstream;
    let header = grant.kind === 'model' ? grant.header : null;
    let headers;
    if (grant.kind === 'model') {
      if (grant.source.kind === 'typed') return false;
      secret = await modelGrants.secretOf(grant.source);
      if (typeof secret !== 'string' || secret === '') return false;
      headers = (await modelGrants.catalogHeadersFor(grant, repository)) ?? undefined;
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

  const rewriteProviderConfig = async (spaceId, grants, repository) => {
    if (!grants.some((grant) => configuresProvider(grant))) return;
    try {
      await writeProviderConfig(spaceId, grants, repository);
    } catch (error) {
      logger.warn?.(`[spaces] the provider configuration of space ${spaceId} was not written again: ${error?.code ?? error?.message ?? error}`);
    }
  };

  const usableHostLogin = async (grant) => {
    const login = await readHostLogin(grant.provider).catch(() => null);
    if (!login || login.methodID !== grant.method || loginEnded(grant.provider, login, now().getTime())) return null;
    return login;
  };

  const restoreGrants = async (spaceId, grants, repository) => {
    const restored = [];
    const needsAccess = [];
    for (const grant of grants) {
      const login = grant.kind === 'login' ? await usableHostLogin(grant) : null;
      (await deliverGrant(spaceId, grant, login, repository) ? restored : needsAccess).push(grant.id);
    }
    return { restored, needsAccess };
  };

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

  const readHostCustomProviders = async (directory) => {
    const providers = (await hostProviders.list(directory)).filter((provider) => !isProviderKnownByName(provider.id) && !LOGIN_PROVIDERS.includes(provider.id));
    return { providers };
  };

  const afterRowRepair = (spaceId) => (rowRepairs.get(spaceId) ?? Promise.resolve()).catch(() => {});

  const sayLogin = async (spaceId, grant, login) => {
    if (busy.has(spaceId)) return null;
    return deliverGrant(spaceId, grant, login);
  };

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
      const grants = (record?.grants ?? []).filter((grant) => grant.kind !== 'model' || grant.source.kind !== 'typed');
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

  const readAccess = async (space, grants) => {
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
    taskTitle: records.read(entry.id).record?.taskTitle ?? null,
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

  const listSpaces = async ({ access = false } = {}) => {
    const [{ spaces, unavailable }, projects] = await Promise.all([listAll(), registeredProjects()]);
    const placeFailureOf = (placeId) => failureOf(unavailable.find((entry) => entry.placeId === placeId)?.failure);
    const listed = await Promise.all(spaces.map(async (space) => {
      const projectDirectory = projects.get(space.project) ?? null;
      const { record } = records.read(space.id);
      const grants = record?.grants ?? [];
      const projectPath = record?.repository ?? projectDirectory;
      const codeNeverArrived = space.state !== 'unreachable' && record !== null && record.spacePath === null;
      return {
        id: space.id,
        name: space.name,
        taskTitle: record?.taskTitle ?? null,
        placeId: space.placeId,
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
    const waiting = new Map(Array.from(pending.values(), (entry) => [entry.id, describePending(entry)]));
    const merged = listed.map((space) => waiting.get(space.id) ?? space);
    const known = new Set(listed.map((space) => space.id));
    return [...merged, ...Array.from(waiting.values()).filter((entry) => !known.has(entry.id))];
  };

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

  const setTaskTitle = async (spaceId, title) => {
    const space = await requireListed(spaceId);
    const result = records.setTaskTitle(spaceId, { title, by: 'user' });
    announce(spaceId, { type: 'openchamber:space-task-title.updated', properties: { spaceId, taskTitle: result.taskTitle } });
    if (space.state === 'running') {
      const delivery = settingsTurn.then(() => deliverUserTaskTitle(spaceId));
      settingsTurn = delivery.catch(() => {});
      await delivery;
    }
    return result;
  };

  const startUnlocked = async (spaceId) => {
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
      if ((record.history === 'pending' || record.history === 'failed') && record.repository && record.spacePath && record.base) {
        sendHistoryInBackground({ repository: record.repository, spaceId, spacePath: record.spacePath, base: record.base });
      }
    }
    await deliverSettings(spaceId);
    onSpacesChanged();
    return { ...(await requireListed(spaceId)), networkRestored, grantsRestored: grants.restored, needsAccess: grants.needsAccess };
  };
  const startSpace = (spaceId) => exclusive(spaceId, () => startUnlocked(spaceId));

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

  const restartOpenCode = (spaceId) => exclusive(spaceId, async () => {
    requireNotPending(spaceId);
    const space = await requireListed(spaceId);
    if (space.state !== 'running') throw new SpaceError('space_not_running', 'OpenCode runs inside a running space. Start the space.');
    await restartOpenCodeInside(spaceId);
    await deliverUserTaskTitle(spaceId);
    onSpacesChanged();
    return requireListed(spaceId);
  });

  const giveGrant = async (spaceId, asked) => {
    const current = records.read(spaceId);
    if (current.status !== 'ok') throw new SpaceError('space_record_unreadable', 'The host\'s record of this space cannot be read, so a grant could not be remembered. Remove the space and create it again.');
    let grant;
    let window;
    let login = null;
    if (asked.kind === 'custom') {
      const definition = await hostProviders.read(asked.provider, current.record.repository);
      if (!definition) throw new SpaceError('provider_not_found', `${asked.provider} is not a provider of your own in Settings. Add it there, then grant.`);
      if (headerOfProvider(definition) === null) throw new SpaceError('provider_not_supported', `${definition.name} cannot be given through the network filter yet: its SDK, or a model's own SDK, reads a key in a way the network filter does not know.`);
      window = customWindowOf(definition);
      if (!window) throw new SpaceError('provider_not_supported', `${definition.name} has no http(s) address in Settings.`);
      grant = { kind: 'custom', id: asked.provider, provider: asked.provider };
    } else if (asked.kind === 'model') {
      ({ grant, window } = await modelGrants.modelGrantOf(asked, current.record.repository));
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
    const replaced = current.record.grants.find((entry) => entry.id === grant.id);
    if (grant.kind !== 'login' && replaced?.kind === 'login') await spaceOpenCode.removeLogin(spaceId, grant.provider);
    await gatekeeper.addGrant(spaceId, { id: grant.id, ...window });
    const grants = [...current.record.grants.filter((entry) => entry.id !== grant.id), grant];
    if (records.update(spaceId, { grants }).status !== 'ok') {
      throw new SpaceError('space_record_unreadable', 'The grant reached the network filter and could not be remembered, so it is gone at the next start. Remove the space and create it again.');
    }
    if (configuresProvider(grant)) await writeProviderConfig(spaceId, grants, current.record.repository);
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

  const removeAndForget = async (spaceId, { allowUnsaved = false } = {}) => {
    const waiting = pending.get(spaceId);
    if (waiting) {
      if (waiting.state !== 'failed') throw new SpaceError('space_preparing', 'This space is still being made. Wait for it, then remove it.');
      pending.delete(spaceId);
      const still = (await listAll()).spaces.some((space) => space.id === spaceId);
      if (!still) return { id: spaceId, removed: true, refsRemoved: null, failures: [], chats: null };
      return { id: spaceId, ...(await removeEverything(spaceId, waiting.projectDirectory)), chats: null };
    }
    const space = await requireListed(spaceId);
    const chats = space.state === 'failed' ? null : await saveChatsOf(space, allowUnsaved);
    const { record } = records.read(spaceId);
    const outcome = await removeEverything(spaceId, record?.repository ?? space.projectDirectory);
    onSpacesChanged();
    return { id: spaceId, ...outcome, chats };
  };
  const removeUnlocked = (spaceId, options) => removeAndForget(spaceId, options).then((outcome) => { if (outcome.removed) announce(spaceId, { type: 'openchamber:space-progress', properties: { spaceId, step: 'removed', failure: null, timestamp: now().getTime() } }); return outcome; });
  const removeSpace = (spaceId, options) => exclusive(spaceId, () => removeUnlocked(spaceId, options));

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
      if (space.state === 'unreachable') {
        const failure = unavailable.find((entry) => entry.placeId === space.placeId)?.failure;
        stillRunning.push({ id: space.id, name: space.name, ...failureOf(failure) });
        continue;
      }
      if (space.state !== 'running') {
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
    return unavailable.length === 0 ? { stopped, stillRunning } : { stopped, stillRunning, unknown: failureOf(unavailable[0].failure) };
  };

  const readIdleStopSetting = () => readIdleStop();

  const changeIdleStop = (request) => {
    const parsed = idleStopSchema.safeParse(request ?? {});
    if (!parsed.success) return Promise.reject(new SpaceError('invalid_idle_stop', 'The idle stop is on or off, with a whole number of hours from 1 to 168.'));
    const setting = parsed.data;
    const change = settingsTurn.then(async () => {
      await saveIdleStop(setting);
      await tellRunningSpaces((spaceId) => writeIdleStop(spaceId, setting));
      return setting;
    });
    settingsTurn = change.catch(() => {});
    return change;
  };

  const tellRunningSpaces = async (write) => {
    const { spaces } = await listAll();
    for (const space of spaces) {
      if (space.state === 'running' && !pending.has(space.id)) await write(space.id);
    }
  };

  const changePermissionDefault = (value) => {
    const setting = permissionDefaultOf(value);
    const change = settingsTurn.then(() => tellRunningSpaces((spaceId) => writePermissionDefault(spaceId, setting)));
    settingsTurn = change.catch(() => {});
    return change;
  };

  const readDisk = async (placeId) => requirePlace(placeId).readDisk();

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

  const pullImage = async (placeId) => {
    const place = requirePlace(placeId);
    place.pullImage().catch((error) => { logger.warn?.(`[spaces] the image download failed: ${error.code ?? error.message}`); });
    return place.readDisk();
  };

  const reopen = () => { closing = false; };

  const isIdle = () => busy.size === 0 && Array.from(pending.values()).every((entry) => entry.state !== 'preparing');

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
    if (space.state !== 'running') throw new SpaceError('space_not_running', 'The space is stopped. Start it to apply its work.');
    return { space, repository, spacePath: record?.spacePath ?? space.directory };
  };

  const previewApply = (spaceId) => exclusive(spaceId, async () => {
    const { repository, spacePath } = await requireRepository(spaceId);
    const brought = await codeOut.bringCodeOut({ repository, spaceId, spacePath });
    const state = await codeOut.describeApplyState({ repository, spaceId });
    return { ...brought, ...state };
  });

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

  return { createSpace, listSpaces, setTaskTitle, startSpace, stopSpace, restartSpace, restartOpenCode, removeSpace, stopAllSpaces, reopen, isIdle, grantAccess, sayLogin, readHostLogins, readHostCustomProviders, readHostCatalogProviders: modelGrants.listCatalogProviders, openDomain, restoreLostGrants, readJournal, previewApply, applySpace, readIdleStopSetting, changeIdleStop, changePermissionDefault, runSetup, readSetup, readDisk, cleanUpDisk, pullImage };
}
