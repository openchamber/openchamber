#!/usr/bin/env node
// Windows code signing through SignPath. SignPath signs only files a GitHub
// Actions step submits, so a signed Windows build is made in two passes with a
// signing request after each (.github/workflows/release-desktop-smoke.yml):
//
//   build-app        the unpacked app, plus copies of OpenChamber.exe and the
//                    NSIS uninstaller for the first signing request
//   build-installer  the installer from that same unpacked app, with the signed
//                    OpenChamber.exe and the signed uninstaller put in place
//   finalize         after the second request signed the installer: its
//                    blockmap and latest.yml describe the signed file again
//
// Only those three executables are ours. Electron's DLLs, the bundled OpenCode
// CLI, ripgrep and native modules come from upstream projects and stay as they
// are (SignPath Foundation terms).
//
// electron-builder also imports this module as its win.signtoolOptions.sign
// hook (`sign` below), which is how the uninstaller is reached mid-build.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeTargetArchitecture } from './target-architecture.mjs';
import { readPeArchitecture } from './windows-executable.mjs';
import { verifyUpdateManifest } from './verify-update-manifest.mjs';

const ELECTRON_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SELF = path.join(ELECTRON_DIR, 'scripts', 'windows-signpath.mjs');
const STAGE_ENV = 'OPENCHAMBER_SIGNPATH_STAGE';
const DIR_ENV = 'OPENCHAMBER_SIGNPATH_DIR';
// electron-builder writes the uninstaller next to the installer under this suffix.
const BUILDER_UNINSTALLER_SUFFIX = '__uninstaller.exe';

const APP_EXE = 'OpenChamber.exe';
const UNINSTALLER_EXE = 'uninstaller.exe';

const unpackedDirName = (arch) => (arch === 'x64' ? 'win-unpacked' : `win-${arch}-unpacked`);

/** Whether a PE file carries an Authenticode signature (a non-empty certificate table). */
const hasAuthenticodeSignature = (filePath) => {
  const bytes = fs.readFileSync(filePath);
  const peOffset = bytes.readUInt32LE(0x3c);
  const optionalHeader = peOffset + 24;
  const magic = bytes.readUInt16LE(optionalHeader);
  // Data directory 4 is the certificate table; its offset differs for PE32 and PE32+.
  const dataDirectories = optionalHeader + (magic === 0x20b ? 112 : 96);
  return bytes.readUInt32LE(dataDirectories + 4 * 8 + 4) > 0;
};

/** latest.yml with the sha512 and size of `fileName` replaced, as electron-builder writes it for NSIS. */
export const rewriteUpdateManifest = (content, fileName, { sha512, size }) => {
  let inEntry = false;
  let replaced = 0;
  const lines = content.split('\n').map((line) => {
    const url = line.match(/^\s{2}-\s+url:\s*(\S+)\s*$/)?.[1];
    if (url !== undefined) inEntry = decodeURIComponent(url) === fileName;
    else if (!line.startsWith('    ')) inEntry = false;
    if (/^\s+blockMapSize:/.test(line) && inEntry) {
      throw new Error(`latest.yml lists a blockMapSize for ${fileName}; only NSIS installers without one are supported`);
    }
    if (inEntry && /^\s{4}sha512:/.test(line)) { replaced += 1; return `    sha512: ${sha512}`; }
    if (inEntry && /^\s{4}size:/.test(line)) { replaced += 1; return `    size: ${size}`; }
    if (/^sha512:/.test(line)) return `sha512: ${sha512}`;
    return line;
  });
  if (replaced !== 2) throw new Error(`latest.yml has no complete entry for ${fileName}`);
  return lines.join('\n');
};

/** electron-builder win.signtoolOptions.sign hook; signs nothing itself. */
export const sign = async (configuration) => {
  const stage = process.env[STAGE_ENV];
  const dir = process.env[DIR_ENV];
  if (!stage || !dir) throw new Error(`${STAGE_ENV} and ${DIR_ENV} are required for the SignPath sign hook`);
  const file = configuration.path;
  if (!file.endsWith(BUILDER_UNINSTALLER_SUFFIX)) {
    // The app executable is taken from the unpacked app after the build, the
    // installer goes to the second signing request, and the rest is upstream.
    console.log(`[electron] SignPath: not signing ${path.basename(file)} during the build`);
    return;
  }
  const staged = path.join(dir, UNINSTALLER_EXE);
  if (stage === 'collect') {
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(file, staged);
    console.log(`[electron] SignPath: staged the uninstaller for signing (${fs.statSync(file).size} bytes)`);
  } else if (stage === 'assemble') {
    const built = fs.statSync(file).size;
    fs.copyFileSync(staged, file);
    console.log(`[electron] SignPath: replaced the uninstaller (${built} bytes) with the signed one (${fs.statSync(file).size} bytes)`);
  } else {
    throw new Error(`Unknown ${STAGE_ENV}: ${stage}`);
  }
};

