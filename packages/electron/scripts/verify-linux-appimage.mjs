import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeTargetArchitecture } from './target-architecture.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const electronRoot = path.resolve(__dirname, '..');
const workspaceRoot = path.resolve(electronRoot, '../..');
const ELF_MACHINE = { x64: 62, arm64: 183 };
const REQUIRED_NATIVE_MODULES = ['better_sqlite3.node', 'pty.node', 'sherpa-onnx.node'];

const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, 'utf8'));

export const readElfArchitecture = (filePath) => {
  const header = Buffer.alloc(20);
  const descriptor = fs.openSync(filePath, 'r');
  try {
    if (fs.readSync(descriptor, header, 0, header.length, 0) !== header.length) {
      throw new Error(`ELF header is truncated: ${filePath}`);
    }
  } finally {
    fs.closeSync(descriptor);
  }
  if (!header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
    throw new Error(`Expected an ELF binary: ${filePath}`);
  }
  const byteOrder = header[5];
  if (byteOrder !== 1 && byteOrder !== 2) throw new Error(`Unsupported ELF byte order: ${filePath}`);
  const machine = byteOrder === 1 ? header.readUInt16LE(18) : header.readUInt16BE(18);
  const architecture = Object.entries(ELF_MACHINE).find(([, value]) => value === machine)?.[0];
  if (!architecture) throw new Error(`Unsupported ELF machine ${machine}: ${filePath}`);
  return architecture;
};

export const assertElfArchitecture = (filePath, expectedArchitecture, label) => {
  if (!fs.existsSync(filePath)) throw new Error(`Missing ${label}: ${filePath}`);
  const actual = readElfArchitecture(filePath);
  if (actual !== expectedArchitecture) {
    throw new Error(`${label} architecture mismatch: expected ${expectedArchitecture}, got ${actual} (${filePath})`);
  }
};

const collectFiles = (root, predicate) => {
  const matches = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(fullPath);
      else if (entry.isFile() && predicate(entry.name, fullPath)) matches.push(fullPath);
    }
  };
  visit(root);
  return matches;
};

const defaultCliVersion = (binaryPath) => {
  const result = spawnSync(binaryPath, ['--version'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15000,
  });
  if (result.status !== 0) throw new Error(`Failed to run packaged OpenCode CLI: ${binaryPath}`);
  return (result.stdout || '').trim().split(/\s+/)[0] || '';
};

export const verifyExtractedPayload = ({
  root,
  targetArchitecture,
  expectedOpenCodeVersion,
  runCliVersion = defaultCliVersion,
}) => {
  const desktopPath = path.join(root, 'openchamber.desktop');
  if (!fs.existsSync(desktopPath)) throw new Error(`Missing desktop entry: ${desktopPath}`);
  const desktop = fs.readFileSync(desktopPath, 'utf8');
  for (const entry of ['Name=OpenChamber', 'Icon=openchamber', 'StartupWMClass=openchamber']) {
    if (!desktop.split(/\r?\n/).includes(entry)) throw new Error(`Desktop identity mismatch: missing ${entry}`);
  }
  if (!/^Exec=AppRun(?:\s|$)/m.test(desktop)) throw new Error('Desktop identity mismatch: expected AppImage AppRun entrypoint');

  assertElfArchitecture(path.join(root, 'openchamber'), targetArchitecture, 'Electron executable');
  const cliPath = path.join(root, 'resources', 'opencode-cli', 'opencode');
  assertElfArchitecture(cliPath, targetArchitecture, 'OpenCode CLI');
  const actualVersion = runCliVersion(cliPath);
  if (actualVersion !== expectedOpenCodeVersion) {
    throw new Error(`OpenCode CLI version mismatch: expected ${expectedOpenCodeVersion}, got ${actualVersion || '(empty)'}`);
  }

  const unpackedModules = path.join(root, 'resources', 'app.asar.unpacked', 'node_modules');
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

const findAppImage = (version, architecture) => {
  const suffix = architecture === 'x64' ? 'x86_64' : 'arm64';
  const expected = path.join(electronRoot, 'dist', `OpenChamber-${version}-linux-${suffix}.AppImage`);
  if (!fs.existsSync(expected)) throw new Error(`Linux AppImage not found: ${expected}`);
  return expected;
};

const extractAppImage = (appImagePath, destination) => {
  fs.chmodSync(appImagePath, fs.statSync(appImagePath).mode | 0o100);
  const result = spawnSync(appImagePath, ['--appimage-extract'], {
    cwd: destination,
    encoding: 'utf8',
    stdio: ['ignore', 'ignore', 'pipe'],
    timeout: 120000,
  });
  if (result.status !== 0) {
    throw new Error(`Failed to extract AppImage: ${appImagePath}\n${(result.stderr || '').trim()}`);
  }
  return path.join(destination, 'squashfs-root');
};

const main = () => {
  const rootPackage = readJson(path.join(workspaceRoot, 'package.json'));
  const target = normalizeTargetArchitecture(process.env.OPENCHAMBER_TARGET_ARCH || process.arch).node;
  const appImagePath = process.argv[2] ? path.resolve(process.argv[2]) : findAppImage(rootPackage.version, target);
  assertElfArchitecture(appImagePath, target, 'AppImage');

  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-appimage-'));
  try {
    const result = verifyExtractedPayload({
      root: extractAppImage(appImagePath, temporaryDirectory),
      targetArchitecture: target,
      expectedOpenCodeVersion: rootPackage.dependencies?.['@opencode-ai/sdk'],
    });
    console.log(`[electron] verified Linux ${target} AppImage: ${appImagePath}`);
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
