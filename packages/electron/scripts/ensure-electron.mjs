#!/usr/bin/env node
// external: https://github.com/electron/electron/blob/main/npm/install.js Repair incomplete or wrong-architecture installs; older extract-zip under Node 24 can silently extract only one entry.
import { spawnSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { resolveBunExecutable } from '../../../scripts/lib/bun-executable.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoElectronDir = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);

const MACHO_CPU_TO_ARCH = {
  0x00000007: 'ia32',
  0x01000007: 'x64',
  0x0000000c: 'arm',
  0x0100000c: 'arm64',
};
const ELF_MACHINE_TO_ARCH = {
  3: 'ia32',
  40: 'arm',
  62: 'x64',
  183: 'arm64',
};
const PE_MACHINE_TO_ARCH = {
  0x014c: 'ia32',
  0x8664: 'x64',
  0xaa64: 'arm64',
};

export function platformPath() {
  const platform = process.env.npm_config_platform || process.platform;
  switch (platform) {
    case 'mas':
    case 'darwin':
      return 'Electron.app/Contents/MacOS/Electron';
    case 'freebsd':
    case 'openbsd':
    case 'linux':
      return 'electron';
    case 'win32':
      return 'electron.exe';
    default:
      throw new Error(`Electron builds are not available on platform: ${platform}`);
  }
}

export function expectedArch() {
  const platform = process.env.npm_config_platform || process.platform;
  let arch = process.env.npm_config_arch || process.arch;
  if (
    platform === 'darwin' &&
    process.platform === 'darwin' &&
    arch === 'x64' &&
    process.env.npm_config_arch === undefined
  ) {
    try {
      const out = execSync('sysctl -in sysctl.proc_translated', {
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      if (String(out).trim() === '1') {
        arch = 'arm64';
      }
    } catch {
      // Ignore failure: treat as a native x64 host.
    }
  }
  return arch;
}

export function detectExecutableArch(executablePath) {
  let fd;
  try {
    fd = fs.openSync(executablePath, 'r');
  } catch {
    return null;
  }
  try {
    const header = Buffer.alloc(512);
    const bytesRead = fs.readSync(fd, header, 0, header.length, 0);
    return archFromHeader(header.subarray(0, bytesRead));
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
  }
}

function archFromHeader(buf) {
  if (buf.length < 4) return null;

  if (buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46) {
    if (buf.length < 20) return null;
    return ELF_MACHINE_TO_ARCH[buf.readUInt16LE(18)] ?? null;
  }

  const magicLE = buf.readUInt32LE(0);
  if (magicLE === 0xfeedface || magicLE === 0xfeedfacf) {
    if (buf.length < 8) return null;
    return MACHO_CPU_TO_ARCH[buf.readUInt32LE(4)] ?? null;
  }

  const magicBE = buf.readUInt32BE(0);
  if (magicBE === 0xcafebabe || magicBE === 0xbebafeca) {
    if (buf.length < 8) return null;
    const count = buf.readUInt32BE(4);
    for (let i = 0; i < count; i += 1) {
      const offset = 8 + i * 20;
      if (buf.length < offset + 4) break;
      const arch = MACHO_CPU_TO_ARCH[buf.readUInt32BE(offset)];
      if (arch) return arch;
    }
    return null;
  }

  if (buf[0] === 0x4d && buf[1] === 0x5a) {
    if (buf.length < 0x40) return null;
    const peOffset = buf.readUInt32LE(0x3c);
    if (buf.length < peOffset + 6) return null;
    if (buf.toString('latin1', peOffset, peOffset + 4) !== 'PE\0\0') return null;
    return PE_MACHINE_TO_ARCH[buf.readUInt16LE(peOffset + 4)] ?? null;
  }

  return null;
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

export function resolveElectronPackageDir(baseDir = repoElectronDir) {
  try {
    const pkgJson = require.resolve('electron/package.json', { paths: [baseDir] });
    return path.dirname(pkgJson);
  } catch {
    const candidates = [
      path.resolve(baseDir, 'node_modules/electron'),
      path.resolve(baseDir, '../../node_modules/electron'),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(path.join(candidate, 'package.json'))) {
        return candidate;
      }
    }
    return null;
  }
}

export function isComplete(electronDir, expected = expectedArch()) {
  const pkg = readJson(path.join(electronDir, 'package.json'));
  if (!pkg || !pkg.version) return false;

  try {
    const distVersion = fs
      .readFileSync(path.join(electronDir, 'dist', 'version'), 'utf8')
      .trim()
      .replace(/^v/, '');
    if (distVersion !== pkg.version) return false;
  } catch {
    return false;
  }

  let executablePath;
  try {
    executablePath = fs.readFileSync(path.join(electronDir, 'path.txt'), 'utf8').trim();
  } catch {
    return false;
  }
  if (executablePath !== platformPath()) return false;

  const executable = path.join(electronDir, 'dist', executablePath);
  if (!fs.existsSync(executable)) return false;

  const detected = detectExecutableArch(executable);
  if (detected === null || detected !== expected) return false;

  return true;
}

function resolveInstallCommands(env, bunResolver = resolveBunExecutable) {
  const normalize = (commands) => commands.map(([bin, args]) => [
    bin === 'bun' ? bunResolver({ env }) : bin,
    args,
  ]);
  if (env.OPENCHAMBER_ELECTRON_INSTALL_COMMANDS) {
    try {
      const parsed = JSON.parse(env.OPENCHAMBER_ELECTRON_INSTALL_COMMANDS);
      if (
        Array.isArray(parsed) &&
        parsed.every((command) => Array.isArray(command) && typeof command[0] === 'string')
      ) {
        return normalize(parsed);
      }
    } catch {
      // Fall through to the default commands.
    }
  }
  return normalize([
    ['bun', ['install.js']],
    ['node', ['install.js']],
  ]);
}

export function repair(electronDir, options = {}) {
  const env = options.env ?? process.env;
  const runner = options.runner ?? spawnSync;
  const commands = options.commands ?? resolveInstallCommands(env, options.bunResolver);

  fs.rmSync(path.join(electronDir, 'dist'), { recursive: true, force: true });
  fs.rmSync(path.join(electronDir, 'path.txt'), { force: true });

  for (const [bin, args] of commands) {
    const label = `${bin} ${args.join(' ')}`;
    const result = runner(bin, args, {
      cwd: electronDir,
      stdio: options.stdio ?? 'inherit',
      env: { ...env, ELECTRON_SKIP_BINARY_DOWNLOAD: undefined },
      windowsHide: true,
    });
    if (result.error) {
      console.warn(`[electron:ensure] could not run \`${label}\`: ${result.error.message}`);
      continue;
    }
    if (result.status === 0 && isComplete(electronDir)) {
      console.log(`[electron:ensure] repaired electron install at ${electronDir}`);
      return true;
    }
    console.warn(`[electron:ensure] \`${label}\` exited with code ${result.status ?? 'null'}`);
  }
  return false;
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const bestEffort = argv.includes('--best-effort');

  const overrideDir = env.OPENCHAMBER_ELECTRON_PKG_DIR;
  const electronDir = overrideDir
    ? fs.existsSync(path.join(overrideDir, 'package.json'))
      ? overrideDir
      : null
    : resolveElectronPackageDir();

  if (!electronDir) {
    const message = '[electron:ensure] could not locate the installed `electron` package';
    if (bestEffort) {
      console.warn(message);
      return 0;
    }
    console.error(message);
    return 1;
  }

  if (isComplete(electronDir)) {
    return 0;
  }

  if (env.ELECTRON_SKIP_BINARY_DOWNLOAD) {
    console.warn(
      '[electron:ensure] electron binary is missing but ELECTRON_SKIP_BINARY_DOWNLOAD is set; skipping repair.',
    );
    return bestEffort ? 0 : 1;
  }

  console.warn(
    `[electron:ensure] electron install at ${electronDir} is incomplete ` +
      '(missing binary, path.txt, version, or architecture mismatch); repairing…',
  );

  if (repair(electronDir, { env })) {
    return 0;
  }

  const message =
    '[electron:ensure] electron is still incomplete after repair; ' +
    'run `bun run --cwd packages/electron ensure:electron` with a network connection.';
  if (bestEffort) {
    console.warn(message);
    return 0;
  }
  console.error(message);
  return 1;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error('[electron:ensure] unexpected error:', error);
    process.exitCode = 1;
  }
}
