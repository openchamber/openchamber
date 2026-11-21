
import { z } from 'zod';

import { SpaceError } from './errors.js';
import { isSpaceId } from './labels.js';
import { DOCKER_SSH_PLACE_ID } from './places/docker.js';
import { DOCKER_SETUP_ACTIONS } from './places/docker-setup.js';
import { sshHostSchema } from './places/ssh-host.js';
import type { createSpacesHost } from './host.js';
import type { createSpaceJourney } from './journey.js';
import type { createSpaceArchive } from './space-archive.js';
import type { createDockerPlace } from './places/docker.js';
import type { createDockerSetup } from './places/docker-setup.js';
import { failureProperty } from './failure.js';
import { transferValue as requiredValue } from './code-transfer.js';

type SpacesHost = ReturnType<typeof createSpacesHost>;
type Journey = ReturnType<typeof createSpaceJourney>;
interface Request {
  params: Record<string, string | string[] | undefined>;
  query?: { directory?: unknown; unsavedChats?: unknown };
  body?: unknown;
}
interface Response {
  status: (code: number) => Response;
  json: <Body>(body: Body) => void;
}
type RouteHandler = (req: Request, res: Response) => void | Promise<void>;
type RouteApp = Record<'get' | 'put' | 'post' | 'delete', (path: string, handler: RouteHandler) => void>;
type TurnResult = Awaited<ReturnType<typeof describeSshPlace>> | ({ enabled: boolean } & Awaited<ReturnType<Journey['stopAllSpaces']>>);
interface SwitchOptions {
  getHost: () => SpacesHost | null;
  setHost: (host: SpacesHost | null) => void;
  buildHost: () => Promise<SpacesHost>;
  startHost: (host: SpacesHost) => void;
  persist: (enabled: boolean) => Promise<void | object>;
  persistMachine?: (machine: string) => Promise<void | object>;
}
interface RouteOptions {
  getJourney: () => Journey | null;
  getPlaces?: () => ReturnType<typeof createDockerPlace>[];
  getDockerSetup?: () => { placeId: string; setup: ReturnType<typeof createDockerSetup> } | null;
  readSwitch: ReturnType<typeof createSwitchController>['readSwitch'];
  setSwitch: ReturnType<typeof createSwitchController>['setSwitch'];
  setMachine?: ReturnType<typeof createSwitchController>['setMachine'];
  getArchive?: () => ReturnType<typeof createSpaceArchive> | null;
}

export const SPACES_ROUTE = '/api/openchamber/spaces';

const directoryQuerySchema = z.string().min(1);

const STATUS_BY_CODE = new Map([
  ['space_not_found', 404],
  ['place_not_found', 404],
  ['project_not_registered', 400],
  ['invalid_space_name', 400],
  ['invalid_project_directory', 400],
  ['invalid_snapshot_mode', 400],
  ['invalid_network', 400],
  ['invalid_apply_request', 400],
  ['invalid_branch_name', 400],
  ['invalid_space_id', 400],
  ['invalid_request_body', 400],
  ['invalid_grant_request', 400],
  ['provider_not_supported', 400],
  ['provider_not_found', 404],
  ['invalid_domain', 400],
  ['invalid_idle_stop', 400],
  ['network_is_open', 409],
  ['too_many_domains', 409],
  ['secret_source_missing', 409],
  ['stored_key_missing', 409],
  ['host_catalog_unreadable', 502],
  ['login_not_found', 409],
  ['login_not_supported', 409],
  ['login_expired', 409],
  ['space_record_unreadable', 409],
  ['space_preparing', 409],
  ['space_creation_failed', 409],
  ['space_busy', 409],
  ['image_pulling', 409],
  ['docker_setup_running', 409],
  ['docker_setup_not_offered', 409],
  ['isolated_spaces_off', 404],
  ['space_not_running', 409],
  ['branch_exists', 409],
  ['changes_do_not_apply', 409],
  ['changes_route_closed', 409],
  ['changes_partly_applied', 409],
  ['changes_undecided', 409],
  ['changes_too_large', 409],
  ['changes_blocked_by_link', 409],
  ['name_not_allowed_here', 409],
  ['case_only_rename', 409],
  ['patch_not_possible', 409],
  ['nothing_to_apply', 409],
  ['place_cannot_restrict_network', 409],
  ['space_remove_incomplete', 502],
  ['gatekeeper_missing', 409],
  ['invalid_setup_commands', 400],
  ['space_setup_running', 409],
  ['chats_not_saved', 409],
  ['invalid_machine', 400],
  ['place_has_spaces', 409],
]);

