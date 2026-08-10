/**
 * Managed Chrome/Chromium install for the Agent Browser surface.
 *
 * Linux: extracts the official Google Chrome .deb (amd64 + arm64) without a
 * system package install — works on headless servers when `dpkg-deb` is present.
 * macOS/Windows: downloads Chrome for Testing zip builds.
 *
 * Install root: `<dataDir>/browser/install/`
 */

import { createWriteStream, existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';

const CFT_LAST_KNOWN_GOOD =
  'https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json';
const CHROME_DEB = {
  'linux-x64': 'https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb',
  'linux-arm64': 'https://dl.google.com/linux/direct/google-chrome-stable_current_arm64.deb',
};

export const MANAGED_BROWSER_MARKER = 'install.json';

export const resolveBrowserInstallPlatform = ({
  platform = process.platform,
  arch = process.arch,
} = {}) => {
  if (platform === 'linux') {
    if (arch === 'arm64' || arch === 'aarch64') return 'linux-arm64';
    if (arch === 'x64' || arch === 'x86_64' || arch === 'amd64') return 'linux-x64';
    return null;
  }
  if (platform === 'darwin') {
    return arch === 'arm64' ? 'mac-arm64' : 'mac-x64';
  }
  if (platform === 'win32') {
    return 'win64';
  }
  return null;
};

export const getManagedBrowserInstallDir = (dataDir, pathModule = path) =>
  pathModule.join(dataDir, 'browser', 'install');

const markerPath = (installDir, pathModule = path) =>
  pathModule.join(installDir, MANAGED_BROWSER_MARKER);

export const readManagedBrowserMarker = async (installDir, { fsPromises = { readFile }, pathModule = path } = {}) => {
  try {
    const raw = await fsPromises.readFile(markerPath(installDir, pathModule), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.executable !== 'string' || !parsed.executable.trim()) return null;
    return parsed;
  } catch {
    return null;
  }
};

export const resolveManagedBrowserExecutable = (installDir, { fs = { existsSync }, pathModule = path } = {}) => {
  // Synchronous probe used by discovery — prefer marker, then known relative paths.
  const markerFile = markerPath(installDir, pathModule);
  try {
    if (fs.existsSync(markerFile)) {
      const raw = typeof fs.readFileSync === 'function'
        ? fs.readFileSync(markerFile, 'utf8')
        : readFileSync(markerFile, 'utf8');
      const parsed = JSON.parse(raw);
      const executable = typeof parsed?.executable === 'string' ? parsed.executable.trim() : '';
      if (executable && fs.existsSync(executable)) return executable;
    }
  } catch {
    // fall through
  }
  const fallbacks = [
    pathModule.join(installDir, 'opt', 'google', 'chrome', 'google-chrome'),
    pathModule.join(installDir, 'chrome-linux64', 'chrome'),
    pathModule.join(installDir, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
    pathModule.join(installDir, 'chrome-mac-x64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
    pathModule.join(installDir, 'chrome-win64', 'chrome.exe'),
  ];
  for (const candidate of fallbacks) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
};

const downloadToFile = async (url, outputPath, onProgress) => {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to download ${url}: ${res.status} ${res.statusText}`);
  }
  if (!res.body) {
    throw new Error(`Failed to download ${url}: missing response body`);
  }
  const totalBytes = Number.parseInt(res.headers.get('content-length') || '', 10) || null;
  let downloadedBytes = 0;
  const tmpPath = `${outputPath}.tmp-${Date.now()}`;
  await mkdir(path.dirname(outputPath), { recursive: true });
  const nodeStream = Readable.fromWeb(res.body);
  if (typeof onProgress === 'function') {
    nodeStream.on('data', (chunk) => {
      downloadedBytes += chunk.length;
      onProgress({ phase: 'download', downloadedBytes, totalBytes });
    });
  }
  try {
    await pipeline(nodeStream, createWriteStream(tmpPath));
    await rename(tmpPath, outputPath);
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => undefined);
    throw error;
  }
};

const runCommand = (command, args, { cwd } = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore', windowsHide: true, cwd });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code}`));
    });
  });

const extractDeb = async (debPath, destDir) => {
  await mkdir(destDir, { recursive: true });
  await runCommand('dpkg-deb', ['-x', debPath, destDir]);
};

const extractZip = async (zipPath, destDir) => {
  await mkdir(destDir, { recursive: true });
  if (process.platform === 'win32') {
    await runCommand('powershell.exe', [
      '-NoProfile',
      '-Command',
      `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`,
    ]);
    return;
  }
  await runCommand('unzip', ['-o', zipPath, '-d', destDir]);
};

