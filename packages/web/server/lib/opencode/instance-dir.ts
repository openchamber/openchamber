import { constants as fsConstants } from 'node:fs';
import { isString } from '../shared/object-guards.js';
export interface InstanceDirDependencies {
  fsPromises: Pick<typeof import('node:fs/promises'), 'readdir' | 'rm' | 'mkdir' | 'writeFile' | 'open'>;
  path: Pick<typeof import('node:path'), 'join' | 'dirname' | 'basename'>;
  dataDir: string;
  pid?: number;
  isPidAlive?: (pid: number) => boolean;
  // The folder the saved managed state names, taken over when its owner is
  // this process, the server handing off to it, or gone.
  claimDir?: string | null;
  handoffFrom?: number | null;
}

const hasCode = (error: unknown): error is { code?: unknown } => error != null;

export const prepareInstanceDir = async ({
  fsPromises,
  path,
  dataDir,
  pid = process.pid,
  isPidAlive = isProcessAlive,
  claimDir = null,
  handoffFrom = null,
}: InstanceDirDependencies) => {
  const instancesDir = path.join(dataDir, 'run', 'instances');
  const entries = await fsPromises.readdir(instancesDir).catch(() => []);
  const folders = entries.filter((name) => /^\d+$/.test(name));
  const owners = new Map<string, number>(await Promise.all(folders.map(async (name): Promise<[string, number]> => [name, await readOwner(fsPromises, path.join(instancesDir, name, OWNER_FILE), Number(name))])));

  // Only a folder directly under instancesDir is claimed, never a path the state file names elsewhere.
  const claimName = isString(claimDir) && path.dirname(claimDir) === instancesDir ? path.basename(claimDir) : null;
  const claimOwner = claimName === null ? null : owners.get(claimName);
  const claimed = claimOwner !== undefined && claimOwner !== null
    && (claimOwner === pid || claimOwner === handoffFrom || !isPidAlive(claimOwner));

  const abandoned = folders.filter((name) => {
    if (claimed && name === claimName) return false;
    const owner = owners.get(name) ?? Number(name);
    return owner !== pid && !isPidAlive(owner);
  });
  await Promise.all(abandoned.map((name) => fsPromises.rm(path.join(instancesDir, name), { recursive: true, force: true }).catch(() => {})));

  if (claimed && claimName !== null) {
    const dir = path.join(instancesDir, claimName);
    await fsPromises.writeFile(path.join(dir, OWNER_FILE), `${pid}\n`, { mode: 0o600 });
    return dir;
  }
  const ownDir = path.join(instancesDir, String(pid));
  await fsPromises.mkdir(ownDir, { recursive: true, mode: 0o700 });
  return ownDir;
};

const OWNER_FILE = 'owner';

// The server writes the owner as one pid line (`${pid}\n`), so anything
// past a few dozen bytes is not an owner file this code wrote. The cap is
// enforced on the opened handle during the read, and the open is
// non-blocking on POSIX: this read runs for every instance folder on the
// startup path, before the listener exists, so a FIFO or a grown file at
// an owner path must refuse promptly into the fallback instead of
// wedging or buffering whole (#1793).
const OWNER_FILE_MAX_BYTES = 64;
const OWNER_OPEN_FLAGS = fsConstants.O_RDONLY | (process.platform === 'win32' ? 0 : fsConstants.O_NONBLOCK);

// The pid in `owner` when a server claimed the folder, otherwise the pid it is named after.
// Every refusal — missing, unreadable, non-regular, over-cap — takes the fallback.
const readOwner = async (fsPromises: Pick<typeof import('node:fs/promises'), 'open'>, ownerPath: string, fallback: number) => {
  let handle;
  try {
    handle = await fsPromises.open(ownerPath, OWNER_OPEN_FLAGS);
  } catch {
    return fallback;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > OWNER_FILE_MAX_BYTES) return fallback;
    const buffer = Buffer.alloc(OWNER_FILE_MAX_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > OWNER_FILE_MAX_BYTES) return fallback;
    const owner = Number.parseInt(buffer.toString('utf8', 0, bytesRead).trim(), 10);
    return Number.isInteger(owner) && owner > 0 ? owner : fallback;
  } catch {
    return fallback;
  } finally {
    await handle.close().catch(() => {});
  }
};

const isProcessAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return hasCode(error) && error.code === 'EPERM';
  }
};