export const answerFailure = (res: Response, cause: unknown) => {
  if (cause instanceof SpaceError) {
    res.status(STATUS_BY_CODE.get(cause.code) ?? 502).json({ code: cause.code, message: cause.message, details: cause.details ?? null });
    return;
  }
  res.status(500).json({ code: 'space_journey_failed', message: failureProperty(cause, 'message') ?? String(cause), details: null });
};

const isObjectRecord = (value: unknown): value is object => value instanceof Object && !Array.isArray(value);
const switchBodySchema = z.object({ enabled: z.boolean() });
const machineBodySchema = z.object({ machine: z.string() });
const dockerSetupBodySchema = z.object({ action: z.enum(DOCKER_SETUP_ACTIONS) });

const describeSshPlace = async (host: SpacesHost) => {
  const place = host.places().find((candidate) => candidate.id === DOCKER_SSH_PLACE_ID);
  return place ? { id: place.id, machine: place.machine, ...(await place.check()) } : null;
};

export function createSwitchController({ getHost, setHost, buildHost, startHost, persist, persistMachine = async () => {} }: SwitchOptions) {
  let turning: Promise<void | TurnResult> = Promise.resolve();
  const inTurn = <Result extends TurnResult>(work: () => Promise<Result>) => {
    const next = turning.then(work, work);
    turning = next.catch(() => {});
    return next;
  };

  const readSwitch = async () => {
    const host = getHost();
    if (!host) return { enabled: false, spaces: [] };
    try {
      const spaces = await host.journey.listSpaces();
      return { enabled: true, spaces: spaces.map(({ id, name, state }) => ({ id, name, state })) };
    } catch (error) {
      return { enabled: true, spaces: null, failure: { code: error instanceof SpaceError ? error.code : 'space_journey_failed', message: failureProperty(error, 'message') ?? String(error) } };
    }
  };

  const setSwitch = (enabled: boolean) => inTurn(async () => {
    const host = getHost();
    if (enabled === Boolean(host)) return { enabled, stopped: [], stillRunning: [] };
    if (!enabled) {
      const current = requiredValue(host, 'journey');
      const outcome = await current.journey.stopAllSpaces();
      try {
        await persist(false);
      } catch (error) {
        current.journey.reopen();
        throw error;
      }
      setHost(null);
      current.close();
      return { enabled: false, ...outcome };
    }
    await persist(true);
    const made = await buildHost();
    startHost(made);
    setHost(made);
    return { enabled: true, stopped: [], stillRunning: [] };
  });

  const setMachine = (machine: string) => inTurn(async () => {
    const parsed = sshHostSchema.safeParse(machine);
    if (!parsed.success) throw new SpaceError('invalid_machine', 'A machine is an SSH destination, [user@]host[:port], or nothing.');
    const host = getHost();
    if (!host) throw new SpaceError('isolated_spaces_off', 'Isolated spaces are turned off.');
    const current = host.places().find((place) => place.id === DOCKER_SSH_PLACE_ID)?.machine ?? '';
    if (parsed.data === current) return describeSshPlace(host);
    const there = (await host.journey.listSpaces()).filter((space) => space.placeId === DOCKER_SSH_PLACE_ID);
    if (there.length > 0) throw new SpaceError('place_has_spaces', `Delete the ${there.length} space(s) on the other machine first.`, { count: there.length });
    const busy = () => new SpaceError('space_busy', 'A space is being made or an action is still running. Wait for it to finish.');
    if (!host.journey.isIdle()) throw busy();
    await persistMachine(parsed.data);
    let made;
    try {
      made = await buildHost();
    } catch (error) {
      await persistMachine(current).catch(() => {});
      throw error;
    }
    if (!host.journey.isIdle()) {
      made.close();
      await persistMachine(current).catch(() => {});
      throw busy();
    }
    setHost(made);
    host.close();
    startHost(made);
    return describeSshPlace(made);
  });

  return { readSwitch, setSwitch, setMachine };
}