const runPackage = (arch, stage, dir, extraArgs) => {
  const result = spawnSync(process.execPath, [
    path.join(ELECTRON_DIR, 'scripts', 'package.mjs'),
    '--win', `--${arch}`, '--publish=never',
    `--config.win.signtoolOptions.sign=${SELF}`,
    ...extraArgs,
  ], {
    cwd: ELECTRON_DIR,
    env: { ...process.env, [STAGE_ENV]: stage, [DIR_ENV]: dir },
    stdio: 'inherit',
  });
  if (result.status !== 0) throw new Error(`package.mjs failed (${result.status ?? result.signal})`);
};

const requireSigned = (filePath) => {
  if (!fs.existsSync(filePath)) throw new Error(`Missing signed file: ${filePath}`);
  if (!hasAuthenticodeSignature(filePath)) throw new Error(`Not signed: ${filePath}`);
};

/** Pass 1: build the app unsigned and stage our executables in `outDir` for signing. */
const buildApp = (arch, outDir) => {
  fs.rmSync(outDir, { recursive: true, force: true });
  runPackage(arch, 'collect', outDir, []);
  fs.copyFileSync(path.join(ELECTRON_DIR, 'dist', unpackedDirName(arch), APP_EXE), path.join(outDir, APP_EXE));
  const actual = readPeArchitecture(path.join(outDir, APP_EXE));
  if (actual !== arch) throw new Error(`${APP_EXE} is ${actual}, expected ${arch}`);
  if (!fs.existsSync(path.join(outDir, UNINSTALLER_EXE))) throw new Error('electron-builder produced no uninstaller');
};

/** Pass 2: build the installer from the unpacked app in `unpackedDir` and the signed files in `signedDir`. */
const buildInstaller = (arch, unpackedDir, signedDir) => {
  requireSigned(path.join(signedDir, APP_EXE));
  requireSigned(path.join(signedDir, UNINSTALLER_EXE));
  const actual = readPeArchitecture(path.join(signedDir, APP_EXE));
  if (actual !== arch) throw new Error(`Signed ${APP_EXE} is ${actual}, expected ${arch}`);
  fs.copyFileSync(path.join(signedDir, APP_EXE), path.join(unpackedDir, APP_EXE));
  runPackage(arch, 'assemble', signedDir, ['--prepackaged', unpackedDir]);
};

/** After the installer in `dir` is signed: regenerate its blockmap and point latest.yml at the signed bytes. */
const finalizeInstaller = async (dir, version) => {
  const installers = fs.readdirSync(dir).filter((name) => name.endsWith('.exe'));
  if (installers.length !== 1) throw new Error(`Expected one installer in ${dir}, found ${installers.join(', ') || 'none'}`);
  const installer = path.join(dir, installers[0]);
  requireSigned(installer);

  const builderRequire = createRequire(createRequire(import.meta.url).resolve('electron-builder/package.json'));
  const { executeAppBuilder } = builderRequire('builder-util');
  await executeAppBuilder(['blockmap', '--input', installer, '--output', `${installer}.blockmap`]);

  const bytes = fs.readFileSync(installer);
  const manifestPath = path.join(dir, 'latest.yml');
  fs.writeFileSync(manifestPath, rewriteUpdateManifest(fs.readFileSync(manifestPath, 'utf8'), installers[0], {
    sha512: crypto.createHash('sha512').update(bytes).digest('base64'),
    size: bytes.length,
  }));
  verifyUpdateManifest({ manifestPath, artifactPaths: [installer], expectedVersion: version });
  console.log(`[electron] SignPath: ${installers[0]} is signed; blockmap and latest.yml updated`);
};

const main = async () => {
  const [command, ...args] = process.argv.slice(2);
  const arch = () => normalizeTargetArchitecture(args[0]).node;
  if (command === 'build-app' && args.length === 2) {
    buildApp(arch(), path.resolve(args[1]));
  } else if (command === 'build-installer' && args.length === 3) {
    buildInstaller(arch(), path.resolve(args[1]), path.resolve(args[2]));
  } else if (command === 'finalize' && args.length === 2) {
    await finalizeInstaller(path.resolve(args[0]), args[1]);
  } else {
    throw new Error([
      'Usage:',
      '  windows-signpath.mjs build-app <arch> <out-dir>',
      '  windows-signpath.mjs build-installer <arch> <unpacked-dir> <signed-dir>',
      '  windows-signpath.mjs finalize <dir> <version>',
    ].join('\n'));
  }
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
