import type nodeFsPromises from 'node:fs/promises';

type FsPromises = typeof nodeFsPromises;

export class DanglingLinkError extends Error {}

const hasErrorCode = (value: unknown): value is { code?: unknown } => (
  value !== null && value !== undefined && 'code' in Object(value)
);

const overwriteOpenFile = async (handle: Awaited<ReturnType<FsPromises['open']>>, data: Buffer) => {
  try {
    await handle.writeFile(data);
    await handle.truncate(data.length);
  } finally {
    await handle.close();
  }
};

const createFile = async (fsPromises: FsPromises, filePath: string, data: Buffer) => {
  try {
    await fsPromises.writeFile(filePath, data, { flag: 'wx' });
  } catch (error) {
    if (!hasErrorCode(error) || error.code !== 'EEXIST') throw error;
    if ((await fsPromises.lstat(filePath)).isSymbolicLink()) throw new DanglingLinkError(filePath);
    await overwriteOpenFile(await fsPromises.open(filePath, 'r+'), data);
  }
};

const writeInPlace = async (fsPromises: FsPromises, filePath: string, content: string) => {
  const existing = await fsPromises.readFile(filePath, 'utf8').catch(() => null);
  if (existing === content) return;
  const data = Buffer.from(content, 'utf8');
  let handle: Awaited<ReturnType<FsPromises['open']>>;
  try {
    handle = await fsPromises.open(filePath, 'r+');
  } catch (error) {
    if (!hasErrorCode(error) || error.code !== 'ENOENT') throw error;
    await createFile(fsPromises, filePath, data);
    return;
  }
  await overwriteOpenFile(handle, data);
};

export const createKeyedSerializer = () => {
  const pending = new Map<string, Promise<void>>();

  return <T>(key: string, task: () => Promise<T>): Promise<T> => {
    const previous = pending.get(key) ?? Promise.resolve();
    const run = previous.then(task);
    const settled = run.then(() => {}, () => {});
    pending.set(key, settled);
    void settled.then(() => {
      if (pending.get(key) === settled) pending.delete(key);
    });
    return run;
  };
};

export const createTextFileWriter = (fsPromises: FsPromises) => {
  const serialize = createKeyedSerializer();
  return (filePath: string, content: string) => serialize(filePath, () => writeInPlace(fsPromises, filePath, content));
};
