/**
 * Generates `settings-registry.json` — the plain-data view of the registry the
 * OpenChamber server (plain ESM, no bundler) and the VS Code extension host
 * consume. Both are checked in; `registry.test.ts` fails when they are stale.
 *
 *   bun run settings-registry:generate
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildSettingsRegistrySnapshot } from './registry';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..', '..', '..');

/** Every checked-in copy of the snapshot, relative to the repo root. */
export const SETTINGS_REGISTRY_SNAPSHOT_PATHS = [
  'packages/web/server/lib/opencode/settings-registry.json',
  'packages/vscode/src/settings-registry.json',
] as const;

export const renderSettingsRegistrySnapshot = (): string => `${JSON.stringify(buildSettingsRegistrySnapshot(), null, 2)}\n`;

export const writeSettingsRegistrySnapshots = (): string[] => {
  const rendered = renderSettingsRegistrySnapshot();
  return SETTINGS_REGISTRY_SNAPSHOT_PATHS.map((relativePath) => {
    const target = resolve(repoRoot, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, rendered, 'utf8');
    return target;
  });
};

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  for (const target of writeSettingsRegistrySnapshots()) {
    console.log(`wrote ${target}`);
  }
}
