import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

interface PackageManifest {
  name: string;
  main: string;
  bin: { openchamber: string };
}

interface WebPackagePaths {
  root: string;
  packageJson: string;
  dist: string;
  cliEntry: string;
  serverEntry: string;
}

const pathsByDirectory = new Map<string, Readonly<WebPackagePaths>>();

const isMissingFileError = (cause: unknown): cause is NodeJS.ErrnoException =>
  cause !== null && typeof cause === 'object' && 'code' in cause
  && (cause.code === 'ENOENT' || cause.code === 'ENOTDIR');

export function getWebPackagePaths(moduleUrl: string | URL = import.meta.url) {
  const start = path.dirname(fileURLToPath(moduleUrl));
  const cached = pathsByDirectory.get(start);
  if (cached) return cached;

  let directory = start;
  for (;;) {
    const packageJson = path.join(directory, 'package.json');
    let manifest: PackageManifest | undefined;
    try {
      manifest = JSON.parse(fs.readFileSync(packageJson, 'utf8'));
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
    }
    if (manifest?.name === '@openchamber/web') {
      const paths = Object.freeze({
        root: directory,
        packageJson,
        dist: path.join(directory, 'dist'),
        cliEntry: path.resolve(directory, manifest.bin.openchamber),
        serverEntry: path.resolve(directory, manifest.main),
      });
      pathsByDirectory.set(start, paths);
      return paths;
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      throw new Error(`Could not find @openchamber/web package.json above ${fileURLToPath(moduleUrl)}`);
    }
    directory = parent;
  }
}

export const webPackagePaths = getWebPackagePaths();

export function findWebCheckoutRoot(webRoot = webPackagePaths.root) {
  let directory = path.dirname(webRoot);
  for (;;) {
    if (path.join(directory, 'packages', 'web') === webRoot) {
      try {
        const manifest: PackageManifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
        if (manifest.name === 'openchamber-monorepo') return directory;
      } catch (error) {
        if (!isMissingFileError(error)) throw error;
      }
    }
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}
