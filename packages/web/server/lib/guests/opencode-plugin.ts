import path from 'node:path';
import type fs from 'node:fs/promises';
import type { JsonValue } from './contracts.js';
import { isString, isJsonObject, isJsonContainer } from './input-guards.js';

type PluginFiles = Pick<typeof fs, 'realpath' | 'stat' | 'readFile'>;
export type OpenCodePluginDelivery = 'file' | 'restart' | 'none' | 'remote';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

const isLoopbackOrigin = (origin: string | null) => {
  if (!origin) return true;
  try {
    return LOOPBACK_HOSTS.has(new URL(origin).hostname.toLowerCase());
  } catch {
    return false;
  }
};

export const openCodePluginDelivery = ({ external, origin, ownsConfigFile }: { external: boolean; origin: string | null; ownsConfigFile: boolean }): OpenCodePluginDelivery => {
  if (external) return isLoopbackOrigin(origin) ? 'none' : 'remote';
  return ownsConfigFile ? 'file' : 'restart';
};

const ENTRY_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs', '.cts', '.cjs'];
const EXPORT_CONDITIONS = new Set(['bun', 'node', 'import', 'default']);

const exportedFile = (value: JsonValue | undefined): string | null => {
  if (isString(value)) return value;
  if (!isJsonContainer(value)) return null;
  for (const [condition, target] of Object.entries(value)) {
    const file = EXPORT_CONDITIONS.has(condition) ? exportedFile(target) : null;
    if (file) return file;
  }
  return null;
};

const exportTarget = (exported: JsonValue | undefined, subpath: string) => {
  const bare = isString(exported) || !Object.keys(exported ?? {}).some((key) => key.startsWith('.'));
  return exportedFile(bare ? (subpath === '.' ? exported : undefined) : isJsonObject(exported) ? exported[subpath] : undefined);
};

const entryCandidates = (manifest: JsonValue) => {
  if (isJsonObject(manifest) && isString(manifest.name) && manifest.exports !== undefined) {
    return ['./server', '.'].map((subpath) => exportTarget(manifest.exports, subpath)).filter((file): file is string => !!file);
  }
  return ['server', 'index'].flatMap((base) => ENTRY_EXTENSIONS.map((extension) => base + extension));
};

const readManifest = async (fsPromises: PluginFiles, directory: string): Promise<JsonValue> => {
  try {
    return JSON.parse(await fsPromises.readFile(path.join(directory, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
};

const isFileInside = async (fsPromises: PluginFiles, directory: string, target: string) => {
  try {
    const file = await fsPromises.realpath(path.resolve(directory, target));
    return file.startsWith(directory + path.sep) && (await fsPromises.stat(file)).isFile();
  } catch {
    return false;
  }
};

export const resolveOpenCodePluginFolder = async (fsPromises: PluginFiles, packageRoot: string, relativePath: string) => {
  try {
    const rootReal = await fsPromises.realpath(packageRoot);
    const directory = await fsPromises.realpath(path.resolve(rootReal, relativePath));
    if (!directory.startsWith(rootReal + path.sep) || !(await fsPromises.stat(directory)).isDirectory()) return null;
    for (const entry of entryCandidates(await readManifest(fsPromises, directory))) {
      if (await isFileInside(fsPromises, directory, entry)) return directory;
    }
    return null;
  } catch {
    return null;
  }
};
