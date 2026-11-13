// The host's own routes of the isolated-spaces journey, under `/api/openchamber/spaces`: a
// namespace of the host's, never forwarded, beside `/api/openchamber/tunnel`. A request to the
// server inside a space names a space's directory, or has the older `/api/spaces/<id>/...`
// form, and belongs to the dispatcher; nothing here touches either.
//
// Every route but the switch exists only while the switch is on: `getJourney()` answers null
// while it is off, and then the journey routes say so with 404 and `isolated_spaces_off`, the same
// answer a route that does not exist would give. The switch itself is reachable while the feature
// is off, because turning it on is what makes the feature exist (decision 19), and so is the list
// of chat archives: those chats stay on the Archive page with the switch on or off, and reading
// that list is a file of the host's, which runs nothing of the feature.
// `/api/openchamber/spaces` is on the JSON-body allowlist of `core-routes.js`.

import { z } from 'zod';

import { SpaceError } from './errors.js';
import { isSpaceId } from './labels.js';
import { DOCKER_SSH_PLACE_ID } from './places/docker.js';
import { DOCKER_SETUP_ACTIONS } from './places/docker-setup.js';
import { sshHostSchema } from './places/ssh-host.js';

export const SPACES_ROUTE = '/api/openchamber/spaces';

// The project a request names in `?directory=`; anything else reads as no project.
const directoryQuerySchema = z.string().min(1);

// Which HTTP status a refusal of the journey gets. Everything not named here is 502 when it comes
// from the place or the space, and 500 when it is not a `SpaceError` at all.
const STATUS_BY_CODE = new Map([
  ['space_not_found', 404],
  ['place_not_found', 404],
  ['project_not_registered', 400],
  ['invalid_space_name', 400],
  ['invalid_project_directory', 400],
  ['invalid_snapshot_mode', 400],
  ['invalid_network', 400],
  ['invalid_space_purpose', 400],
  ['space_purpose_immutable', 409],
  ['space_approval_network_locked', 403],
  ['space_approval_grant_denied', 403],
  ['space_approval_model_unsupported', 400],
  ['space_approval_model_unreviewed', 400],
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
  ['host_loopback_unavailable', 400],
  ['mcp_grant_unsupported_place', 400],
  ['mcp_connection_not_found', 404],
  ['protected_mcp_unavailable', 503],
  ['agent_separation_missing', 409],
  ['root_place_not_allowed', 400],
  ['root_activation_invalid', 400],
  ['root_activation_unexpected', 400],
  ['root_activation_required', 409],
  ['root_activation_challenge_unknown', 409],
  ['root_activation_mismatch', 409],
  ['root_activation_busy', 409],
  ['root_activation_refused', 403],
  ['root_passkey_not_approved', 409],
  ['root_passkeys_busy', 409],
  ['ui_passkey_missing', 409],
  ['approval_code_invalid', 400],
  ['approval_code_wrong', 403],
  ['approval_not_started', 409],
  ['approval_expired', 409],
  ['approval_awaiting_confirmation', 409],
  ['approval_challenge_missing', 409],
  ['approval_credential_invalid', 400],
  ['approval_credential_mismatch', 400],
  ['approval_origin_refused', 403],
  ['approval_assertion_refused', 403],
]);

/** One JSON answer per failure, with a stable code. Details travel as data; a stack never does. */
export const answerFailure = (res, error) => {
  if (error instanceof SpaceError) {
    res.status(STATUS_BY_CODE.get(error.code) ?? 502).json({ code: error.code, message: error.message, details: error.details ?? null });
    return;
  }
  res.status(500).json({ code: 'space_journey_failed', message: error?.message ?? String(error), details: null });
};

const isObjectRecord = (value) => value instanceof Object && !Array.isArray(value);
const switchBodySchema = z.object({ enabled: z.boolean() });
const machineBodySchema = z.object({ machine: z.string() });
const dockerSetupBodySchema = z.object({ action: z.enum(DOCKER_SETUP_ACTIONS) });

