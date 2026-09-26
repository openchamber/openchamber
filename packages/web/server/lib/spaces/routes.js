// The host's own routes of the isolated-spaces journey, under `/api/openchamber/spaces`: a
// namespace of the host's, never forwarded, beside `/api/openchamber/tunnel`. A request to the
// server inside a space is `/api/spaces/<id>/...` and belongs to the dispatcher; nothing here
// touches that shape.
//
// Every route but the switch exists only while the switch is on: `getJourney()` answers null
// while it is off, and then the journey routes say so with 404 and `isolated_spaces_off`, the same
// answer a route that does not exist would give. The switch itself is the one thing reachable
// while the feature is off, because turning it on is what makes the feature exist (decision 19).
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
  ['secret_source_missing', 409],
  ['space_record_unreadable', 409],
  ['space_preparing', 409],
  ['space_creation_failed', 409],
  ['space_busy', 409],
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
export function registerSpaceRoutes(app, { getJourney, getPlaces = () => [], readSwitch, setSwitch }) {
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

  // The places funnel: each place asked what it can do, now, because the user is looking.
  app.get(`${SPACES_ROUTE}/places`, withJourney(async (_journey, _req, res) => {
    const places = await Promise.all(getPlaces().map(async (place) => ({ id: place.id, ...(await place.check()) })));
    res.json({ places });
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

  app.delete(`${SPACES_ROUTE}/:id`, withJourney(async (journey, req, res) => {
    res.json(await journey.removeSpace(spaceIdOf(req)));
  }));

  // A grant for a running space; the key in the body goes to the gatekeeper and nowhere else.
  app.post(`${SPACES_ROUTE}/:id/grants`, withJourney(async (journey, req, res) => {
    res.json(await journey.grantAccess(spaceIdOf(req), requireBody(req)));
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
