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
import { readBoundedFileSync } from '../shared/bounded-file-read.js';

// Three missed 30 s refreshes.
const CLAIM_STALE_MS = 90_000;

// The writer's own claim is ~120 bytes (pid, instance UUID, host,
// refreshedAt). 64 KiB leaves over 500x headroom while keeping the
// claim-watch read bounded (#1739): the claim file lives in a data dir
// that may be a synced or network folder, so its size and type are not
// under this process's control, and a FIFO or a grown file at the claim
// path must answer "no valid claim" promptly instead of freezing the
// server's event loop on the 30 s claim watch.
export const RELAY_HOST_CLAIM_MAX_BYTES = 64 * 1024;

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
export const createRelayHostLock = ({ lockFilePath, fs, process: proc, hostname = os.hostname(), now = Date.now, logger = console, boundedReadSync = readBoundedFileSync }) => {
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
      // Bounded, handle-judged read (#1739): missing, non-regular (a FIFO
      // at the claim path), and over-cap files all answer no valid claim,
      // exactly as missing and unparsable files always have; the reader
      // opens with O_NONBLOCK and enforces the cap during the read, so
      // none of them can block or buffer whole.
      const result = boundedReadSync(lockFilePath, RELAY_HOST_CLAIM_MAX_BYTES);
      if (!result.ok) return null;
      const parsed = claimSchema.safeParse(JSON.parse(result.buffer.toString('utf8')));
      return parsed.success ? parsed.data : null;
    } catch {
      // Unparsable content or an unexpected I/O error: no valid claim.
      return null;
    }
  };

  const writeClaim = () => {
    try {
      // A non-regular file (e.g. a FIFO) at the claim path must never be
      // opened for write either: opening a FIFO for write blocks until a
      // reader appears. Answer with the same pre-lock fallback as an
      // unwritable data dir below (start the host, let the relay worker
      // arbitrate) instead of freezing on the claim watch (#1739).
      const existing = boundedReadSync(lockFilePath, RELAY_HOST_CLAIM_MAX_BYTES);
      if (!existing.ok && existing.reason === 'not-regular') return true;
    } catch {
      // A failed probe must not stop the write attempt below.
    }
    const payload = JSON.stringify({ pid: selfPid, instance: selfInstance, host: hostname, refreshedAt: now() });
    let fd;
    try {
      // The probe above judges the path before the write, but a FIFO swapped
      // in after it would still block a by-path write open (#1823). Open with
      // O_NONBLOCK (a FIFO with no reader refuses at once instead of
      // blocking) and judge the opened handle: a non-regular handle is never
      // written, exactly as the probe's not-regular verdict above answers.
      const flags = fsImpl.constants.O_WRONLY
        | fsImpl.constants.O_CREAT
        | fsImpl.constants.O_TRUNC
        | (proc.platform === 'win32' ? 0 : fsImpl.constants.O_NONBLOCK);
      fd = fsImpl.openSync(lockFilePath, flags, 0o666);
      if (!fsImpl.fstatSync(fd).isFile()) {
        fsImpl.closeSync(fd);
        fd = undefined;
        return true;
      }
      fsImpl.writeSync(fd, payload);
      fsImpl.closeSync(fd);
      fd = undefined;
      return true;
    } catch (error) {
      if (fd !== undefined) {
        try {
          fsImpl.closeSync(fd);
        } catch {
          // The handle may already be gone; the write failure below stands.
        }
      }
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
