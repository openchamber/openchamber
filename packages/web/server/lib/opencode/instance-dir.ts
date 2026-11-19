export interface InstanceDirDependencies {
  fsPromises: Pick<typeof import('node:fs/promises'), 'readdir' | 'rm' | 'mkdir'>;
  path: Pick<typeof import('node:path'), 'join'>;
  dataDir: string;
  pid?: number;
  isPidAlive?: (pid: number) => boolean;
}

const hasCode = (error: unknown): error is { code?: unknown } => error != null;

export const prepareInstanceDir = async ({
  fsPromises,
  path,
  dataDir,
  pid = process.pid,
  isPidAlive = isProcessAlive,
}: InstanceDirDependencies) => {
  const instancesDir = path.join(dataDir, 'run', 'instances');
  const ownDir = path.join(instancesDir, String(pid));
  const entries = await fsPromises.readdir(instancesDir).catch(() => []);
  const abandoned = entries.filter((name) => /^\d+$/.test(name) && Number(name) !== pid && !isPidAlive(Number(name)));
  await Promise.all(abandoned.map((name) => fsPromises.rm(path.join(instancesDir, name), { recursive: true, force: true }).catch(() => {})));
  await fsPromises.mkdir(ownDir, { recursive: true, mode: 0o700 });
  return ownDir;
};

const isProcessAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return hasCode(error) && error.code === 'EPERM';
  }
};
