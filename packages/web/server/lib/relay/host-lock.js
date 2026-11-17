
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { z } from 'zod';

const CLAIM_STALE_MS = 90_000;

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
      // external: https://nodejs.org/api/process.html#processkillpid-signal EPERM does not establish that a process is absent, so a permission-denied claimant stays live.
      return error?.code === 'EPERM';
    }
  };

  const readClaim = () => {
    try {
      const parsed = claimSchema.safeParse(JSON.parse(fsImpl.readFileSync(lockFilePath, 'utf8')));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  };

  const writeClaim = () => {
    try {
      fsImpl.writeFileSync(lockFilePath, JSON.stringify({ pid: selfPid, instance: selfInstance, host: hostname, refreshedAt: now() }));
      return true;
    } catch (error) {
      logger.warn(`[Relay] could not write host claim file: ${error?.message ?? error}`);
      return true;
    }
  };

  const isOwn = (claim) => claim.instance === selfInstance;

  const isLive = (claim) => {
    if (isOwn(claim)) return true;
    if (now() - claim.refreshedAt >= CLAIM_STALE_MS) return false;
    if (claim.host !== null && claim.host !== hostname) return true;
    return isPidAlive(claim.pid);
  };

  const otherLiveClaimant = () => {
    const claim = readClaim();
    if (!claim || isOwn(claim) || !isLive(claim)) return null;
    return { pid: claim.pid, host: claim.host };
  };

  const tryClaim = () => {
    if (otherLiveClaimant() !== null) return false;
    return writeClaim();
  };

  const forceClaim = () => writeClaim();

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
