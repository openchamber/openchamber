import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isRecord } from '../shared/object-guards.js';

const ENTRY = 'serve.mjs';
const MANIFEST = path.join('assets', 'manifest.json');
const MIN_BUNDLED_NODE_MAJOR = 22;
const MIN_BUNDLED_NODE_MINOR_FOR_22 = 16;
const MIN_BUNDLED_NODE_MAJOR_AFTER_22 = 24;
const nodeCompatibilityCache = new Map<string, boolean>();

export type BundledOpenCodeServerLaunch = {
  binary: string;
  args: string[];
  env: Record<string, string>;
  wrapperType: 'bundled-server';
};

const entries = (directories: ReadonlyArray<string | null | undefined>): string[] => directories
  .map((directory) => directory?.trim())
  .filter((directory): directory is string => Boolean(directory))
  .map((directory) => path.join(directory, ENTRY));

const canonicalPath = (candidate: string): string => {
  try {
    return fs.realpathSync.native(candidate.trim());
  } catch {
    return path.resolve(candidate.trim());
  }
};

const isFile = (candidate: string): boolean => {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
};

const isLinuxMusl = (): boolean => {
  if (process.platform !== 'linux') return false;
  try {
    const report: unknown = process.report?.getReport?.();
    if (!isRecord(report) || !isRecord(report.header)) return false;
    return !report.header.glibcVersionRuntime;
  } catch {
    return false;
  }
};

export const isSupportedBundledNodeVersion = (version: string | undefined | null): boolean => {
  if (!version) return false;
  const match = version.trim().replace(/^v/i, '').match(/^(\d+)\.(\d+)/);
  if (!match || match[1] === undefined || match[2] === undefined) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major >= MIN_BUNDLED_NODE_MAJOR_AFTER_22 || (major === MIN_BUNDLED_NODE_MAJOR && minor >= MIN_BUNDLED_NODE_MINOR_FOR_22);
};

export const canRunBundledOpenCodeServer = (
  resolveNodeBinary: () => string | null | undefined,
): boolean => {
  if (!process.versions.bun) {
    return Boolean(process.versions.electron) || isSupportedBundledNodeVersion(process.versions.node);
  }
  const nodeBinary = resolveNodeBinary()?.trim();
  if (!nodeBinary) return false;
  const key = canonicalPath(nodeBinary);
  const cached = nodeCompatibilityCache.get(key);
  if (cached !== undefined) return cached;
  const result = spawnSync(nodeBinary, [
    '-e',
    'process.stdout.write(process.versions.bun ? "bun" : (process.versions.node || ""))',
  ], {
    encoding: 'utf8',
    timeout: 5_000,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const output = result.status === 0 ? result.stdout.trim() : '';
  const supported = output !== 'bun' && isSupportedBundledNodeVersion(output);
  nodeCompatibilityCache.set(key, supported);
  return supported;
};

export const resolvePackageBundledOpenCodeServerDir = (
  moduleUrl: string = import.meta.url,
): string | null => {
  if (isLinuxMusl()) return null;
  const moduleDir = path.dirname(fileURLToPath(moduleUrl));
  const buildRoot = path.resolve(moduleDir, '..', '..', '..');
  if (path.basename(buildRoot) !== 'build') return null;
  const candidate = path.join(buildRoot, 'opencode-server');
  return isFile(path.join(candidate, ENTRY)) && isFile(path.join(candidate, MANIFEST)) ? candidate : null;
};

export const defaultBundledOpenCodeServerDirectories = (
  resourcesPath?: string | null,
): Array<string | null | undefined> => [
  process.env.OPENCHAMBER_BUNDLED_OPENCODE_SERVER_DIR,
  resourcesPath ? path.join(resourcesPath, 'opencode-server') : null,
  resolvePackageBundledOpenCodeServerDir(),
];

export const resolveBundledOpenCodeServer = (directories: ReadonlyArray<string | null | undefined>): string | null => (
  entries(directories).find(isFile) ?? null
);

export const isBundledOpenCodeServer = (
  candidate: string | null | undefined,
  directories: ReadonlyArray<string | null | undefined>,
): boolean => {
  if (!candidate?.trim()) return false;
  const canonical = canonicalPath(candidate);
  return entries(directories).some((entry) => canonicalPath(entry) === canonical);
};

const bundledServerEnv = () => {
  const env: BundledOpenCodeServerLaunch['env'] = { UV_THREADPOOL_SIZE: process.env.UV_THREADPOOL_SIZE || '32' };
  if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
  return env;
};

export const bundledOpenCodeServerLaunch = (
  entry: string,
  resolveNodeBinary: () => string | null | undefined,
): BundledOpenCodeServerLaunch => ({
  binary: process.versions.bun ? (resolveNodeBinary() || 'node') : process.execPath,
  args: [entry],
  env: bundledServerEnv(),
  wrapperType: 'bundled-server',
});

export const isRetiredBundledCliSetting = (configured: string): boolean => {
  const candidate = configured.trim().replace(/^(["'])(.*)\1$/, '$2').trim().replace(/[\\/]+$/, '');
  const retired = /openchamber[^\\/]*(?:\.app[\\/]Contents)?[\\/]resources[\\/]opencode-cli(?:[\\/]opencode(?:\.exe)?)?$/i;
  if (!retired.test(candidate) || fs.existsSync(candidate)) return false;
  console.warn(`settings.opencodeBinary points at the CLI older desktop builds shipped, which no longer exists; using the default OpenCode instead: ${candidate}`);
  return true;
};