/** The place of the other machine as the places route lists it, checked now, or null without one. */
const describeSshPlace = async (host) => {
  const place = host.places().find((candidate) => candidate.id === DOCKER_SSH_PLACE_ID);
  return place ? { id: place.id, machine: place.machine, ...(await place.check()) } : null;
};

/**
 * The switch as `index.js` runs it. `getHost()` and `setHost(host)` read and replace the running
 * host, `buildHost()` makes one as the start would, which may take a moment, `startHost(host)` connects it, and
 * `persist(enabled)` writes the setting. One change runs at a time: a second request waits for
 * the first and then sees what it left, so a double click builds one host and never two.
 *
 * `persistMachine(machine)` writes the machine of the Docker over SSH place, `isolatedSpacesSshHost`;
 * `setMachine` is the places page's field. The places are fixed when a host is built, so a new
 * machine means a new host, built the way a turn-on builds one and put in the old one's place
 * without a stop: the spaces keep running, and their next request finds them through the new
 * host's records. Refused while a space is on the machine now, so no space is left listed on a
 * machine nothing reaches, and while a creation or an action runs, since those live in the host's memory.
 */
export function createSwitchController({ getHost, setHost, buildHost, startHost, persist, persistMachine = async () => {} }) {
  let turning = Promise.resolve();
  const inTurn = (work) => {
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
      // The place cannot be asked, Docker being down among the reasons. The switch is still on and
      // must still be reachable, so the answer says that the list is unknown rather than failing.
      return { enabled: true, spaces: null, failure: { code: error instanceof SpaceError ? error.code : 'space_journey_failed', message: error?.message ?? String(error) } };
    }
  };

  // Off: every space is stopped and its files kept, then the feature goes; a space that could not
  // be stopped is reported as still running (decision 18). On: the setting is written and the
  // feature comes up, as it would at the next start.
  const setSwitch = (enabled) => inTurn(async () => {
    const host = getHost();
    if (enabled === Boolean(host)) return { enabled, stopped: [], stillRunning: [] };
    if (!enabled) {
      const outcome = await host.journey.stopAllSpaces();
      try {
        await persist(false);
      } catch (error) {
        host.journey.reopen();
        throw error;
      }
      setHost(null);
      host.close();
      return { enabled: false, ...outcome };
    }
    await persist(true);
    const made = await buildHost();
    startHost(made);
    setHost(made);
    return { enabled: true, stopped: [], stillRunning: [] };
  });

  const setMachine = (machine) => inTurn(async () => {
    const parsed = sshHostSchema.safeParse(machine);
    if (!parsed.success) throw new SpaceError('invalid_machine', 'A machine is an SSH destination, [user@]host[:port], or nothing.');
    const host = getHost();
    if (!host) throw new SpaceError('isolated_spaces_off', 'Isolated spaces are turned off.');
    const current = host.places().find((place) => place.id === DOCKER_SSH_PLACE_ID)?.machine ?? '';
    if (parsed.data === current) return describeSshPlace(host);
    // The list is read for the machine's spaces; a list that fails refuses the change, since it cannot say they are none.
    const there = (await host.journey.listSpaces()).filter((space) => space.placeId === DOCKER_SSH_PLACE_ID);
    if (there.length > 0) throw new SpaceError('place_has_spaces', `Delete the ${there.length} space(s) on the other machine first.`, { count: there.length });
    const busy = () => new SpaceError('space_busy', 'A space is being made or an action is still running. Wait for it to finish.');
    if (!host.journey.isIdle()) throw busy();
    await persistMachine(parsed.data);
    let made;
    try {
      made = await buildHost();
    } catch (error) {
      // The file must not name a machine the running host does not have.
      await persistMachine(current).catch(() => {});
      throw error;
    }
    // A creation or an action that began while the new host was built lives in the old host's
    // memory and would be orphaned by the swap: the new host goes, the old one stays.
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

/**
 * A root confirmation as the browser asks for it: the approved passkeys with the origin each was
 * approved at, and the RP ID of those approved at this address, else the first one's. The browser
 * offers only the passkeys of its own origin; the root component checks the origin again.
 */
const describeRootActivation = ({ spaceId, challenge, expiresAt, credentials }, currentRpID) => {
  const described = {
    challenge,
    expiresAt,
    rpID: (credentials.find((credential) => credential.rpID === currentRpID) ?? credentials[0])?.rpID ?? null,
    allowCredentials: credentials.map(({ id, label, origin }) => ({ id, label, origin })),
  };
  if (spaceId !== undefined) described.spaceId = spaceId;
  return described;
};

/**
 * `getJourney()` is the journey of the running host or null, `getPlaces()` the places to check,
 * `getDockerSetup()` the local place's id with its Docker setup, or null, `readSwitch()` and `setSwitch(enabled)` the switch: `setSwitch(false)` stops the spaces and takes
 * the feature down, `setSwitch(true)` brings it up, and each resolves what the client shows.
 * `getUiPasskeys(req)` answers the OpenChamber sign-in passkeys at the request's address,
 * `{ rpID, passkeys: [{ id, label, publicKey, rpID }] }`, for a root passkey approval.
 */
export function registerSpaceRoutes(app, { getJourney, getPlaces = () => [], getDockerSetup = () => null, readSwitch, setSwitch, setMachine = async () => null, getArchive = () => null, getUiPasskeys = () => ({ rpID: null, passkeys: [] }) }) {
  const withJourney = (handler) => async (req, res) => {
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

  const spaceIdOf = (req) => {
    const id = String(req.params.id ?? '');
    if (!isSpaceId(id)) throw new SpaceError('space_not_found', `There is no space ${id}`);
    return id;
  };

  const requireBody = (req) => {
    if (!isObjectRecord(req.body)) throw new SpaceError('invalid_request_body', 'The body is a JSON object.');
    return req.body;
  };

  // The switch: what it is and, while on, what turning it off would stop, for the banner of decision 18.
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

  // The archives of deleted spaces, for the Archive page: which directory holds which space's chats.
  app.get(`${SPACES_ROUTE}/archives`, (_req, res) => {
    res.json({ archives: getArchive()?.listArchives() ?? [] });
  });

  // The idle stop setting (decision 11): kept in the settings and told to every running space.
  app.get(`${SPACES_ROUTE}/idle-stop`, withJourney(async (journey, _req, res) => {
    res.json(await journey.readIdleStopSetting());
  }));
  app.put(`${SPACES_ROUTE}/idle-stop`, withJourney(async (journey, req, res) => {
    res.json(await journey.changeIdleStop(requireBody(req)));
  }));

  // The places funnel: each place asked what it can do, now, because the user is looking. This
  // computer's place also says what gets Docker going there, see `places/docker-setup.js`.
  app.get(`${SPACES_ROUTE}/places`, withJourney(async (journey, _req, res) => {
    const local = getDockerSetup();
    const listed = getPlaces();
    const root = listed.some((place) => place.kind === 'host-root') ? await journey.readRootPasskeys() : null;
    const places = await Promise.all(listed.map(async (place) => {
      const checked = await place.check();
      const setup = local && place.id === local.placeId ? await local.setup.describe(checked) : null;
      const rootActivation = place.kind === 'host-root'
        ? { available: root.available, reason: root.reason, origins: [...new Set(root.passkeys.map((passkey) => passkey.origin))] }
        : null;
      return { id: place.id, kind: place.kind ?? 'docker', machine: place.machine ?? null, ...checked, setup, rootActivation };
    }));
    res.json({ places });
  }));

  // Root spaces: whether they may run and the passkeys approved for them, the two halves of an
  // approval the root command started, and the one-time challenge of a creation or a start.
  app.get(`${SPACES_ROUTE}/root-passkeys`, withJourney(async (journey, _req, res) => {
    res.json(await journey.readRootPasskeys());
  }));
  app.post(`${SPACES_ROUTE}/root-passkeys/approval-challenge`, withJourney(async (journey, req, res) => {
    const { rpID, passkeys } = getUiPasskeys(req);
    if (passkeys.length === 0) throw new SpaceError('ui_passkey_missing', 'Add a passkey for signing in to OpenChamber at this address first, then enter the code again.');
    const { challenge } = await journey.rootApprovalChallenge(requireBody(req));
    res.json({ challenge, rpID, allowCredentials: passkeys.map(({ id, label }) => ({ id, label })) });
  }));
  app.post(`${SPACES_ROUTE}/root-passkeys/approval`, withJourney(async (journey, req, res) => {
    const { passkeys } = getUiPasskeys(req);
    res.json(await journey.completeRootApproval(requireBody(req), (id) => passkeys.find((passkey) => passkey.id === id) ?? null));
  }));
  app.post(`${SPACES_ROUTE}/root-activation`, withJourney(async (journey, req, res) => {
    const body = requireBody(req);
    if (body.op !== 'create') throw new SpaceError('root_activation_invalid', 'A root space is confirmed here for a creation; a start is confirmed on the space.');
    res.json(describeRootActivation(await journey.rootActivationOptions({ op: 'create', request: body.request }), getUiPasskeys(req).rpID));
  }));
  app.post(`${SPACES_ROUTE}/:id/root-activation`, withJourney(async (journey, req, res) => {
    res.json(describeRootActivation(await journey.rootActivationOptions({ op: 'start', spaceId: spaceIdOf(req) }), getUiPasskeys(req).rpID));
  }));
  // Getting Docker ready on this computer: the action under way or the last one that failed, read
  // while the screen waits on it, and the start of the one action the place offers now.
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
  // The machine of the Docker over SSH place: the empty string takes the place away. Answers that
  // place as the list above shows it, checked, or null.
  app.put(`${SPACES_ROUTE}/machine`, withJourney(async (_journey, req, res) => {
    const body = machineBodySchema.safeParse(req.body);
    if (!body.success) throw new SpaceError('invalid_request_body', 'The machine takes `machine`, a string.');
    res.json({ place: await setMachine(body.data.machine) });
  }));

  // The disk a place's spaces take, and the clean-up of what OpenChamber can make again.
  app.get(`${SPACES_ROUTE}/places/:placeId/disk`, withJourney(async (journey, req, res) => {
    res.json(await journey.readDisk(String(req.params.placeId ?? '')));
  }));
  app.post(`${SPACES_ROUTE}/places/:placeId/clean-up`, withJourney(async (journey, req, res) => {
    res.json(await journey.cleanUpDisk(String(req.params.placeId ?? '')));
  }));
  // Downloads the image ahead of the first space; answers the disk at once, the download goes on.
  app.post(`${SPACES_ROUTE}/places/:placeId/image`, withJourney(async (journey, req, res) => {
    res.status(202).json(await journey.pullImage(String(req.params.placeId ?? '')));
  }));

  app.get(SPACES_ROUTE, withJourney(async (journey, _req, res) => {
    res.json({ spaces: await journey.listSpaces({ access: true }) });
  }));

  // Answers as soon as the space has an id; the steps follow as `openchamber:space-progress` events.
  app.post(SPACES_ROUTE, withJourney(async (journey, req, res) => {
    res.status(202).json(await journey.createSpace(requireBody(req)));
  }));

  // A root space's confirmation travels in the body; any other space starts without a body.
  const rootActivationOf = (req) => (isObjectRecord(req.body) ? req.body.rootActivation ?? null : null);

  app.post(`${SPACES_ROUTE}/:id/start`, withJourney(async (journey, req, res) => {
    res.json(await journey.startSpace(spaceIdOf(req), { rootActivation: rootActivationOf(req) }));
  }));

  app.put(`${SPACES_ROUTE}/:id/task-title`, withJourney(async (journey, req, res) => {
    const body = z.object({ title: z.string() }).safeParse(req.body);
    if (!body.success) throw new SpaceError('invalid_request_body', 'The task title takes title, a string.');
    res.json(await journey.setTaskTitle(spaceIdOf(req), body.data.title));
  }));

  app.post(`${SPACES_ROUTE}/:id/stop`, withJourney(async (journey, req, res) => {
    res.json(await journey.stopSpace(spaceIdOf(req)));
  }));

  // The repair actions, from soft to hard: OpenCode inside, then the container with a fresh token.
  app.post(`${SPACES_ROUTE}/:id/restart-opencode`, withJourney(async (journey, req, res) => {
    res.json(await journey.restartOpenCode(spaceIdOf(req)));
  }));

  app.post(`${SPACES_ROUTE}/:id/restart`, withJourney(async (journey, req, res) => {
    res.json(await journey.restartSpace(spaceIdOf(req), { rootActivation: rootActivationOf(req) }));
  }));

  app.delete(`${SPACES_ROUTE}/:id`, withJourney(async (journey, req, res) => {
    // `?unsavedChats=delete` is the user's "Delete anyway" after chats could not be saved.
    res.json(await journey.removeSpace(spaceIdOf(req), { allowUnsaved: req.query?.unsavedChats === 'delete' }));
  }));

  // The host's browser logins a space can be given, without their tokens, for the grant dialogs.
  app.get(`${SPACES_ROUTE}/logins`, withJourney(async (journey, _req, res) => {
    res.json(await journey.readHostLogins());
  }));

  // The providers the user defined on the host for a project, for the grant dialogs; never a key.
  app.get(`${SPACES_ROUTE}/custom-providers`, withJourney(async (journey, req, res) => {
    res.json(await journey.readHostCustomProviders(directoryQuerySchema.safeParse(req.query?.directory).data ?? null));
  }));

  // A grant for a running space; the key in the body goes to the gatekeeper and nowhere else.
  app.post(`${SPACES_ROUTE}/:id/grants`, withJourney(async (journey, req, res) => {
    res.json(await journey.grantAccess(spaceIdOf(req), requireBody(req)));
  }));

  // A domain added to the allowlist of a running space, live; the record keeps it for the next start.
  app.post(`${SPACES_ROUTE}/:id/network/domains`, withJourney(async (journey, req, res) => {
    res.json(await journey.openDomain(spaceIdOf(req), requireBody(req)));
  }));

  // The project's setup commands, again: answers once they began; each step follows as an event.
  app.post(`${SPACES_ROUTE}/:id/setup`, withJourney(async (journey, req, res) => {
    res.json(await journey.runSetup(spaceIdOf(req), requireBody(req)));
  }));

  // How the last run went, with the end of the output of the command that failed.
  app.get(`${SPACES_ROUTE}/:id/setup`, withJourney(async (journey, req, res) => {
    res.json(await journey.readSetup(spaceIdOf(req)));
  }));

  app.get(`${SPACES_ROUTE}/:id/journal`, withJourney(async (journey, req, res) => {
    res.json(await journey.readJournal(spaceIdOf(req)));
  }));

  // Brings the work out and says what an apply would do; nothing of the user's is written.
  app.get(`${SPACES_ROUTE}/:id/apply`, withJourney(async (journey, req, res) => {
    res.json(await journey.previewApply(spaceIdOf(req)));
  }));

  app.post(`${SPACES_ROUTE}/:id/apply`, withJourney(async (journey, req, res) => {
    res.json(await journey.applySpace(spaceIdOf(req), requireBody(req)));
  }));
}
