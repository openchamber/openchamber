import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveTargetArchitecture } from './target-architecture.mjs';
import { parseOpenCodeCliVersion, readPinnedOpenCodeCliVersion } from './opencode-cli-version.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const electronRoot = path.resolve(__dirname, '..');
const outputDir = path.join(electronRoot, 'resources', 'opencode-cli');
const cacheRoot = path.join(electronRoot, '.cache', 'opencode-cli');

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: options.stdio || 'pipe',
    windowsHide: true,
    ...options,
  });
  if (result.status !== 0) {
    const stderr = result.stderr ? `\n${result.stderr.trim()}` : '';
    const stdout = result.stdout ? `\n${result.stdout.trim()}` : '';
    throw new Error(`Command failed: ${command} ${args.join(' ')}${stderr}${stdout}`);
  }
  return result;
};

/**
 * OpenCode 2.x ships on npm, not as GitHub release assets: `@opencode/cli`
 * resolves a platform package (`@opencode/cli-<os>-<arch>`) whose tarball
 * holds the compiled binary under `package/bin/`. OpenCode's own installer
 * (`https://opencode.ai/v2/install`) downloads exactly these tarballs, so the
 * bundled desktop binary comes from the same place.
 */
const artifactForPlatform = (platform, targetArchitecture) => {
  const arch = targetArchitecture.opencode;
  if (platform === 'darwin') {
    if (arch === 'arm64') return { target: 'darwin-arm64', binary: 'opencode' };
    if (arch === 'x64') return { target: 'darwin-x64-baseline', binary: 'opencode' };
  }
  if (platform === 'win32') {
    if (arch === 'arm64') return { target: 'windows-arm64', binary: 'opencode.exe' };
    if (arch === 'x64') return { target: 'windows-x64-baseline', binary: 'opencode.exe' };
  }
  if (platform === 'linux') {
    if (arch === 'arm64') return { target: 'linux-arm64', binary: 'opencode' };
    if (arch === 'x64') return { target: 'linux-x64-baseline', binary: 'opencode' };
  }
  throw new Error(`No OpenCode CLI artifact mapping for ${platform}/${arch}`);
};

const artifactUrl = (target, version) =>
  `https://registry.npmjs.org/@opencode/cli-${target}/-/cli-${target}-${version}.tgz`;

const outputBinaryPath = (binaryName) => path.join(outputDir, binaryName);

const readBinaryVersion = (binaryPath) => {
  if (!fs.existsSync(binaryPath)) return null;
  const result = spawnSync(binaryPath, ['--version'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15000,
    windowsHide: true,
  });
  if (result.status !== 0) return null;
  return parseOpenCodeCliVersion(result.stdout) || null;
};

const ensureExecutable = (filePath) => {
  if (process.platform !== 'win32') {
    fs.chmodSync(filePath, 0o755);
  }
};

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
  // npm tarballs are gzipped tar on every platform; Windows 10+ ships bsdtar.
  // The archive is addressed relative to the destination: under Git Bash on
  // Windows, `tar` is GNU tar, which reads an absolute `D:\...` path as a
  // remote host ("Cannot connect to D:").
  run('tar', ['-xzf', path.relative(destination, archivePath)], { cwd: destination });
};

const findBinary = (root, binaryName) => {
  const entries = fs.readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === binaryName.toLowerCase()) {
      return fullPath;
    }
    if (entry.isDirectory()) {
      const found = findBinary(fullPath, binaryName);
      if (found) return found;
    }
  }
  return null;
};

const main = async () => {
  const version = process.env.OPENCHAMBER_OPENCODE_CLI_VERSION || readPinnedOpenCodeCliVersion();
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Invalid OpenCode CLI version: ${version}`);
  }

  const targetArchitecture = resolveTargetArchitecture();
  const artifact = artifactForPlatform(process.platform, targetArchitecture);
  const outputBinary = outputBinaryPath(artifact.binary);
  const existingVersion = readBinaryVersion(outputBinary);
  if (existingVersion === version) {
    console.log(`[electron] bundled OpenCode CLI already prepared: ${outputBinary} (${version})`);
    return;
  }

  const cacheDir = path.join(cacheRoot, version, `${process.platform}-${targetArchitecture.opencode}`);
  const archiveName = `cli-${artifact.target}-${version}.tgz`;
  const archivePath = path.join(cacheDir, archiveName);
  const url = artifactUrl(artifact.target, version);
  if (!fs.existsSync(archivePath)) {
    console.log(`[electron] downloading OpenCode CLI ${version}: @opencode/cli-${artifact.target}`);
    await download(url, archivePath);
  } else {
    console.log(`[electron] using cached OpenCode CLI archive: ${archivePath}`);
  }

  const extractDir = path.join(cacheDir, 'extract');
  extractArchive(archivePath, extractDir);
  const extractedBinary = findBinary(extractDir, artifact.binary);
  if (!extractedBinary) {
    throw new Error(`Archive ${archivePath} did not contain ${artifact.binary}`);
  }

  fs.mkdirSync(outputDir, { recursive: true });
  for (const entry of fs.readdirSync(outputDir)) {
    if (entry === '.gitkeep') continue;
    fs.rmSync(path.join(outputDir, entry), { recursive: true, force: true });
  }
  fs.copyFileSync(extractedBinary, outputBinary);
  ensureExecutable(outputBinary);

  const preparedVersion = readBinaryVersion(outputBinary);
  if (preparedVersion !== version) {
    throw new Error(`Prepared OpenCode CLI version mismatch: expected ${version}, got ${preparedVersion || 'unknown'}`);
  }

  console.log(`[electron] prepared OpenCode CLI ${version}: ${outputBinary}`);
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
