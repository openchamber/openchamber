import fs from 'node:fs';
import path from 'node:path';

const ENTRY = 'serve.mjs';

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

export const bundledOpenCodeServerLaunch = (
  entry: string,
  resolveNodeBinary: () => string | null | undefined,
): BundledOpenCodeServerLaunch => ({
  binary: process.versions.bun ? (resolveNodeBinary() || 'node') : process.execPath,
  args: [entry],
  env: process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {},
  wrapperType: 'bundled-server',
});

export const isRetiredBundledCliSetting = (configured: string): boolean => {
  const candidate = configured.trim().replace(/^(["'])(.*)\1$/, '$2').trim().replace(/[\\/]+$/, '');
  const retired = /openchamber[^\\/]*(?:\.app[\\/]Contents)?[\\/]resources[\\/]opencode-cli(?:[\\/]opencode(?:\.exe)?)?$/i;
  if (!retired.test(candidate) || fs.existsSync(candidate)) return false;
  console.warn(`settings.opencodeBinary points at the CLI older desktop builds shipped, which no longer exists; using the default OpenCode instead: ${candidate}`);
  return true;
};
