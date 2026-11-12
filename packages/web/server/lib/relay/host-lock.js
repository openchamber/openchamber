// Relay-host claim shared through the data dir. Every OpenChamber instance that
// uses a data dir shares the same relay signing key / serverId, so if two
// processes run a relay host at once they fight over the single host slot at
// the relay worker (each new connection closes the previous one with
// "4001: Control replaced") and paired devices land on whichever instance won
// last — often a dev/worktree instance running different code.
//
// The claim file (`relay-host.lock` in the shared data dir) makes the contest
// deterministic instead of a network race:
//   - an instance only starts its relay host when there is no LIVE claimant
//     (a dead claimant's stale file is ignored);
//   - explicit user intent (creating a pairing link) claims unconditionally —
//     the instance the user is interacting with must be the one devices reach;
//   - a running host that discovers another live process has claimed backs off
//     instead of reconnecting, which is what ends the replace/reconnect fight.
//
// A data dir is not always private to one machine's process table: containers
// that mount the same volume all run as pid 1, and a synced or network folder
// is shared by processes this machine cannot see. So a claim names its holder
// by a random per-process instance id and the host name. A claimant is live
// while it keeps refreshing the claim, which the holder does on every claim
// check (the relay service checks every 30 s). A claimant on this host must
// also still answer on its pid, so a holder that exits is replaced at once.
// The pid alone proves nothing: Windows hands a dead host's pid to unrelated
// processes, and a claim naming `svchost.exe` would otherwise hold forever.
//
// This is a cooperative claim, not an OS lock: correctness does not depend on
// atomicity (the relay worker still enforces a single host); the claim only
// decides which process KEEPS retrying and which stands down.

import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { z } from 'zod';

// Three missed 30 s refreshes.
const CLAIM_STALE_MS = 90_000;

// Claims written before instance ids carry only `pid`.
const claimSchema = z.object({
  pid: z.coerce.number().int().positive(),
  instance: z.string().nullable().catch(null),
  host: z.string().nullable().catch(null),
  refreshedAt: z.number().catch(0),
});

/**
 * @param {{
 *   lockFilePath: string,
 *   fs?: typeof import('node:fs'),
 *   process?: NodeJS.Process,
 *   hostname?: string,
 *   now?: () => number,
 *   logger?: Pick<Console, 'warn'>,
 * }} deps
 */
export const createRelayHostLock = ({ lockFilePath, fs, process: proc, hostname = os.hostname(), now = Date.now, logger = console }) => {
  const fsImpl = fs;
  const selfPid = proc.pid;
  const selfInstance = randomUUID();

  const isPidAlive = (pid) => {
    try {
      proc.kill(pid, 0);
      return true;
    } catch (error) {
      // EPERM means the process exists but belongs to another user — treat as
      // alive; only ESRCH (no such process) means the claim is stale.
      return error?.code === 'EPERM';
    }
  };

  const readClaim = () => {
    try {
      const parsed = claimSchema.safeParse(JSON.parse(fsImpl.readFileSync(lockFilePath, 'utf8')));
      return parsed.success ? parsed.data : null;
    } catch {
      // Missing file or unparsable content: no valid claim.
      return null;
    }
  };

  const writeClaim = () => {
    try {
      fsImpl.writeFileSync(lockFilePath, JSON.stringify({ pid: selfPid, instance: selfInstance, host: hostname, refreshedAt: now() }));
      return true;
    } catch (error) {
      // An unwritable data dir must not take the relay down with it — fall back
      // to pre-lock behavior (start the host, let the relay worker arbitrate).
      logger.warn(`[Relay] could not write host claim file: ${error?.message ?? error}`);
      return true;
    }
  };

  const isOwn = (claim) => claim.instance === selfInstance;

  const isLive = (claim) => {
    if (isOwn(claim)) return true;
    // Claims from older builds carry no refresh time and are never refreshed,
    // so they read as stale too: an older build still hosting sees our claim
    // by its pid and stands down.
    if (now() - claim.refreshedAt >= CLAIM_STALE_MS) return false;
    if (claim.host !== null && claim.host !== hostname) return true;
    return isPidAlive(claim.pid);
  };

  /** The live claimant other than this process, or null when the claim is free, stale or ours. */
  const otherLiveClaimant = () => {
    const claim = readClaim();
    if (!claim || isOwn(claim) || !isLive(claim)) return null;
    return { pid: claim.pid, host: claim.host };
  };

  /** Claim unless another live process already holds it. Re-claiming our own refreshes it. */
  const tryClaim = () => {
    if (otherLiveClaimant() !== null) return false;
    return writeClaim();
  };

  /** Unconditional claim — explicit user intent (pairing) overrides any holder. */
  const forceClaim = () => writeClaim();

  /** Release only our own claim; never delete another process's. */
  const release = () => {
    const claim = readClaim();
    if (!claim || !isOwn(claim)) return;
    try {
      fsImpl.unlinkSync(lockFilePath);
    } catch {
      // Already gone or unwritable — nothing to do.
    }
  };

  return { tryClaim, forceClaim, otherLiveClaimant, release };
};
