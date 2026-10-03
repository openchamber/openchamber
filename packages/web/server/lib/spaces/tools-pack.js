// Packs the local `web` and `sdk` packages of a checkout into tarballs, for the tools
// volume of a development build. Nothing from the host's node_modules travels: native
// packages are per platform, so the filler installs every dependency itself, for Linux.
//
// Measured with bun 1.4.2:
// - `bun pm pack` runs the package's `prepack` script. For `web` that builds the built-in extensions.
// - It rewrites `workspace:*` to the version of the local package.
// - With `--destination` it writes `<name>-<version>.tgz` there. `--filename` cannot be combined with it.
// - With `--quiet` the last line of stdout is the path of the tarball. Script output comes before it.
// `vite build` is not needed: a space runs the server with `--api-only`.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SpaceError } from './errors.js';

const STEP_TIMEOUT_MS = 5 * 60_000;

const CHECKOUT_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));

/**
 * Resolves `{ webTarballPath, sdkTarballPath }` inside `outputDirectory`, for createPackedToolsSource.
 * Needs the workspace dependencies installed, because the sdk is compiled first.
 */
export async function packLocalTools({ runCommand, bunPath = 'bun', checkoutRoot = CHECKOUT_ROOT, outputDirectory }) {
  const step = async (what, packageName, args) => {
    const cwd = path.join(checkoutRoot, 'packages', packageName);
    const result = await runCommand(bunPath, args, { cwd, timeoutMs: STEP_TIMEOUT_MS });
    if (result.code !== 0) {
      throw new SpaceError('tools_pack_failed', `Could not ${what} in ${cwd}: ${result.stderr.trim() || `exit code ${result.code}`}. Run "bun install" in the checkout, then try again.`);
    }
    return result.stdout;
  };

  const pack = async (packageName) => {
    const stdout = await step(`pack the ${packageName} package`, packageName, ['pm', 'pack', '--destination', outputDirectory, '--quiet']);
    const tarball = stdout.split('\n').map((line) => line.trim()).filter(Boolean).pop() ?? '';
    if (!tarball.endsWith('.tgz')) {
      throw new SpaceError('tools_pack_failed', `bun did not say where it wrote the ${packageName} tarball`);
    }
    return path.resolve(outputDirectory, tarball);
  };

  // The sdk ships its compiled `dist`, and nothing in its pack step builds it.
  await step('build the sdk package', 'sdk', ['run', 'build']);
  const sdkTarballPath = await pack('sdk');
  const webTarballPath = await pack('web');
  return { webTarballPath, sdkTarballPath };
}
