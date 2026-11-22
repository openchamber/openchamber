/**
 * Pinning one member of a model pool for a session, and going back to a pool.
 *
 * A pin keeps the session on the pool (OpenCode `POST /api/session/:id/route-target`,
 * fork #2671): the pinned member serves while it is healthy, the pool fails
 * over to its other members when it is not, and requests return to the member
 * once it recovers. Clearing the pin (`member: null`) restores the pool's
 * normal choice. When a pin takes effect is the user's choice:
 *
 * - `next-input`: the pin is set once the running turn has finished, so the
 *   next message is the first to use it; an idle session pins now.
 * - `next-step`: the pin is set now. OpenCode reads it on every model
 *   request, so a running turn makes its next request on the member.
 * - `immediately`: the pin is set now and a running turn is replayed on the
 *   pool (the latest prompt is staged out and sent again, as the "Stop and
 *   restart this reply" choice for model changes during a reply does); an idle
 *   session pins now, which is the same as `next-step`.
 *
 * A session whose model was switched to a single pool member directly (an
 * older pick, or the model picker) can go back to a pool: that switches the
 * session's model, with the same three timings, and the composer follows only
 * when the switch succeeded, so a refused switch leaves the selection the user
 * had.
 */
import type { ModelSelection } from '@/lib/opencode/model';
import { getModelPoolTargets, MODEL_ROUTE_PROVIDER_ID } from '@/lib/sessionErrorRecovery';

export type PoolPickTiming = 'immediately' | 'next-step' | 'next-input';

export const POOL_PICK_TIMINGS: readonly PoolPickTiming[] = ['immediately', 'next-step', 'next-input'];

/** Pin `member` inside pool `poolID` (null clears the pin), or switch the session back onto a pool. */
export type PoolPick =
  | { kind: 'pin'; poolID: string; member: ModelSelection | null }
  | { kind: 'return'; poolID: string };

type ReturnAction = 'switch-session' | 'restart-turn' | null;
type PinAction = 'pin' | 'pin-and-restart' | 'pin-when-idle';

/** What going back to a pool does to the session before the composer follows. */
export const returnActionFor = (timing: PoolPickTiming, turnRunning: boolean): ReturnAction => {
  if (timing === 'next-input') return null;
  if (timing === 'immediately' && turnRunning) return 'restart-turn';
  return 'switch-session';
};

/** When a pin is set, and whether the running turn is replayed. */
export const pinActionFor = (timing: PoolPickTiming, turnRunning: boolean): PinAction => {
  if (!turnRunning) return 'pin';
  if (timing === 'immediately') return 'pin-and-restart';
  if (timing === 'next-input') return 'pin-when-idle';
  return 'pin';
};

interface PoolPickDeps {
  setPin: (poolID: string, member: ModelSelection | null) => Promise<void>;
  switchSessionModel: (model: ModelSelection) => Promise<void>;
  restartTurn: (model: ModelSelection) => Promise<void>;
  selectComposerModel: (model: ModelSelection) => void;
  /** Resolves true once the running turn is idle, false if the pick's scope is gone first. */
  whenIdle: () => Promise<boolean>;
  /** False once the session, directory or runtime the pick was made for is gone. */
  isCurrent: () => boolean;
}

const poolModel = (poolID: string): ModelSelection => ({ providerID: MODEL_ROUTE_PROVIDER_ID, id: poolID });

/** Applies a pick. Throws when OpenCode refused the pin, the switch or the restart. */
export const applyPoolPick = async (
  pick: PoolPick,
  timing: PoolPickTiming,
  turnRunning: boolean,
  deps: PoolPickDeps,
): Promise<void> => {
  if (!deps.isCurrent()) return;
  if (pick.kind === 'return') {
    const model = poolModel(pick.poolID);
    const action = returnActionFor(timing, turnRunning);
    if (action === 'switch-session') await deps.switchSessionModel(model);
    if (action === 'restart-turn') await deps.restartTurn(model);
    if (deps.isCurrent()) deps.selectComposerModel(model);
    return;
  }
  const action = pinActionFor(timing, turnRunning);
  if (action === 'pin-when-idle' && !(await deps.whenIdle())) return;
  if (!deps.isCurrent()) return;
  await deps.setPin(pick.poolID, pick.member);
  if (action === 'pin-and-restart' && deps.isCurrent()) await deps.restartTurn(poolModel(pick.poolID));
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
 * members of the selected pool to pin, or the pools a directly picked model
 * belongs to, so the user can go back. A pool whose members the catalog does
 * not list (a pattern-only pool, an older OpenCode) offers nothing to pick,
 * and a member missing from its provider's catalog or disabled there is left
 * out.
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

/** Whether `pinned` names `member`: same provider and model, and the same variant when either has one. */
export const isPinnedMember = (pinned: ModelSelection | undefined, member: ModelSelection): boolean =>
  pinned !== undefined
  && pinned.providerID === member.providerID
  && pinned.id === member.id
  && (pinned.variant ?? undefined) === (member.variant ?? undefined);
