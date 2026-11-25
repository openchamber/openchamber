import { execFile, spawn } from 'node:child_process';
import type { ChildProcess, ChildProcessWithoutNullStreams } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const LEASES_PER_CONNECTION = 4;
const OPEN_TIMEOUT_MS = 15_000;
const CONNECT_TIMEOUT_SECONDS = 10;
const PROOF_TTL_MS = 5_000;
const PROOF_TIMEOUT_MS = 3_000;
const SPARE_IDLE_MS = 60_000;
const LAST_IDLE_MS = 10 * 60_000;
const CLOSE_GRACE_MS = 5_000;
const RETRY_BASE_MS = 5_000;
const RETRY_CAP_MS = 60_000;
const SOCKET_PATH_BYTES = 103 - 17;
const SHELL_UNSAFE = /[\p{Cc}'$%]/u;
const DOCKER_HOST = /^ssh:\/\/(?:([^@:/]+)@)?([^@:/]+)(?::(\d+))?$/;

type SpawnGuard = (pid: number) => ChildProcess;
type SpawnMaster = (file: string, args: string[]) => ChildProcessWithoutNullStreams;

export interface SshLease {
  path: string | null;
  release: (options?: { killed: boolean }) => void;
}

export interface SshConnections {
  lease: (spaceId: string | null) => Promise<SshLease>;
  close: () => void;
}

export interface SshConnectionsOptions {
  dockerHost: string;
  directory: string;
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  spawnMaster?: SpawnMaster;
  spawnGuard?: SpawnGuard;
  onExit?: (callback: () => void) => () => void;
  now?: () => number;
  lastIdleMs?: number;
}

interface Connection {
  spaceId: string | null;
  child: ChildProcessWithoutNullStreams;
  folder: string;
  leases: number;
  provenAt: number;
  proof: Promise<boolean> | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

const spawnProcess: SpawnMaster = (file, args) => spawn(file, args, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });

const spawnGuardProcess: SpawnGuard = (pid) => spawn('/bin/sh', ['-c', 'read -r line; kill -TERM "$1"', 'sh', String(pid)], { shell: false, stdio: ['pipe', 'ignore', 'ignore'] });

const onProcessExit = (callback: () => void) => {
  process.prependListener('exit', callback);
  return () => { process.removeListener('exit', callback); };
};

const within = (work: Promise<boolean>, milliseconds: number) => new Promise<boolean>((resolve) => {
  const timer = setTimeout(() => resolve(false), Math.max(0, milliseconds));
  void work.then((value) => { clearTimeout(timer); resolve(value); });
});

const signal = (child: Pick<ChildProcess, 'kill'>, name: NodeJS.Signals) => {
  try {
    child.kill(name);
  } catch {
    return;
  }
};

const findSsh = (searchPath: string) => searchPath.split(path.delimiter).filter((folder) => path.isAbsolute(folder)).map((folder) => path.join(folder, 'ssh')).find((file) => {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
});

const destinationArgs = (dockerHost: string) => {
  const [, user, host, port] = DOCKER_HOST.exec(dockerHost) ?? [];
  if (host === undefined) return null;
  return [...(user === undefined ? [] : ['-l', user]), ...(port === undefined ? [] : ['-p', port]), '--', host];
};

const MAC_ACL_GRANT = /^ ?\d+: .*\ballow\b/m;
const ACL_TIMEOUT_MS = 5_000;

const hasNoAclGrant = (folders: string[]) => (process.platform !== 'darwin' ? Promise.resolve(true) : new Promise<boolean>((resolve) => {
  execFile('/bin/ls', ['-lden', ...folders], { timeout: ACL_TIMEOUT_MS, env: { LC_ALL: 'C' } }, (error, stdout) => resolve(error === null && !MAC_ACL_GRANT.test(stdout)));
}));

const isOwnersOnly = async (directory: string) => {
  const uid = process.getuid?.();
  const folders: string[] = [directory];
  for (let folder = directory; path.dirname(folder) !== folder; folder = path.dirname(folder)) folders.unshift(path.dirname(folder));
  for (const folder of folders) {
    const { uid: owner, mode } = await fs.promises.stat(folder);
    if (owner !== uid && owner !== 0) return false;
    if (owner === uid && (mode & 0o077) === 0) break;
    if ((mode & 0o022) !== 0 && (mode & 0o1000) === 0) return false;
  }
  return hasNoAclGrant(folders);
};

const isGone = (pid: number) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'ESRCH';
  }
};

