import { SpaceError } from './errors.js';
import { createSpaceId, hashProjectDirectory, normalizeSpaceName, requireSpaceId } from './labels.js';
import { transferErrorProperty } from './code-transfer.js';
import type { createDockerPlace } from './places/docker.js';
import type { CommandOptions, CommandResult } from './command-contracts.js';

type DockerPlace = ReturnType<typeof createDockerPlace>;
export type PlaceSpace = Awaited<ReturnType<DockerPlace['list']>>[number];
export interface SpaceSpec {
  id: string;
  name: string;
  project: string;
  created: string;
  memoryBytes: number;
}
export interface SpacePlace {
  id: string;
  machine?: string | null;
  list: () => Promise<PlaceSpace[]>;
  create: (spec: SpaceSpec, options: { onStep?: ((step: string) => void) | undefined; startConfig: string | null }) => Promise<void>;
  remove: DockerPlace['remove'];
  verify: (spaceId: string) => Promise<{ check: string; message: string }[]>;
  stop: (spaceId: string) => Promise<void>;
  start: (spaceId: string) => Promise<void>;
  exec: (spaceId: string, argv: string[], options?: CommandOptions & { target?: string }) => Promise<CommandResult>;
  execArgv: (spaceId: string) => Promise<string[]>;
  connect: DockerPlace['connect'];
}
export interface RememberedSpace {
  id: string;
  placeId: string;
  name: string;
  project: string;
  created: string;
}
export interface SpaceTarget {
  placeId?: string | undefined;
  spaceId: string;
}
export interface SpaceManagerOptions {
  registry: { get: (placeId: string | undefined) => SpacePlace | null; list: () => SpacePlace[] };
  locate?: (spaceId: string) => Promise<string | null>;
  recall?: () => Promise<RememberedSpace[]>;
  now?: () => Date;
}
interface PlaceSearchFailure {
  failure: unknown;
}

const DEFAULT_SPACE_MEMORY_BYTES = 4 * 1024 * 1024 * 1024;
export const PLACE_RETRY_BASE_MS = 15_000;
export const PLACE_RETRY_CAP_MS = 5 * 60_000;
const retryDelayAfter = (failures: number) => Math.min(PLACE_RETRY_CAP_MS, PLACE_RETRY_BASE_MS * 2 ** Math.max(0, failures - 1));

export function createSpaceManager({ registry, locate = async () => null, recall = async () => [], now = () => new Date() }: SpaceManagerOptions) {
  const away = new Map<string, { failure: unknown; failures: number; until: number }>();
  const resting = (placeId: string) => {
    const rest = away.get(placeId);
    return rest !== undefined && now().getTime() < rest.until ? rest : null;
  };
  const listOf = async (place: SpacePlace) => {
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

  const requirePlace = (placeId: string | undefined) => {
    const place = registry.get(placeId);
    if (!place) {
      throw new SpaceError('place_not_found', `There is no place named '${placeId}'. Pick a configured place.`);
    }
    return place;
  };

  const placeOf = async (spaceId: string) => {
    requireSpaceId(spaceId);
    const rememberedId = await locate(spaceId);
    if (rememberedId !== null) {
      const remembered = registry.get(rememberedId);
      if (remembered) return remembered;
      throw new SpaceError('place_not_found', `The place ${rememberedId} this space was made on is no longer configured.`);
    }
    const unavailable: PlaceSearchFailure = { failure: null };
    for (const place of registry.list()) {
      try {
        if ((await listOf(place)).some((space) => space.id === spaceId)) return place;
      } catch (error) {
        unavailable.failure ??= error;
      }
    }
    if (unavailable.failure) throw unavailable.failure;
    throw new SpaceError('space_not_found', `There is no space ${spaceId} on any place`);
  };

  const resolve = ({ placeId, spaceId }: SpaceTarget) => (placeId === undefined ? placeOf(spaceId) : Promise.resolve(requirePlace(placeId)));

  const removeSpace = async ({ placeId, spaceId }: SpaceTarget) => {
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

  const createSpace = async ({ placeId, projectDirectory, name, id = createSpaceId(), onStep, startConfig = null }: { placeId: string | undefined; projectDirectory: string; name: string; id?: string; onStep?: (step: string) => void; startConfig?: string | null }) => {
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
        return { removed: [], failed: [{ kind: 'space', name: spec.id, message: transferErrorProperty(error, 'message') }] };
      }
    };

    let violations;
    try {
      violations = await place.verify(spec.id);
    } catch (error) {
      const removal = await discard();
      const wrapped = new SpaceError(transferErrorProperty(error, 'code') ?? 'space_verification_failed', `The space was removed because it could not be verified. ${transferErrorProperty(error, 'message')}`, { removal });
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

  const listSpaces = async ({ placeId }: { placeId: string }) => {
    const place = requirePlace(placeId);
    return (await listOf(place)).map((space) => ({ placeId: place.id, ...space }));
  };

  const unreachable = (remembered: RememberedSpace) => ({ ...remembered, state: 'unreachable', stoppedIdle: false, gatekeeperRunning: false, orphans: [], damaged: false, missing: [] });

  const listAllSpaces = async () => {
    const spaces: ((PlaceSpace & { placeId: string }) | ReturnType<typeof unreachable>)[] = [];
    const unavailable: { placeId: string; failure: unknown }[] = [];
    const remembering = recall();
    const known = new Set<string>();
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

  const stopSpace = async ({ placeId, spaceId }: SpaceTarget) => (await resolve({ placeId, spaceId })).stop(spaceId);

  const startSpace = async ({ placeId, spaceId }: SpaceTarget) => (await resolve({ placeId, spaceId })).start(spaceId);

  const exec = async (spaceId: string, argv: string[], options?: CommandOptions & { target?: string }) => (await placeOf(spaceId)).exec(spaceId, argv, options);
  const execArgv = async (spaceId: string) => (await placeOf(spaceId)).execArgv(spaceId);
  const connect = async (spaceId: string) => (await placeOf(spaceId)).connect(spaceId);
  const verify = async (spaceId: string) => (await placeOf(spaceId)).verify(spaceId);

  return { createSpace, listSpaces, listAllSpaces, stopSpace, startSpace, removeSpace, placeOf, exec, execArgv, connect, verify };
}
