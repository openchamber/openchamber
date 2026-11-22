
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { z } from 'zod';
import { readBoundedFileSync } from '../shared/bounded-file-read.js';

const CLAIM_STALE_MS = 90_000;

// The writer's own claim is ~120 bytes (pid, instance UUID, host,
// refreshedAt). 64 KiB leaves over 500x headroom while keeping the
// claim-watch read bounded (#1739): the claim file lives in a data dir
// that may be a synced or network folder, so its size and type are not
// under this process's control, and a FIFO or a grown file at the claim
// path must answer "no valid claim" promptly instead of freezing the
// server's event loop on the 30 s claim watch.
export const RELAY_HOST_CLAIM_MAX_BYTES = 64 * 1024;

const claimSchema = z.object({
  pid: z.coerce.number().int().positive(),
  instance: z.string().nullable().catch(null),
  host: z.string().nullable().catch(null),
  refreshedAt: z.number().catch(0),
});

interface RelayHostLockDependencies {
  lockFilePath: string;
  fs: Pick<typeof import('node:fs'), 'readFileSync' | 'writeFileSync' | 'unlinkSync' | 'constants' | 'openSync' | 'fstatSync' | 'closeSync' | 'writeSync'>;
  process: Pick<NodeJS.Process, 'pid' | 'kill' | 'platform'>;
  hostname?: string;
  now?: () => number;
  logger?: Pick<Console, 'warn'>;
  boundedReadSync?: typeof readBoundedFileSync;
}

type HostClaim = z.infer<typeof claimSchema>;
export type RelayHostLock = ReturnType<typeof createRelayHostLock>;

const hasErrorCode = (value: unknown): value is { code: unknown } => value !== null && typeof value === 'object' && 'code' in value;
const hasErrorMessage = (value: unknown): value is { message: unknown } => value !== null && typeof value === 'object' && 'message' in value;


export const createRelayHostLock = ({ lockFilePath, fs, process: proc, hostname = os.hostname(), now = Date.now, logger = console, boundedReadSync = readBoundedFileSync }: RelayHostLockDependencies) => {
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
