import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  REQUIRED_NATIVE_MODULES,
  assertElfArchitecture,
  collectFiles,
  defaultCliVersion,
} from './verify-linux-appimage.mjs';
import { normalizeTargetArchitecture } from './target-architecture.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const electronRoot = path.resolve(__dirname, '..');
const workspaceRoot = path.resolve(electronRoot, '../..');
const AR_MAGIC = '!<arch>\n';
const AR_HEADER_SIZE = 60;
// deb target installs the app payload under /opt/<sanitizedProductName>.
const INSTALL_PREFIX = 'opt';
const APP_DIR_NAME = 'OpenChamber';
const EXECUTABLE_NAME = 'openchamber';

/** electron-builder deb arch token: x64 → amd64, arm64 → arm64 */
export const linuxDebArchSuffix = (architecture) => (
  architecture === 'x64' ? 'amd64' : 'arm64'
);

const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, 'utf8'));

/**
 * Reads a Debian package (`ar` archive) member directory.
 * Returns [{ name, offset, size }] with the data offset pointing at the first
 * byte of the member payload.
 */
export const readDebMembers = (debPath) => {
  const buffer = fs.readFileSync(debPath);
  if (!buffer.subarray(0, 8).toString('latin1').startsWith(AR_MAGIC)) {
    throw new Error(`Not an ar (Debian package) archive: ${debPath}`);
  }
  const members = [];
  let offset = AR_MAGIC.length;
  while (offset < buffer.length) {
    if (offset + AR_HEADER_SIZE > buffer.length) {
      throw new Error(`Truncated ar member header in ${debPath} at offset ${offset}`);
    }
    const header = buffer.subarray(offset, offset + AR_HEADER_SIZE);
    const rawName = header.subarray(0, 16).toString('latin1').replace(/[\x00/ ]+$/, '');
    const size = parseInt(header.subarray(48, 58).toString('latin1').trim(), 10);
    if (header.subarray(58, 60).toString('latin1') !== '`\n') {
      throw new Error(`Invalid ar member magic in ${debPath}`);
    }
    if (Number.isNaN(size)) {
      throw new Error(`Invalid ar member size in ${debPath}`);
    }
    const dataOffset = offset + AR_HEADER_SIZE;
    members.push({ name: rawName.trim(), offset: dataOffset, size });
    // ar members are padded to an even boundary
    offset = dataOffset + size + (size % 2);
  }
  return members;
};

const extractArMember = (debPath, member, destination) => {
  const descriptor = fs.openSync(debPath, 'r');
  try {
    const buffer = Buffer.alloc(member.size);
    if (fs.readSync(descriptor, buffer, 0, member.size, member.offset) !== member.size) {
      throw new Error(`Failed to read ar member ${member.name} from ${debPath}`);
    }
    fs.writeFileSync(destination, buffer);
  } finally {
    fs.closeSync(descriptor);
  }
  return destination;
};

const tarExtract = (archivePath, destination) => {
  fs.mkdirSync(destination, { recursive: true });
  // `-J` selects xz, which is the electron-builder deb default compression.
  const result = spawnSync('tar', ['-xJf', archivePath, '-C', destination], {
    encoding: 'utf8',
    stdio: ['ignore', 'ignore', 'pipe'],
    timeout: 180000,
  });
  if (result.status !== 0) {
    throw new Error(`Failed to extract deb data archive ${archivePath}\n${(result.stderr || '').trim()}`);
  }
};

