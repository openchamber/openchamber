import { SpaceError } from './errors.js';
import { createSpaceId, hashProjectDirectory, normalizeSpaceName } from './labels.js';

// Memory limit of a new space. Swap adds nothing on top of it.
const DEFAULT_SPACE_MEMORY_BYTES = 4 * 1024 * 1024 * 1024;

/**
 * Thin orchestration over places. It keeps no record of spaces: every answer
 * comes from the place at the time of the call.
 */
export function createSpaceManager({ registry, now = () => new Date() }) {
  const requirePlace = (placeId) => {
    const place = registry.get(placeId);
    if (!place) {
      throw new SpaceError('place_not_found', `There is no place named '${placeId}'. Pick a configured place.`);
    }
    return place;
  };

  const removeSpace = async ({ placeId, spaceId }) => {
    const result = await requirePlace(placeId).remove(spaceId);
    if (result.failed.length > 0) {
      throw new SpaceError(
        'space_remove_incomplete',
        `Could not remove: ${result.failed.map((item) => `${item.kind} ${item.name}`).join(', ')}`,
        result,
      );
    }
    return result;
  };

  const createSpace = async ({ placeId, projectDirectory, name }) => {
    const place = requirePlace(placeId);
    const spec = {
      id: createSpaceId(),
      name: normalizeSpaceName(name),
      project: hashProjectDirectory(projectDirectory),
      created: now().toISOString(),
      memoryBytes: DEFAULT_SPACE_MEMORY_BYTES,
    };
    await place.create(spec);

    // A space that cannot be verified is never handed out. It is removed instead.
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
    return (await place.list()).map((space) => ({ placeId: place.id, ...space }));
  };

  const stopSpace = async ({ placeId, spaceId }) => requirePlace(placeId).stop(spaceId);

  const startSpace = async ({ placeId, spaceId }) => requirePlace(placeId).start(spaceId);

  return { createSpace, listSpaces, stopSpace, startSpace, removeSpace };
}
