
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

interface RelayHostLockDependencies {
  lockFilePath: string;
  fs: Pick<typeof import('node:fs'), 'readFileSync' | 'writeFileSync' | 'unlinkSync'>;
  process: Pick<NodeJS.Process, 'pid' | 'kill'>;
  hostname?: string;
  now?: () => number;
  logger?: Pick<Console, 'warn'>;
}

type HostClaim = z.infer<typeof claimSchema>;
export type RelayHostLock = ReturnType<typeof createRelayHostLock>;

const hasErrorCode = (value: unknown): value is { code: unknown } => value !== null && typeof value === 'object' && 'code' in value;
const hasErrorMessage = (value: unknown): value is { message: unknown } => value !== null && typeof value === 'object' && 'message' in value;

export const createRelayHostLock = ({ lockFilePath, fs, process: proc, hostname = os.hostname(), now = Date.now, logger = console }: RelayHostLockDependencies) => {
  const fsImpl = fs;
  const selfPid = proc.pid;
  const selfInstance = randomUUID();

  const isPidAlive = (pid: number) => {
    try {
      proc.kill(pid, 0);
      return true;
    } catch (error) {
      return hasErrorCode(error) && error.code === 'EPERM';
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
      logger.warn(`[Relay] could not write host claim file: ${(hasErrorMessage(error) ? error.message : undefined) ?? error}`);
      return true;
    }
  };

  const isOwn = (claim: HostClaim) => claim.instance === selfInstance;

  const isLive = (claim: HostClaim) => {
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
      return;
    }
  };

  return { tryClaim, forceClaim, otherLiveClaimant, release };
};
