import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveTargetArchitecture } from './target-architecture.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const electronRoot = path.resolve(__dirname, '..');
const outputDir = path.join(electronRoot, 'resources', 'ripgrep');
const cacheRoot = path.join(electronRoot, '.cache', 'ripgrep');
const lockfilePath = path.resolve(electronRoot, '..', '..', 'bun.lock');
const require = createRequire(import.meta.url);

/**
 * Find in files runs ripgrep. `@vscode/ripgrep` publishes the binary in a
 * platform package (`@vscode/ripgrep-<os>-<arch>`) that npm and Bun install
 * for the build host, which is the wrong one for a cross-built desktop app.
 * This downloads the target architecture's package from npm, the way
 * `prepare-opencode-cli.mjs` does for OpenCode, and stages its `rg` under
 * `resources/ripgrep`, which `extraResources` ships as `Resources/ripgrep`.
 * The server looks there first (`packages/web/server/lib/fs/ripgrep.js`).
 */
const readPackagedVersion = () => {
  // The package exports only its entry, so its manifest is found from there.
  const webRequire = createRequire(require.resolve('@openchamber/web/package.json'));
  const entry = webRequire.resolve('@vscode/ripgrep');
  const manifest = JSON.parse(fs.readFileSync(path.join(path.dirname(entry), '..', 'package.json'), 'utf8'));
  return manifest.version;
};

const artifactUrl = (packageName, version) => (
  `https://registry.npmjs.org/@vscode/${packageName}/-/${packageName}-${version}.tgz`
);

const binaryName = process.platform === 'win32' ? 'rg.exe' : 'rg';

// The archive comes from the network, so it has to be the one `bun.lock`
// pinned: the lockfile records a sha512 for every platform package, including
// the ones the build host never installs.
const readLockedIntegrity = (packageName, version) => {
  const spec = `"@vscode/${packageName}@${version}"`;
  const entry = fs.readFileSync(lockfilePath, 'utf8').split('\n').find((line) => line.includes(spec));
  const integrity = entry ? /"sha512-([A-Za-z0-9+/=]+)"/.exec(entry)?.[1] : null;
  if (!integrity) {
    throw new Error(`bun.lock has no sha512 for @vscode/${packageName}@${version}`);
  }
  return integrity;
};

const archiveMatchesLock = (archivePath, integrity) => (
  createHash('sha512').update(fs.readFileSync(archivePath)).digest('base64') === integrity
);

const download = async (url, destination) => {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  }
  const temp = `${destination}.tmp`;
  fs.writeFileSync(temp, Buffer.from(await response.arrayBuffer()));
  fs.renameSync(temp, destination);
};

const extractArchive = (archivePath, destination) => {
  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(destination, { recursive: true });
  // The archive is addressed relative to the destination: under Git Bash on
  // Windows, GNU tar reads an absolute `D:\...` path as a remote host.
  const result = spawnSync('tar', ['-xzf', path.relative(destination, archivePath)], {
    cwd: destination,
    encoding: 'utf8',
    stdio: 'pipe',
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(`Failed to extract ${archivePath}${result.stderr ? `\n${result.stderr.trim()}` : ''}`);
  }
};

const readRipgrepVersion = (binaryPath) => {
  const result = spawnSync(binaryPath, ['--version'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15000,
    windowsHide: true,
  });
  if (result.status !== 0) return null;
  return /^ripgrep\s+(\S+)/.exec(result.stdout.trim())?.[1] ?? null;
};

const main = async () => {
  const version = readPackagedVersion();
  const targetArchitecture = resolveTargetArchitecture();
  const packageName = `ripgrep-${process.platform}-${targetArchitecture.node}`;

  const cacheDir = path.join(cacheRoot, version, `${process.platform}-${targetArchitecture.node}`);
  const archivePath = path.join(cacheDir, `${packageName}-${version}.tgz`);
  const integrity = readLockedIntegrity(packageName, version);
  if (fs.existsSync(archivePath) && archiveMatchesLock(archivePath, integrity)) {
    console.log(`[electron] using cached ripgrep archive: ${archivePath}`);
  } else {
    console.log(`[electron] downloading ripgrep: @vscode/${packageName}@${version}`);
    await download(artifactUrl(packageName, version), archivePath);
    if (!archiveMatchesLock(archivePath, integrity)) {
      fs.rmSync(archivePath, { force: true });
      throw new Error(`Downloaded @vscode/${packageName}@${version} does not match the sha512 in bun.lock`);
    }
  }

  const extractDir = path.join(cacheDir, 'extract');
  extractArchive(archivePath, extractDir);
  const extractedBinary = path.join(extractDir, 'package', 'bin', binaryName);
  if (!fs.existsSync(extractedBinary)) {
    throw new Error(`Archive ${archivePath} did not contain bin/${binaryName}`);
  }

  fs.mkdirSync(outputDir, { recursive: true });
  for (const entry of fs.readdirSync(outputDir)) {
    if (entry === '.gitkeep') continue;
    fs.rmSync(path.join(outputDir, entry), { recursive: true, force: true });
  }
  const outputBinary = path.join(outputDir, binaryName);
  fs.copyFileSync(extractedBinary, outputBinary);
  if (process.platform !== 'win32') {
    fs.chmodSync(outputBinary, 0o755);
  }

  // A Windows arm64 build runs on an x64 runner, which cannot start an arm64
  // executable; the lockfile check above already vouches for that archive.
  if (process.platform === 'win32' && targetArchitecture.node !== process.arch) {
    console.log(`[electron] prepared ripgrep (@vscode/${packageName}@${version}, not run on this ${process.arch} host): ${outputBinary}`);
    return;
  }
  const ripgrepVersion = readRipgrepVersion(outputBinary);
  if (!ripgrepVersion) {
    throw new Error(`Prepared ripgrep does not run: ${outputBinary}`);
  }
  console.log(`[electron] prepared ripgrep ${ripgrepVersion} (@vscode/${packageName}@${version}): ${outputBinary}`);
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
