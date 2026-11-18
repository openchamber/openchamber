import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pathsByDirectory = new Map();

export function getWebPackagePaths(moduleUrl = import.meta.url) {
  const start = path.dirname(fileURLToPath(moduleUrl));
  const cached = pathsByDirectory.get(start);
  if (cached) return cached;

  let directory = start;
  for (;;) {
    const packageJson = path.join(directory, 'package.json');
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(packageJson, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
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

// A checkout owns this web package at packages/web. An installed package must
// not borrow an enclosing application's manifest, even inside another checkout.
export function findWebCheckoutRoot(webRoot = webPackagePaths.root) {
  let directory = path.dirname(webRoot);
  for (;;) {
    if (path.join(directory, 'packages', 'web') === webRoot) {
      try {
        const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
        if (manifest.name === 'openchamber-monorepo') return directory;
      } catch (error) {
        if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
      }
    }
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}