export const verifyDebPayload = ({
  root,
  targetArchitecture,
  expectedOpenCodeVersion,
  runCliVersion = defaultCliVersion,
}) => {
  const appDir = path.join(root, INSTALL_PREFIX, APP_DIR_NAME);
  if (!fs.existsSync(appDir)) throw new Error(`Missing installed app payload: ${appDir}`);

  const desktopPath = path.join(root, 'usr', 'share', 'applications', `${EXECUTABLE_NAME}.desktop`);
  if (!fs.existsSync(desktopPath)) throw new Error(`Missing desktop entry: ${desktopPath}`);
  const desktop = fs.readFileSync(desktopPath, 'utf8');
  for (const entry of ['Name=OpenChamber', 'Icon=openchamber', 'StartupWMClass=openchamber']) {
    if (!desktop.split(/\r?\n/).includes(entry)) throw new Error(`Desktop identity mismatch: missing ${entry}`);
  }
  if (!desktop.split(/\r?\n/).some((line) => line.startsWith(`Exec=/${INSTALL_PREFIX}/${APP_DIR_NAME}/${EXECUTABLE_NAME}`))) {
    throw new Error(`Desktop identity mismatch: expected Exec to launch /${INSTALL_PREFIX}/${APP_DIR_NAME}/${EXECUTABLE_NAME}`);
  }

  // The desktop entry points at `Icon=openchamber`, so the deb must install the
  // icon under a hicolor size that gtk-update-icon-cache actually indexes
  // (the declared hicolor sizes stop at 512x512). A 1024x1024-only icon never
  // lands in the cache and desktop launchers fall back to a generic icon.
  const launcherIconPath = path.join(root, 'usr', 'share', 'icons', 'hicolor', '512x512', 'apps', `${EXECUTABLE_NAME}.png`);
  if (!fs.existsSync(launcherIconPath)) {
    throw new Error(`Missing launcher icon at an indexed hicolor size: ${launcherIconPath}`);
  }
  const launcherIconHead = fs.readFileSync(launcherIconPath).subarray(0, 8);
  if (!launcherIconHead.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    throw new Error(`Launcher icon is not a portable-network-graphic (PNG): ${launcherIconPath}`);
  }

  assertElfArchitecture(path.join(appDir, EXECUTABLE_NAME), targetArchitecture, 'Electron executable');
  const cliPath = path.join(appDir, 'resources', 'opencode-cli', 'opencode');
  assertElfArchitecture(cliPath, targetArchitecture, 'OpenCode CLI');
  const actualVersion = runCliVersion(cliPath);
  if (actualVersion !== expectedOpenCodeVersion) {
    throw new Error(`OpenCode CLI version mismatch: expected ${expectedOpenCodeVersion}, got ${actualVersion || '(empty)'}`);
  }

  const unpackedModules = path.join(appDir, 'resources', 'app.asar.unpacked', 'node_modules');
  if (!fs.existsSync(unpackedModules)) throw new Error(`Missing unpacked native modules: ${unpackedModules}`);
  const nativeModules = collectFiles(unpackedModules, (name, fullPath) => {
    if (!name.endsWith('.node')) return false;
    const normalizedPath = fullPath.split(path.sep).join('/');
    if (!normalizedPath.includes('/prebuilds/')) return true;
    return normalizedPath.includes(`/prebuilds/linux-${targetArchitecture}/`);
  });
  for (const requiredName of REQUIRED_NATIVE_MODULES) {
    if (!nativeModules.some((modulePath) => path.basename(modulePath) === requiredName)) {
      throw new Error(`Missing packaged native module: ${requiredName}`);
    }
  }
  for (const modulePath of nativeModules) assertElfArchitecture(modulePath, targetArchitecture, 'Native module');

  return { nativeModuleCount: nativeModules.length, openCodeVersion: actualVersion };
};

const findDeb = (version, architecture) => {
  const archSuffix = linuxDebArchSuffix(architecture);
  const expected = path.join(electronRoot, 'dist', `openchamber_${version}_${archSuffix}.deb`);
  if (!fs.existsSync(expected)) throw new Error(`Linux deb package not found: ${expected}`);
  return expected;
};

const main = () => {
  const rootPackage = readJson(path.join(workspaceRoot, 'package.json'));
  const target = normalizeTargetArchitecture(process.env.OPENCHAMBER_TARGET_ARCH || process.arch).node;
  const debPath = process.argv[2] ? path.resolve(process.argv[2]) : findDeb(rootPackage.version, target);

  const members = readDebMembers(debPath);
  const dataMember = members.find((member) => member.name.startsWith('data.tar.'));
  if (!dataMember) {
    throw new Error(`Deb package ${debPath} has no data archive member (members: ${members.map((m) => m.name).join(', ')})`);
  }

  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-deb-'));
  const dataArchive = path.join(temporaryDirectory, 'data.tar');
  try {
    extractArMember(debPath, dataMember, dataArchive);
    const payloadRoot = path.join(temporaryDirectory, 'payload');
    tarExtract(dataArchive, payloadRoot);
    const result = verifyDebPayload({
      root: payloadRoot,
      targetArchitecture: target,
      expectedOpenCodeVersion: rootPackage.dependencies?.['@opencode-ai/sdk'],
    });
    console.log(`[electron] verified Linux ${target} deb package: ${debPath}`);
    console.log(`[electron] verified OpenCode CLI ${result.openCodeVersion} and ${result.nativeModuleCount} native modules`);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
