import { SpaceError } from './errors.js';
import { createSpaceId, hashProjectDirectory, normalizeSpaceName, requireSpaceId } from './labels.js';

const DEFAULT_SPACE_MEMORY_BYTES = 4 * 1024 * 1024 * 1024;
export const PLACE_RETRY_BASE_MS = 15_000;
export const PLACE_RETRY_CAP_MS = 5 * 60_000;
const retryDelayAfter = (failures) => Math.min(PLACE_RETRY_CAP_MS, PLACE_RETRY_BASE_MS * 2 ** Math.max(0, failures - 1));

export function createSpaceManager({ registry, locate = async () => null, recall = async () => [], now = () => new Date() }) {
  const away = new Map();
  const resting = (placeId) => {
    const rest = away.get(placeId);
    return rest !== undefined && now().getTime() < rest.until ? rest : null;
  };
  const listOf = async (place) => {
    const rest = resting(place.id);
    if (rest) throw rest.failure;
    try {
      const spaces = await place.list();
      away.delete(place.id);
      return spaces;
    } catch (failure) {
      const failures = (away.get(place.id)?.failures ?? 0) + 1;
      away.set(place.id, { failure, failures, until: now().getTime() + retryDelayAfter(failures) });
      throw failure;
    }
  };

  const requirePlace = (placeId) => {
    const place = registry.get(placeId);
    if (!place) {
      throw new SpaceError('place_not_found', `There is no place named '${placeId}'. Pick a configured place.`);
    }
    return place;
  };

  const placeOf = async (spaceId) => {
    requireSpaceId(spaceId);
    const rememberedId = await locate(spaceId);
    if (rememberedId !== null) {
      const remembered = registry.get(rememberedId);
      if (remembered) return remembered;
      throw new SpaceError('place_not_found', `The place ${rememberedId} this space was made on is no longer configured.`);
    }
    let unavailable = null;
    for (const place of registry.list()) {
      try {
        if ((await listOf(place)).some((space) => space.id === spaceId)) return place;
      } catch (error) {
        unavailable ??= error;
      }
    }
    if (unavailable) throw unavailable;
    throw new SpaceError('space_not_found', `There is no space ${spaceId} on any place`);
  };

  const resolve = ({ placeId, spaceId }) => (placeId === undefined ? placeOf(spaceId) : Promise.resolve(requirePlace(placeId)));

  const removeSpace = async ({ placeId, spaceId }) => {
    const result = await (await resolve({ placeId, spaceId })).remove(spaceId);
    if (result.failed.length > 0) {
      throw new SpaceError(
        'space_remove_incomplete',
        `Could not remove: ${result.failed.map((item) => `${item.kind} ${item.name}`).join(', ')}`,
        result,
      );
    }
    return result;
  };

  const createSpace = async ({ placeId, projectDirectory, name, id = createSpaceId(), onStep, startConfig = null }) => {
    const place = requirePlace(placeId);
    const spec = {
      id: requireSpaceId(id),
      name: normalizeSpaceName(name),
      project: hashProjectDirectory(projectDirectory),
      created: now().toISOString(),
      memoryBytes: DEFAULT_SPACE_MEMORY_BYTES,
    };
    await place.create(spec, { onStep, startConfig });

    const discard = async () => {
      try {
        return await place.remove(spec.id);
      } catch (error) {
        return { removed: [], failed: [{ kind: 'space', name: spec.id, message: error.message }] };
      }
    };

    let violations;
    try {
      violations = await place.verify(spec.id);
    } catch (error) {
      const removal = await discard();
      const wrapped = new SpaceError(error.code ?? 'space_verification_failed', `The space was removed because it could not be verified. ${error.message}`, { removal });
      wrapped.cause = error;
      throw wrapped;
    }
    if (violations.length > 0) {
      const removal = await discard();
      throw new SpaceError(
        'space_verification_failed',
        `The space was removed because it does not match the requested restrictions: ${violations.map((violation) => violation.message).join('; ')}`,
        { violations, removal },
      );
    }
    return { placeId: place.id, ...spec };
  };

  const listSpaces = async ({ placeId }) => {
    const place = requirePlace(placeId);
    return (await listOf(place)).map((space) => ({ placeId: place.id, ...space }));
  };

  const unreachable = (remembered) => ({ ...remembered, state: 'unreachable', stoppedIdle: false, gatekeeperRunning: false, orphans: [], damaged: false, missing: [] });

  const listAllSpaces = async () => {
    const spaces = [];
    const unavailable = [];
    const remembering = recall();
    const known = new Set();
    for (const place of registry.list()) {
      known.add(place.id);
      try {
        spaces.push(...(await listSpaces({ placeId: place.id })));
      } catch (error) {
        unavailable.push({ placeId: place.id, failure: error });
        spaces.push(...(await remembering).filter((space) => space.placeId === place.id).map(unreachable));
      }
    }
    const remembered = await remembering;
    for (const placeId of new Set(remembered.map((space) => space.placeId).filter((id) => !known.has(id)))) {
      unavailable.push({ placeId, failure: new SpaceError('place_not_found', `The place ${placeId} these spaces were made on is no longer configured.`) });
      spaces.push(...remembered.filter((space) => space.placeId === placeId).map(unreachable));
    }
    return { spaces, unavailable };
  };

  const stopSpace = async ({ placeId, spaceId }) => (await resolve({ placeId, spaceId })).stop(spaceId);

  const startSpace = async ({ placeId, spaceId }) => (await resolve({ placeId, spaceId })).start(spaceId);

  const exec = async (spaceId, argv, options) => (await placeOf(spaceId)).exec(spaceId, argv, options);
  const execArgv = async (spaceId) => (await placeOf(spaceId)).execArgv(spaceId);
  const connect = async (spaceId) => (await placeOf(spaceId)).connect(spaceId);
  const verify = async (spaceId) => (await placeOf(spaceId)).verify(spaceId);

  return { createSpace, listSpaces, listAllSpaces, stopSpace, startSpace, removeSpace, placeOf, exec, execArgv, connect, verify };
}
