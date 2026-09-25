import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const electronPackagePath = path.resolve(__dirname, '..', 'package.json');

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * The bundled OpenCode CLI release the desktop app ships. It used to be read
 * from the root `@opencode-ai/sdk` dependency, which OpenCode 2.x no longer
 * publishes, so the desktop package pins the CLI release itself.
 */
export const readPinnedOpenCodeCliVersion = () => {
  const pkg = JSON.parse(fs.readFileSync(electronPackagePath, 'utf8'));
  const version = String(pkg.opencodeCli?.version ?? '').trim();
  if (!EXACT_VERSION.test(version)) {
    throw new Error(`packages/electron/package.json must pin opencodeCli.version to an exact version, got: ${version || '(missing)'}`);
  }
  return version;
};

/** OpenCode 2.x answers `--version` with `opencode v2.0.2`; 1.x printed a bare version. */
export const parseOpenCodeCliVersion = (output) => {
  const match = /(\d+)\.(\d+)\.(\d+(?:[-+][0-9A-Za-z.-]+)?)/.exec(String(output || ''));
  return match ? `${match[1]}.${match[2]}.${match[3]}` : '';
};