export function registerSpaceRoutes(app: RouteApp, { getJourney, getPlaces = () => [], getDockerSetup = () => null, readSwitch, setSwitch, setMachine = async () => null, getArchive = () => null }: RouteOptions) {
  const withJourney = (handler: (journey: Journey, req: Request, res: Response) => Promise<void>) => async (req: Request, res: Response) => {
    const journey = getJourney();
    if (!journey) {
      res.status(404).json({ code: 'isolated_spaces_off', message: 'Isolated spaces are turned off.', details: null });
      return;
    }
    try {
      await handler(journey, req, res);
    } catch (error) {
      answerFailure(res, error);
    }
  };

  const spaceIdOf = (req: Request) => {
    const id = String(req.params.id ?? '');
    if (!isSpaceId(id)) throw new SpaceError('space_not_found', `There is no space ${id}`);
    return id;
  };

  const requireBody = (req: Request) => {
    if (!isObjectRecord(req.body)) throw new SpaceError('invalid_request_body', 'The body is a JSON object.');
    return req.body;
  };

  app.get(`${SPACES_ROUTE}/switch`, async (_req, res) => {
    try {
      res.json(await readSwitch());
    } catch (error) {
      answerFailure(res, error);
    }
  });
  app.put(`${SPACES_ROUTE}/switch`, async (req, res) => {
    try {
      const body = switchBodySchema.safeParse(req.body);
      if (!body.success) throw new SpaceError('invalid_request_body', 'The switch takes `enabled`, true or false.');
      res.json(await setSwitch(body.data.enabled));
    } catch (error) {
      answerFailure(res, error);
    }
  });

  app.get(`${SPACES_ROUTE}/archives`, (_req, res) => {
    res.json({ archives: getArchive()?.listArchives() ?? [] });
  });

  app.get(`${SPACES_ROUTE}/idle-stop`, withJourney(async (journey, _req, res) => {
    res.json(await journey.readIdleStopSetting());
  }));
  app.put(`${SPACES_ROUTE}/idle-stop`, withJourney(async (journey, req, res) => {
    res.json(await journey.changeIdleStop(requireBody(req)));
  }));

  app.get(`${SPACES_ROUTE}/places`, withJourney(async (_journey, _req, res) => {
    const local = getDockerSetup();
    const places = await Promise.all(getPlaces().map(async (place) => {
      const checked = await place.check();
      const setup = local && place.id === local.placeId ? await local.setup.describe(checked) : null;
      return { id: place.id, machine: place.machine ?? null, ...checked, setup };
    }));
    res.json({ places });
  }));
  app.get(`${SPACES_ROUTE}/places/local/setup`, withJourney(async (_journey, _req, res) => {
    res.json({ job: getDockerSetup()?.setup.readJob() ?? null });
  }));
  app.post(`${SPACES_ROUTE}/places/local/setup`, withJourney(async (_journey, req, res) => {
    const body = dockerSetupBodySchema.safeParse(req.body);
    if (!body.success) throw new SpaceError('invalid_request_body', `The setup takes \`action\`, one of ${DOCKER_SETUP_ACTIONS.join(', ')}.`);
    const local = getDockerSetup();
    if (!local) throw new SpaceError('place_not_found', 'This computer has no Docker place.');
    res.status(202).json({ job: await local.setup.start(body.data.action) });
  }));
  app.put(`${SPACES_ROUTE}/machine`, withJourney(async (_journey, req, res) => {
    const body = machineBodySchema.safeParse(req.body);
    if (!body.success) throw new SpaceError('invalid_request_body', 'The machine takes `machine`, a string.');
    res.json({ place: await setMachine(body.data.machine) });
  }));

  app.get(`${SPACES_ROUTE}/places/:placeId/disk`, withJourney(async (journey, req, res) => {
    res.json(await journey.readDisk(String(req.params.placeId ?? '')));
  }));
  app.post(`${SPACES_ROUTE}/places/:placeId/clean-up`, withJourney(async (journey, req, res) => {
    res.json(await journey.cleanUpDisk(String(req.params.placeId ?? '')));
  }));
  app.post(`${SPACES_ROUTE}/places/:placeId/image`, withJourney(async (journey, req, res) => {
    res.status(202).json(await journey.pullImage(String(req.params.placeId ?? '')));
  }));

  app.get(SPACES_ROUTE, withJourney(async (journey, _req, res) => {
    res.json({ spaces: await journey.listSpaces({ access: true }) });
  }));

  app.post(SPACES_ROUTE, withJourney(async (journey, req, res) => {
    res.status(202).json(await journey.createSpace(requireBody(req)));
  }));

  app.post(`${SPACES_ROUTE}/:id/start`, withJourney(async (journey, req, res) => {
    res.json(await journey.startSpace(spaceIdOf(req)));
  }));

  app.put(`${SPACES_ROUTE}/:id/task-title`, withJourney(async (journey, req, res) => {
    const body = z.object({ title: z.string() }).safeParse(req.body);
    if (!body.success) throw new SpaceError('invalid_request_body', 'The task title takes title, a string.');
    res.json(await journey.setTaskTitle(spaceIdOf(req), body.data.title));
  }));

  app.post(`${SPACES_ROUTE}/:id/stop`, withJourney(async (journey, req, res) => {
    res.json(await journey.stopSpace(spaceIdOf(req)));
  }));

  app.post(`${SPACES_ROUTE}/:id/restart-opencode`, withJourney(async (journey, req, res) => {
    res.json(await journey.restartOpenCode(spaceIdOf(req)));
  }));

  app.post(`${SPACES_ROUTE}/:id/restart`, withJourney(async (journey, req, res) => {
    res.json(await journey.restartSpace(spaceIdOf(req)));
  }));

  app.delete(`${SPACES_ROUTE}/:id`, withJourney(async (journey, req, res) => {
    res.json(await journey.removeSpace(spaceIdOf(req), { allowUnsaved: req.query?.unsavedChats === 'delete' }));
  }));

  app.get(`${SPACES_ROUTE}/logins`, withJourney(async (journey, _req, res) => {
    res.json(await journey.readHostLogins());
  }));

  app.get(`${SPACES_ROUTE}/custom-providers`, withJourney(async (journey, req, res) => {
    res.json(await journey.readHostCustomProviders(directoryQuerySchema.safeParse(req.query?.directory).data ?? null));
  }));

  app.get(`${SPACES_ROUTE}/catalog-providers`, withJourney(async (journey, req, res) => {
    res.json(await journey.readHostCatalogProviders(directoryQuerySchema.safeParse(req.query?.directory).data ?? null));
  }));

  app.post(`${SPACES_ROUTE}/:id/grants`, withJourney(async (journey, req, res) => {
    res.json(await journey.grantAccess(spaceIdOf(req), requireBody(req)));
  }));

  app.post(`${SPACES_ROUTE}/:id/network/domains`, withJourney(async (journey, req, res) => {
    res.json(await journey.openDomain(spaceIdOf(req), requireBody(req)));
  }));

  app.post(`${SPACES_ROUTE}/:id/setup`, withJourney(async (journey, req, res) => {
    res.json(await journey.runSetup(spaceIdOf(req), requireBody(req)));
  }));

  app.get(`${SPACES_ROUTE}/:id/setup`, withJourney(async (journey, req, res) => {
    res.json(await journey.readSetup(spaceIdOf(req)));
  }));

  app.get(`${SPACES_ROUTE}/:id/journal`, withJourney(async (journey, req, res) => {
    res.json(await journey.readJournal(spaceIdOf(req)));
  }));

  app.get(`${SPACES_ROUTE}/:id/apply`, withJourney(async (journey, req, res) => {
    res.json(await journey.previewApply(spaceIdOf(req)));
  }));

  app.post(`${SPACES_ROUTE}/:id/apply`, withJourney(async (journey, req, res) => {
    res.json(await journey.applySpace(spaceIdOf(req), requireBody(req)));
  }));
}