const removeAbandoned = (directory: string) => {
  for (const name of fs.readdirSync(directory)) {
    const pid = Number(/^(\d+)-/.exec(name)?.[1]);
    if (pid > 1 && isGone(pid)) fs.rmSync(path.join(directory, name), { recursive: true, force: true });
  }
};

const PLAIN: SshLease = { path: null, release: () => {} };

export function createSshConnections({ dockerHost, directory, environment = process.env, platform = process.platform, spawnMaster = spawnProcess, spawnGuard = spawnGuardProcess, onExit = onProcessExit, now = Date.now, lastIdleMs = LAST_IDLE_MS }: SshConnectionsOptions): SshConnections {
  const searchPath = environment.PATH ?? '';
  const destination = destinationArgs(dockerHost);
  const ssh = platform === 'win32' ? undefined : findSsh(searchPath);
  let root = path.join(directory, `${process.pid}-${crypto.randomBytes(3).toString('hex')}`);
  const socketOf = (folder: string) => path.join(folder, 's');
  const isRootUsable = () => !SHELL_UNSAFE.test(root)
    && Buffer.byteLength(socketOf(path.join(root, '000'))) <= SOCKET_PATH_BYTES;
  const shareable = ssh !== undefined && destination !== null && !SHELL_UNSAFE.test(`${ssh}${searchPath}`) && isRootUsable();

  let closed = false;
  let opened = 0;
  let prepared: boolean | null = null;
  let failures = 0;
  let retryAt = -Infinity;
  let current: Connection[] = [];
  const alive = new Set<Connection>();
  let forgetExit: (() => void) | null = null;

  const removeFolder = (folder: string) => {
    try {
      fs.rmSync(folder, { recursive: true, force: true });
    } catch {
      return;
    }
  };

  const endAll = () => {
    for (const connection of alive) signal(connection.child, 'SIGTERM');
    removeFolder(root);
  };

  const prepareFolder = (file: string) => {
    if (opened === 0) {
      fs.mkdirSync(root, { mode: 0o700 });
      forgetExit = onExit(endAll);
    }
    opened += 1;
    const folder = path.join(root, String(opened));
    fs.mkdirSync(folder, { mode: 0o700 });
    fs.writeFileSync(path.join(folder, 'ssh'), `#!/bin/sh\nPATH='${searchPath}'\nexport PATH\nexec '${file}' -S '${socketOf(folder)}' -o ControlMaster=no "$@"\n`, { mode: 0o700 });
    return folder;
  };

  const retire = (connection: Connection) => {
    current = current.filter((candidate) => candidate !== connection);
    if (connection.idleTimer) clearTimeout(connection.idleTimer);
    connection.idleTimer = null;
    connection.child.stdin.end();
    if (connection.leases === 0) signal(connection.child, 'SIGTERM');
  };

  const echo = (connection: Connection) => new Promise<boolean>((resolve) => {
    const { child } = connection;
    const mark = crypto.randomBytes(12).toString('hex');
    let heard = '';
    const settle = (answer: boolean) => {
      child.stdout.off('data', listen);
      child.off('close', fail);
      child.off('error', fail);
      if (answer) connection.provenAt = now();
      resolve(answer);
    };
    const listen = (chunk: Buffer) => {
      heard = (heard + chunk.toString('latin1')).slice(-4096);
      if (heard.includes(mark)) settle(true);
    };
    const fail = () => settle(false);
    child.stdout.on('data', listen);
    child.once('close', fail);
    child.once('error', fail);
    child.stdin.write(`${mark}\n`);
  });

  const prove = (connection: Connection, timeoutMs: number) => {
    connection.proof ??= within(echo(connection), timeoutMs).finally(() => { connection.proof = null; });
    return connection.proof;
  };

  const pauseOpening = () => {
    retryAt = now() + Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** failures);
    failures += 1;
  };

  const expireWhenIdle = (connection: Connection) => {
    if (!current.includes(connection)) return;
    const spare = current.some((candidate) => candidate !== connection && candidate.spaceId === connection.spaceId);
    connection.idleTimer = setTimeout(() => retire(connection), spare ? SPARE_IDLE_MS : lastIdleMs);
    connection.idleTimer.unref();
  };

  const prepareRoot = async () => {
    try {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      const checked = fs.realpathSync(directory);
      if (!await isOwnersOnly(checked)) return false;
      root = path.join(checked, path.basename(root));
      if (!isRootUsable()) return false;
      removeAbandoned(checked);
      return true;
    } catch {
      return false;
    }
  };

  const openConnection = (spaceId: string | null) => {
    if (prepared !== true || ssh === undefined || destination === null) return;
    let folder: string;
    let child: ChildProcessWithoutNullStreams;
    try {
      folder = prepareFolder(ssh);
      child = spawnMaster(ssh, [
        '-T', '-a', '-x', '-S', socketOf(folder),
        '-o', 'ControlMaster=yes', '-o', 'ControlPersist=no', '-o', 'BatchMode=yes', '-o', 'ClearAllForwardings=yes',
        '-o', `ConnectTimeout=${CONNECT_TIMEOUT_SECONDS}`, '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
        ...destination, 'cat',
      ]);
    } catch {
      pauseOpening();
      return;
    }
    const guard = child.pid === undefined ? null : spawnGuard(child.pid);
    const unguarded = () => signal(child, 'SIGTERM');
    guard?.on('error', unguarded);
    guard?.on('exit', unguarded);
    guard?.stdin?.on('error', () => {});
    guard?.unref();
    const connection: Connection = { spaceId, child, folder, leases: 0, provenAt: -Infinity, proof: null, idleTimer: null };
    alive.add(connection);
    current.push(connection);
    const gone = () => {
      if (guard) signal(guard, 'SIGKILL');
      alive.delete(connection);
      retire(connection);
      removeFolder(folder);
    };
    child.on('error', gone);
    child.on('exit', gone);
    child.stdin.on('error', () => {});
    child.stdout.resume();
    child.stderr.resume();
    void prove(connection, OPEN_TIMEOUT_MS).then((ready) => {
      if (ready) {
        failures = 0;
        retryAt = -Infinity;
        if (connection.leases === 0) expireWhenIdle(connection);
        return;
      }
      signal(child, 'SIGTERM');
      retire(connection);
      pauseOpening();
    });
  };

  const open = (spaceId: string | null) => {
    if (prepared !== null) {
      openConnection(spaceId);
      return;
    }
    prepared = false;
    void prepareRoot().then((usable) => {
      if (closed) return;
      if (usable) {
        prepared = true;
        openConnection(spaceId);
        return;
      }
      prepared = null;
      pauseOpening();
    });
  };

  const isUsable = async (connection: Connection) => {
    if (now() - connection.provenAt < PROOF_TTL_MS) return true;
    const usable = await prove(connection, PROOF_TIMEOUT_MS);
    if (!usable) retire(connection);
    return usable;
  };

  const release = (connection: Connection) => {
    connection.leases -= 1;
    if (connection.leases > 0) return;
    if (!current.includes(connection)) {
      signal(connection.child, 'SIGTERM');
      return;
    }
    expireWhenIdle(connection);
  };

  const isProven = (connection: Connection) => connection.provenAt !== -Infinity;

  const take = (spaceId: string | null) => {
    const free = current.filter((connection) => connection.spaceId === spaceId && connection.leases < LEASES_PER_CONNECTION);
    if (free.length === 0 && now() >= retryAt) open(spaceId);
    const connection = free.find(isProven);
    if (connection === undefined) return null;
    connection.leases += 1;
    if (connection.idleTimer) clearTimeout(connection.idleTimer);
    connection.idleTimer = null;
    return connection;
  };

  const lease = async (spaceId: string | null): Promise<SshLease> => {
    if (!shareable || closed) return PLAIN;
    const connection = take(spaceId);
    if (connection === null) return PLAIN;
    if (!await isUsable(connection) || closed || !current.includes(connection)) {
      release(connection);
      if (!closed && now() >= retryAt && !current.some((candidate) => candidate.spaceId === spaceId)) open(spaceId);
      return PLAIN;
    }
    let released = false;
    return {
      path: `${connection.folder}${path.delimiter}${searchPath}`,
      release: ({ killed } = { killed: false }) => {
        if (released) return;
        released = true;
        if (killed) retire(connection);
        release(connection);
      },
    };
  };

  const close = () => {
    if (closed) return;
    closed = true;
    for (const connection of [...current]) retire(connection);
    const finish = () => {
      endAll();
      forgetExit?.();
      forgetExit = null;
    };
    if (alive.size === 0) {
      finish();
      return;
    }
    setTimeout(finish, CLOSE_GRACE_MS).unref?.();
  };

  return { lease, close };
}
