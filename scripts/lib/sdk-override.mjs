// The web package depends on @openchamber/sdk at the app's version. Between
// releases npm already has that version, built from an older commit, so an
// install of a locally packed web package must take the SDK from the tarball
// packed with it. A package.json `overrides` entry in the install directory does
// that, for a project directory and for bun's global manifest alike.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const SDK = '@openchamber/sdk';

const readManifest = (manifestPath) => (existsSync(manifestPath)
  ? JSON.parse(readFileSync(manifestPath, 'utf8').trim() || '{}')
  : {});

const writeManifest = (manifestPath, manifest) => {
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
};

/**
 * Points the SDK at `sdkPath` in `<directory>/package.json`, keeping every other
 * field. Returns a function that puts the previous SDK override back and leaves
 * the rest of the manifest, including dependencies added since, as it finds it.
 */
export function pointSdkAtArchive(directory, sdkPath) {
  const manifestPath = path.join(directory, 'package.json');
  const manifest = readManifest(manifestPath);
  const previous = manifest.overrides?.[SDK];
  // bun reads `file:` specifiers as URLs, so a Windows path needs forward slashes.
  manifest.overrides = { ...manifest.overrides, [SDK]: `file:${sdkPath.replaceAll('\\', '/')}` };
  mkdirSync(directory, { recursive: true });
  writeManifest(manifestPath, manifest);

  return () => {
    const current = readManifest(manifestPath);
    const overrides = { ...current.overrides };
    if (previous === undefined) delete overrides[SDK];
    else overrides[SDK] = previous;
    if (Object.keys(overrides).length > 0) current.overrides = overrides;
    else delete current.overrides;
    writeManifest(manifestPath, current);
  };
}