const pickChromeForTestingUrl = async (cftPlatform) => {
  const res = await fetch(CFT_LAST_KNOWN_GOOD);
  if (!res.ok) {
    throw new Error(`Failed to resolve Chrome for Testing catalog: ${res.status}`);
  }
  const json = await res.json();
  const version = json?.channels?.Stable?.version;
  const downloads = json?.channels?.Stable?.downloads?.chrome;
  if (!Array.isArray(downloads)) {
    throw new Error('Chrome for Testing catalog is missing Stable chrome downloads');
  }
  const match = downloads.find((entry) => entry?.platform === cftPlatform);
  if (!match?.url) {
    throw new Error(`Chrome for Testing has no Stable build for platform ${cftPlatform}`);
  }
  return { version: String(version || ''), url: String(match.url) };
};

const cftPlatformFor = (installPlatform) => {
  switch (installPlatform) {
    case 'linux-x64':
      return 'linux64';
    case 'mac-arm64':
      return 'mac-arm64';
    case 'mac-x64':
      return 'mac-x64';
    case 'win64':
      return 'win64';
    default:
      return null;
  }
};

const findExtractedExecutable = (installDir, installPlatform) => {
  const relative = {
    'linux-arm64': ['opt/google/chrome/google-chrome'],
    'linux-x64': [
      'opt/google/chrome/google-chrome',
      'chrome-linux64/chrome',
    ],
    'mac-arm64': [
      'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    ],
    'mac-x64': [
      'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    ],
    win64: ['chrome-win64/chrome.exe'],
  }[installPlatform] || [];
  for (const rel of relative) {
    const full = path.join(installDir, rel);
    if (existsSync(full)) return full;
  }
  return resolveManagedBrowserExecutable(installDir);
};

export const shouldDefaultNoSandbox = ({
  platform = process.platform,
  getuid = typeof process.getuid === 'function' ? process.getuid.bind(process) : null,
  fs = { existsSync },
} = {}) => {
  if (platform !== 'linux') return false;
  if (typeof getuid === 'function' && getuid() === 0) return true;
  try {
    if (fs.existsSync('/.dockerenv')) return true;
  } catch {
    // ignore
  }
  return false;
};

/**
 * Install a managed Chrome/Chromium build into dataDir and write install.json.
 * @returns {Promise<{ executable: string, version: string, platform: string, source: string }>}
 */
export const installManagedBrowser = async ({
  dataDir,
  onProgress,
  platform = process.platform,
  arch = process.arch,
} = {}) => {
  const installPlatform = resolveBrowserInstallPlatform({ platform, arch });
  if (!installPlatform) {
    throw new Error(`Managed browser install is not supported on ${platform}/${arch}`);
  }

  const installDir = getManagedBrowserInstallDir(dataDir);
  await mkdir(installDir, { recursive: true });
  await rm(path.join(installDir, 'staging'), { recursive: true, force: true }).catch(() => undefined);
  const stagingDir = path.join(installDir, 'staging');
  await mkdir(stagingDir, { recursive: true });

  try {
    let version = 'stable';
    let source = 'google-chrome-deb';
    let archivePath;

    if (installPlatform === 'linux-arm64' || (installPlatform === 'linux-x64' && CHROME_DEB[installPlatform])) {
      // Prefer .deb for Linux so arm64 works (Chrome for Testing has no linux-arm64).
      const url = CHROME_DEB[installPlatform];
      archivePath = path.join(stagingDir, path.basename(url));
      onProgress?.({ phase: 'download', downloadedBytes: 0, totalBytes: null });
      await downloadToFile(url, archivePath, onProgress);
      onProgress?.({ phase: 'extract' });
      // Extract into installDir root so opt/google/chrome lands predictably.
      await extractDeb(archivePath, installDir);
      source = 'google-chrome-deb';
    } else {
      const cftPlatform = cftPlatformFor(installPlatform);
      if (!cftPlatform) {
        throw new Error(`No Chrome for Testing mapping for ${installPlatform}`);
      }
      const catalog = await pickChromeForTestingUrl(cftPlatform);
      version = catalog.version || version;
      archivePath = path.join(stagingDir, `chrome-${cftPlatform}.zip`);
      onProgress?.({ phase: 'download', downloadedBytes: 0, totalBytes: null });
      await downloadToFile(catalog.url, archivePath, onProgress);
      onProgress?.({ phase: 'extract' });
      await extractZip(archivePath, installDir);
      source = 'chrome-for-testing';
    }

    const executable = findExtractedExecutable(installDir, installPlatform);
    if (!executable) {
      throw new Error('Browser archive extracted but the executable was not found');
    }
    if (process.platform !== 'win32') {
      await chmod(executable, 0o755).catch(() => undefined);
    }

    const marker = {
      version,
      platform: installPlatform,
      source,
      executable,
      installedAt: new Date().toISOString(),
    };
    await writeFile(markerPath(installDir), `${JSON.stringify(marker, null, 2)}\n`, 'utf8');
    onProgress?.({ phase: 'done', executable });
    return marker;
  } finally {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
  }
};

export const getHostBrowserProbe = () => ({
  platform: process.platform,
  arch: process.arch,
  installPlatform: resolveBrowserInstallPlatform(),
  installSupported: Boolean(resolveBrowserInstallPlatform()),
  defaultNoSandbox: shouldDefaultNoSandbox(),
  hostname: os.hostname(),
});
