/**
 * Picking one member of a model pool directly, and going back to the pool.
 *
 * OpenCode keeps a session's pool target in memory and has no route to pin
 * one member while staying in the pool, so a pick puts the session on that
 * member's model: the session leaves the pool and no longer fails over
 * inside it until the user returns to the pool. When the pick takes effect
 * is the user's choice:
 *
 * - `next-input`: only the composer's selection changes; the running turn
 *   finishes on whatever it runs on, and the next message sends with the pick.
 * - `next-step`: the session's model switches now. OpenCode reloads the
 *   session context before every model request, so a running turn makes its
 *   next request (after the current one or the current tool call) on the pick.
 * - `immediately`: a running turn is replayed on the pick (the latest prompt
 *   is staged out and sent again, as the "Stop and restart this reply" choice
 *   for model changes during a reply does); an idle session switches now,
 *   which is the same as `next-step`.
 *
 * The OpenCode call runs first and the composer follows only when it
 * succeeded, so a refused switch leaves the selection the user had.
 */
import type { ModelSelection } from '@/lib/opencode/model';
import { getModelPoolTargets, MODEL_ROUTE_PROVIDER_ID } from '@/lib/sessionErrorRecovery';

export type PoolPickTiming = 'immediately' | 'next-step' | 'next-input';

export const POOL_PICK_TIMINGS: readonly PoolPickTiming[] = ['immediately', 'next-step', 'next-input'];

type RemoteAction = 'switch-session' | 'restart-turn' | null;

/** What a pick does to the session before the composer follows. */
export const remoteActionFor = (timing: PoolPickTiming, turnRunning: boolean): RemoteAction => {
  if (timing === 'next-input') return null;
  if (timing === 'immediately' && turnRunning) return 'restart-turn';
  return 'switch-session';
};

interface PoolPickDeps {
  switchSessionModel: (model: ModelSelection) => Promise<void>;
  restartTurn: (model: ModelSelection) => Promise<void>;
  selectComposerModel: (model: ModelSelection) => void;
  /** False once the session, directory or runtime the pick was made for is gone. */
  isCurrent: () => boolean;
}

/** Applies a pick (a pool member, or the pool itself to return to it). Throws when the session could not be switched. */
export const applyPoolPick = async (
  model: ModelSelection,
  timing: PoolPickTiming,
  turnRunning: boolean,
  deps: PoolPickDeps,
): Promise<void> => {
  if (!deps.isCurrent()) return;
  const action = remoteActionFor(timing, turnRunning);
  if (action === 'switch-session') await deps.switchSessionModel(model);
  if (action === 'restart-turn') await deps.restartTurn(model);
  if (deps.isCurrent()) deps.selectComposerModel(model);
};

type CatalogModel = NonNullable<Parameters<typeof getModelPoolTargets>[0][number]['models']>[number] & { enabled?: boolean };
type CatalogProvider = {
  id: string;
  models?: CatalogModel[];
};

type PoolPickMenu =
  | { kind: 'members'; poolID: string; members: ModelSelection[] }
  | { kind: 'return'; pools: string[] }
  | { kind: 'none' };

/**
 * What the current-model menu offers for the composer's selection: the
 * members of the selected pool, or the pools a directly picked model belongs
 * to, so the user can go back. A pool whose members the catalog does not
 * list (a pattern-only pool, an older OpenCode) offers nothing to pick, and a
 * member missing from its provider's catalog or disabled there is left out.
 */
export const poolPickMenuFor = (
  providers: readonly CatalogProvider[],
  providerID: string,
  modelID: string,
): PoolPickMenu => {
  if (!providerID || !modelID) return { kind: 'none' };
  if (providerID === MODEL_ROUTE_PROVIDER_ID) {
    const members = getModelPoolTargets(providers, providerID, modelID)
      .filter((target) => target.providerID !== MODEL_ROUTE_PROVIDER_ID
        && providers.find((provider) => provider.id === target.providerID)?.models
          ?.some((model) => model.id === target.id && model.enabled !== false));
    return members.length > 0 ? { kind: 'members', poolID: modelID, members } : { kind: 'none' };
  }
  const pools = (providers.find((provider) => provider.id === MODEL_ROUTE_PROVIDER_ID)?.models ?? [])
    .map((pool) => pool.id)
    .filter((poolID) => getModelPoolTargets(providers, MODEL_ROUTE_PROVIDER_ID, poolID)
      .some((target) => target.providerID === providerID && target.id === modelID));
  return pools.length > 0 ? { kind: 'return', pools } : { kind: 'none' };
};
