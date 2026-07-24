import type { FilesAPI } from '@/lib/api/types';
import { subscribeRuntimeEndpointWillChange } from '@/lib/runtime-switch';

const MAX_ENTRIES = 40;
const MAX_BYTES = 20 * 1024 * 1024;
type Entry = { content: string; path: string; sourcePath: string; size: number; mtimeMs: number; bytes: number };

export function createContentCachedFiles(files: FilesAPI): { files: FilesAPI; dispose: () => void } {
  const cache = new Map<string, Entry>();
  let totalBytes = 0;
  let generation = 0;
  let active = true;
  let mutationBarrier = Promise.resolve();

  const cacheKey = (path: string, options?: Parameters<NonNullable<FilesAPI['readFile']>>[1]) =>
    JSON.stringify([options?.directory ?? '', path]);
  const contentBytes = (content: string) => new TextEncoder().encode(content).byteLength;
  const removeEntry = (key: string) => {
    const entry = cache.get(key);
    if (entry) totalBytes = Math.max(0, totalBytes - entry.bytes);
    cache.delete(key);
  };
  const removePrefix = (path: string) => {
    const prefix = path.endsWith('/') ? path : `${path}/`;
    for (const [key, entry] of cache) {
      if (entry.sourcePath === path || entry.sourcePath.startsWith(prefix)) removeEntry(key);
    }
  };
  const metadataMatches = (cached: Entry, latest: { isFile: boolean; size: number; mtimeMs?: number }) => (
    latest.isFile
    && latest.mtimeMs !== undefined
    && cached.mtimeMs === latest.mtimeMs
    && cached.size === latest.size
  );
  const cacheResult = (
    key: string,
    sourcePath: string,
    result: { content: string; path: string },
    stat: { isFile: boolean; size: number; mtimeMs?: number },
  ) => {
    if (!active || !stat.isFile || stat.mtimeMs === undefined) return result;
    const bytes = contentBytes(result.content);
    if (bytes > MAX_BYTES) return result;
    removeEntry(key);
    cache.set(key, { ...result, sourcePath, size: stat.size, mtimeMs: stat.mtimeMs, bytes });
    totalBytes += bytes;
    while (cache.size > MAX_ENTRIES || totalBytes > MAX_BYTES) {
      const oldest = cache.keys().next().value;
      if (!oldest) break;
      removeEntry(oldest);
    }
    return result;
  };

  const readFresh = async (
    key: string,
    path: string,
    options: Parameters<NonNullable<FilesAPI['readFile']>>[1] | undefined,
    capturedGeneration: number,
  ): Promise<{ content: string; path: string }> => {
    const before = await files.statFile?.(path, options).catch(() => null);
    const result = await files.readFile!(path, options);
    const after = await files.statFile?.(path, options).catch(() => null);
    if (!active) throw new Error('File read invalidated by runtime change');
    if (capturedGeneration !== generation) return cachedReadFile!(path, options);
    const stable = before && after && before.isFile && after.isFile
      && before.mtimeMs !== undefined && after.mtimeMs !== undefined
      && before.size === after.size && before.mtimeMs === after.mtimeMs;
    return stable ? cacheResult(key, path, result, after) : result;
  };

  const cachedReadFile: FilesAPI['readFile'] = files.readFile
    ? async (path, options) => {
        await mutationBarrier;
        if (!active) throw new Error('File cache owner disposed');
        const capturedGeneration = generation;
        if (options?.allowOutsideWorkspace) return files.readFile!(path, options);
        const key = cacheKey(path, options);
        const hit = cache.get(key);
        if (!hit) return readFresh(key, path, options, capturedGeneration);
        const latest = await files.statFile?.(path, options).catch(() => null);
        if (!active) throw new Error('File read invalidated by runtime change');
        if (capturedGeneration !== generation) return cachedReadFile!(path, options);
        if (!latest || !metadataMatches(hit, latest)) {
          removeEntry(key);
          return readFresh(key, path, options, capturedGeneration);
        }
        cache.delete(key);
        cache.set(key, hit);
        return { content: hit.content, path: hit.path };
      }
    : undefined;

  const mutate = async <T>(paths: string[], operation: () => Promise<T>): Promise<T> => {
    const previous = mutationBarrier;
    let release!: () => void;
    mutationBarrier = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    generation += 1;
    paths.forEach(removePrefix);
    try {
      return await operation();
    } finally {
      paths.forEach(removePrefix);
      generation += 1;
      release();
    }
  };

  const cachedFiles: FilesAPI = {
    ...files,
    readFile: cachedReadFile,
    writeFile: files.writeFile ? (path, content) => mutate([path], () => files.writeFile!(path, content)) : undefined,
    delete: files.delete ? (path) => mutate([path], () => files.delete!(path)) : undefined,
    rename: files.rename ? (oldPath, newPath) => mutate([oldPath, newPath], () => files.rename!(oldPath, newPath)) : undefined,
  };
  const unsubscribeRuntime = subscribeRuntimeEndpointWillChange((detail) => {
    if (detail.runtimeKey === detail.previousRuntimeKey) return;
    active = false;
    generation += 1;
    cache.clear();
    totalBytes = 0;
  });
  return {
    files: cachedFiles,
    dispose: () => {
      active = false;
      generation += 1;
      cache.clear();
      totalBytes = 0;
      unsubscribeRuntime();
    },
  };
}
