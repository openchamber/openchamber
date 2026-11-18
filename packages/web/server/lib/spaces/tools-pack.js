
import path from 'node:path';
import { findWebCheckoutRoot } from '../web-package-paths.js';

import { SpaceError } from './errors.js';

const STEP_TIMEOUT_MS = 5 * 60_000;

export async function packLocalTools({ runCommand, bunPath = 'bun', checkoutRoot = findWebCheckoutRoot(), outputDirectory }) {
  if (!checkoutRoot) {
    throw new SpaceError('tools_pack_failed', 'Packing local tools requires an OpenChamber checkout.');
  }
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

  await step('build the sdk package', 'sdk', ['run', 'build']);
  const sdkTarballPath = await pack('sdk');
  const webTarballPath = await pack('web');
  return { webTarballPath, sdkTarballPath };
}
