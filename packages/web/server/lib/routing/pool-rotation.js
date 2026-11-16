/**
 * Staggered rotation planning (#295, stage 1: the decision logic).
 *
 * When several sessions sit on one pool target and that target's linked plan
 * projects to run dry, failing them all over at once busts every prompt
 * cache at the same moment. Rotation moves the sessions off one at a time,
 * ahead of the failure, by setting each session's model to a sibling target
 * through OpenCode's session model API (`session.switchModel`, the call the
 * routing runtime already makes in `applySessionSelection`). A moved session
 * leaves the pool; that is the cost of the only per-session control
 * OpenChamber has.
 *
 * This module only plans. It reads the pool-health shape
 * (`computePoolHealth`) plus the per-target session rows a later stage
 * supplies, and answers the moves to make now — at most one per pool per
 * pace window. Applying a move, persisting the pace state and the move
 * history the Pool health panel lists, and the Settings switch are the
 * following stages; nothing here touches OpenCode or the filesystem.
 */

/** The issue's defaults: off, one move per pool every 5 minutes at a 70% projection. */
const ROTATION_DEFAULTS = Object.freeze({
  enabled: false,
  paceMinutes: 5,
  triggerRatio: 0.7,
  nearLimitRatio: 0.7,
});

const clampPaceMinutes = (value) =>
  (Number.isFinite(value) ? Math.min(60, Math.max(1, value)) : ROTATION_DEFAULTS.paceMinutes);

/**
 * The moves to make now, one per pool at most.
 *
 * @param {object} input
 * @param {object} input.pools Pool health by pool id, as `computePoolHealth` returns it.
 * @param {object} input.sessionsByRef Session rows per target ref:
 *   `{ sessionID, isSubagent, lastActivityAt, isAuto }[]`. `lastActivityAt`
 *   orders the primaries: the one idle longest has the coldest cache.
 * @param {object} [input.settings] `{ enabled, paceMinutes }`; pace clamps to 1–60.
 * @param {object} [input.lastMoveAtByPool] Epoch ms of the pool's last move.
 * @param {number} [input.now] Epoch ms.
 * @returns {{ poolID: string, sessionID: string, fromRef: string, toRef: string, planID: string, ratio: number }[]}
 */
export const planPoolRotation = ({
  pools,
  sessionsByRef,
  settings,
  lastMoveAtByPool = {},
  now = Date.now(),
} = {}) => {
  if (!settings?.enabled) return [];
  const paceMs = clampPaceMinutes(settings.paceMinutes) * 60_000;
  const moves = [];

  for (const [poolID, pool] of Object.entries(pools ?? {})) {
    const lastMoveAt = lastMoveAtByPool?.[poolID];
    if (Number.isFinite(lastMoveAt) && now - lastMoveAt < paceMs) continue;

    for (const target of pool?.targets ?? []) {
      const ratio = target.plan?.projection?.ratio;
      if (!Number.isFinite(ratio) || ratio < ROTATION_DEFAULTS.triggerRatio) continue;
      if (!(target.activeSessions >= 2)) continue;

      // Sessions on Auto pick their model again on every send, so moving one
      // is pointless; they still count toward the trigger's crowd, they are
      // just never the one that moves.
      const movable = (sessionsByRef?.[target.ref] ?? []).filter((session) => !session.isAuto);
      if (movable.length === 0) continue;

      // A destination on the same plan shares the quota that is running dry,
      // and one near its own limit just moves the problem. A target with no
      // projection — no plan, or a window traffic cannot project — is not
      // near a limit anyone can see. A pattern ref names no concrete model
      // to switch a session to.
      const destination = (pool.targets ?? []).find((other) =>
        other.ref !== target.ref &&
        !other.ref.includes('*') &&
        other.plan?.id !== target.plan.id &&
        !(Number.isFinite(other.plan?.projection?.ratio) && other.plan.projection.ratio >= ROTATION_DEFAULTS.nearLimitRatio));
      if (!destination) continue;

      // Subagents first (their parent outlives them; see #296), then the
      // primary idle longest, whose cache is coldest.
      const ordered = [...movable].sort((left, right) =>
        Number(right.isSubagent ?? false) - Number(left.isSubagent ?? false) ||
        (left.lastActivityAt ?? 0) - (right.lastActivityAt ?? 0));
      moves.push({
        poolID,
        sessionID: ordered[0].sessionID,
        fromRef: target.ref,
        toRef: destination.ref,
        planID: target.plan.id,
        ratio,
      });
      break; // One move per pool per pace window.
    }
  }

  return moves;
};
