// external: https://github.com/anomalyco/opencode/blob/v2.3.2/packages/cli/vite.node.config.ts
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  bundleOpenCodeServer,
  copy,
  fetchPackage,
  packageDir,
  readManifest,
} from '../../web/scripts/prepare-opencode-server.mjs';
import { resolveTargetArchitecture } from './target-architecture.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const electronRoot = path.resolve(__dirname, '..');
const outputDir = path.join(electronRoot, 'resources', 'opencode-server');
const cacheRoot = path.join(electronRoot, '.cache', 'opencode-server');

const optionalVersion = (parentDir, name) => {
  const version = readManifest(parentDir).optionalDependencies?.[name];
  if (!version) throw new Error(`${readManifest(parentDir).name} has no optional dependency ${name}`);
  return version;
};

// external: https://github.com/anomalyco/opencode/blob/v2.3.2/packages/cli/src/node/target.ts
const nativeTargets = (coreDir, platform, arch) => {
  const linux = platform === 'linux';
  const win = platform === 'win32';
  const nodePtyDir = packageDir('@lydell/node-pty', coreDir);
  const watcherDir = packageDir('@parcel/watcher', coreDir);
  const fffNodeDir = packageDir('@ff-labs/fff-node', coreDir);
  const ffiDir = packageDir('ffi-rs', fffNodeDir);
  const ptyDir = packageDir('@opencode/pty', coreDir);
  const pick = (parentDir, name) => ({ name, version: optionalVersion(parentDir, name) });
  return {
    nodePty: { ...pick(nodePtyDir, `@lydell/node-pty-${platform}-${arch}`), whole: true, entry: 'lib/index.js' },
    parcelWatcher: { ...pick(watcherDir, `@parcel/watcher-${platform}-${arch}${linux ? '-glibc' : ''}`), files: ['watcher.node'] },
    fff: {
      ...pick(fffNodeDir, `@ff-labs/fff-bin-${platform}-${arch}${linux ? '-gnu' : ''}`),
      files: [platform === 'darwin' ? 'libfff_c.dylib' : win ? 'fff_c.dll' : 'libfff_c.so'],
    },
    fffFfi: {
      ...pick(ffiDir, `@yuuang/ffi-rs-${platform}-${arch}${linux ? '-gnu' : win ? '-msvc' : ''}`),
      files: [`ffi-rs.${platform}-${arch}${linux ? '-gnu' : win ? '-msvc' : ''}.node`],
    },
    persistentPty: {
      ...pick(ptyDir, `@opencode/pty-${platform}-${arch}${linux ? '-gnu' : ''}`),
      files: [win ? 'bin/opencode-pty.exe' : 'bin/opencode-pty'],
      executable: true,
    },
  };
};

const main = async () => {
  const platform = process.env.OPENCHAMBER_OPENCODE_SERVER_PLATFORM || process.platform;
  const { node: arch } = resolveTargetArchitecture();

  const { coreDir, serverVersion, assetsDir, photonWasm } = await bundleOpenCodeServer({
    packageRoot: electronRoot,
    outputDir,
    cacheRoot,
  });

  const manifest = {};
  for (const [key, target] of Object.entries(nativeTargets(coreDir, platform, arch))) {
    const source = await fetchPackage(target, cacheRoot);
    const destination = path.join(assetsDir, ...target.name.split('/'));
    if (target.whole) {
      copy(source, destination);
      manifest[key] = path.posix.join(target.name, target.entry);
    } else {
      for (const file of target.files) copy(path.join(source, file), path.join(destination, file), target.executable);
      manifest[key] = path.posix.join(target.name, target.files[0]);
    }
  }
  const spawnHelper = path.join(assetsDir, '@lydell', `node-pty-${platform}-${arch}`, 'prebuilds', `${platform}-${arch}`, 'spawn-helper');
  if (fs.existsSync(spawnHelper)) fs.chmodSync(spawnHelper, 0o755);

  manifest.photonWasm = photonWasm;
  fs.writeFileSync(path.join(assetsDir, 'manifest.json'), `${JSON.stringify({ version: serverVersion, platform, arch, ...manifest }, null, 2)}\n`);
  console.log(`[electron] prepared OpenCode server ${serverVersion} for ${platform}-${arch}: ${path.relative(electronRoot, outputDir)}`);
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
