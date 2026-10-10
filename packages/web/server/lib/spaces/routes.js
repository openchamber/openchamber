// The host's own routes of the isolated-spaces journey, under `/api/openchamber/spaces`: a
// namespace of the host's, never forwarded, beside `/api/openchamber/tunnel`. A request to the
// server inside a space is `/api/spaces/<id>/...` and belongs to the dispatcher; nothing here
// touches that shape.
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

export const SPACES_ROUTE = '/api/openchamber/spaces';

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
  ['invalid_apply_request', 400],
  ['invalid_branch_name', 400],
  ['invalid_space_id', 400],
  ['invalid_request_body', 400],
  ['invalid_grant_request', 400],
  ['provider_not_supported', 400],
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

/**
 * The switch as `index.js` runs it. `getHost()` and `setHost(host)` read and replace the running
 * host, `buildHost()` makes one as the start would, `startHost(host)` connects it, and
 * `persist(enabled)` writes the setting. One change runs at a time: a second request waits for
 * the first and then sees what it left, so a double click builds one host and never two.
 */
export function createSwitchController({ getHost, setHost, buildHost, startHost, persist }) {
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
    const made = buildHost();
    startHost(made);
    setHost(made);
    return { enabled: true, stopped: [], stillRunning: [] };
  });

  return { readSwitch, setSwitch };
}

/**
 * `getJourney()` is the journey of the running host or null, `getPlaces()` the places to check,
 * `readSwitch()` and `setSwitch(enabled)` the switch: `setSwitch(false)` stops the spaces and takes
 * the feature down, `setSwitch(true)` brings it up, and each resolves what the client shows.
 */
export function registerSpaceRoutes(app, { getJourney, getPlaces = () => [], readSwitch, setSwitch, getArchive = () => null }) {
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

  // The places funnel: each place asked what it can do, now, because the user is looking.
  app.get(`${SPACES_ROUTE}/places`, withJourney(async (_journey, _req, res) => {
    const places = await Promise.all(getPlaces().map(async (place) => ({ id: place.id, ...(await place.check()) })));
    res.json({ places });
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

  app.post(`${SPACES_ROUTE}/:id/start`, withJourney(async (journey, req, res) => {
    res.json(await journey.startSpace(spaceIdOf(req)));
  }));

  app.post(`${SPACES_ROUTE}/:id/stop`, withJourney(async (journey, req, res) => {
    res.json(await journey.stopSpace(spaceIdOf(req)));
  }));

  // The repair actions, from soft to hard: OpenCode inside, then the container with a fresh token.
  app.post(`${SPACES_ROUTE}/:id/restart-opencode`, withJourney(async (journey, req, res) => {
    res.json(await journey.restartOpenCode(spaceIdOf(req)));
  }));

  app.post(`${SPACES_ROUTE}/:id/restart`, withJourney(async (journey, req, res) => {
    res.json(await journey.restartSpace(spaceIdOf(req)));
  }));

  app.delete(`${SPACES_ROUTE}/:id`, withJourney(async (journey, req, res) => {
    // `?unsavedChats=delete` is the user's "Delete anyway" after chats could not be saved.
    res.json(await journey.removeSpace(spaceIdOf(req), { allowUnsaved: req.query?.unsavedChats === 'delete' }));
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
