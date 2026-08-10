import {
  getManagedBrowserInstallDir,
  resolveManagedBrowserExecutable,
} from './install.js';

const DEVTOOLS_PORT_FILE = 'DevToolsActivePort';
const LAUNCH_TIMEOUT_MS = 15_000;
const PORT_FILE_POLL_MS = 100;

const LINUX_CANDIDATES = [
  'google-chrome-stable',
  'google-chrome',
  'chromium-browser',
  'chromium',
  'microsoft-edge-stable',
  'microsoft-edge',
  'brave-browser',
];

const LINUX_ABSOLUTE_CANDIDATES = [
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/snap/bin/chromium',
  '/usr/lib/chromium/chromium',
  '/usr/lib/chromium-browser/chromium-browser',
];

const DARWIN_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
];

const WINDOWS_RELATIVE_CANDIDATES = [
  'Google\\Chrome\\Application\\chrome.exe',
  'Microsoft\\Edge\\Application\\msedge.exe',
  'Chromium\\Application\\chrome.exe',
  'BraveSoftware\\Brave-Browser\\Application\\brave.exe',
];

const windowsCandidatePaths = (env, path) => {
  const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean);
  const candidates = [];
  for (const root of roots) {
    for (const relative of WINDOWS_RELATIVE_CANDIDATES) {
      candidates.push(path.join(root, relative));
    }
  }
  return candidates;
};

const firstExisting = (candidates, fs) => {
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // keep searching
    }
  }
  return null;
};

/**
 * Resolve a Chrome-compatible executable.
 * Order: settings path → OPENCHAMBER_BROWSER_PATH → managed install → OS discovery.
 */
export const findBrowserExecutable = ({
  fs,
  path,
  env = process.env,
  platform = process.platform,
  searchPathFor,
  preferredPath,
  dataDir,
} = {}) => {
  const preferred = typeof preferredPath === 'string' ? preferredPath.trim() : '';
  if (preferred) {
    return fs.existsSync(preferred) ? preferred : null;
  }

  const explicit = typeof env.OPENCHAMBER_BROWSER_PATH === 'string' ? env.OPENCHAMBER_BROWSER_PATH.trim() : '';
  if (explicit) {
    return fs.existsSync(explicit) ? explicit : null;
  }

  if (dataDir) {
    const managed = resolveManagedBrowserExecutable(getManagedBrowserInstallDir(dataDir, path), { fs, pathModule: path });
    if (managed) return managed;
  }

  if (platform === 'darwin') {
    return firstExisting(DARWIN_CANDIDATES, fs);
  }
  if (platform === 'win32') {
    return firstExisting(windowsCandidatePaths(env, path), fs);
  }

  const fromPath = [];
  for (const candidate of LINUX_CANDIDATES) {
    const resolved = typeof searchPathFor === 'function' ? searchPathFor(candidate) : null;
    if (resolved) fromPath.push(resolved);
  }
  return firstExisting([...fromPath, ...LINUX_ABSOLUTE_CANDIDATES], fs);
};

export const resolveBrowserExecutableSource = ({
  fs,
  path,
  env = process.env,
  platform = process.platform,
  searchPathFor,
  preferredPath,
  dataDir,
} = {}) => {
  const preferred = typeof preferredPath === 'string' ? preferredPath.trim() : '';
  if (preferred) {
    return {
      executable: fs.existsSync(preferred) ? preferred : null,
      source: 'settings',
      missingPreferred: !fs.existsSync(preferred),
    };
  }
  const explicit = typeof env.OPENCHAMBER_BROWSER_PATH === 'string' ? env.OPENCHAMBER_BROWSER_PATH.trim() : '';
  if (explicit) {
    return {
      executable: fs.existsSync(explicit) ? explicit : null,
      source: 'env',
      missingPreferred: !fs.existsSync(explicit),
    };
  }
  if (dataDir) {
    const managed = resolveManagedBrowserExecutable(getManagedBrowserInstallDir(dataDir, path), { fs, pathModule: path });
    if (managed) return { executable: managed, source: 'managed', missingPreferred: false };
  }
  const discovered = findBrowserExecutable({
    fs,
    path,
    env: { ...env, OPENCHAMBER_BROWSER_PATH: '' },
    platform,
    searchPathFor,
    preferredPath: '',
    dataDir: null,
  });
  return { executable: discovered, source: discovered ? 'path' : 'none', missingPreferred: false };
};

const readDevToolsEndpoint = async ({ fsPromises, path, profileDir }) => {
  const contents = await fsPromises.readFile(path.join(profileDir, DEVTOOLS_PORT_FILE), 'utf8').catch(() => null);
  if (!contents) return null;
  const [portLine, wsPathLine] = contents.split('\n');
  const port = Number.parseInt(String(portLine || '').trim(), 10);
  const wsPath = String(wsPathLine || '').trim();
  if (!Number.isInteger(port) || port <= 0 || !wsPath.startsWith('/devtools/browser/')) return null;
  return `ws://127.0.0.1:${port}${wsPath}`;
};

const envFlagEnabled = (env, key) => {
  const raw = typeof env?.[key] === 'string' ? env[key].trim().toLowerCase() : '';
  return raw === '1' || raw === 'true' || raw === 'yes';
};

export const buildChromeLaunchArgs = ({
  profileDir,
  isRoot = false,
  noSandbox = false,
  env = process.env,
} = {}) => {
  const disableSandbox = noSandbox === true || isRoot || envFlagEnabled(env, 'OPENCHAMBER_BROWSER_NO_SANDBOX');
  return [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-sync',
    '--disable-translate',
    '--disable-search-engine-choice-screen',
    '--disable-session-crashed-bubble',
    '--disable-infobars',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--mute-audio',
    '--window-size=1280,800',
    // Sandboxing is often unavailable in containers/VMs (root, Docker, restricted
    // user namespaces). Prefer the explicit setting/env over guessing.
    ...(disableSandbox ? ['--no-sandbox', '--disable-setuid-sandbox'] : []),
    'about:blank',
  ];
};

export const launchChrome = async ({
  fsPromises,
  path,
  spawn,
  executable,
  profileDir,
  env = process.env,
  noSandbox = false,
}) => {
  await fsPromises.mkdir(profileDir, { recursive: true });
  await fsPromises.rm(path.join(profileDir, DEVTOOLS_PORT_FILE), { force: true }).catch(() => {});
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  const child = spawn(
    executable,
    buildChromeLaunchArgs({ profileDir, isRoot, noSandbox, env }),
    {
      env: { ...env },
      stdio: ['ignore', 'ignore', 'ignore'],
      detached: process.platform !== 'win32',
    },
  );
  let exited = false;
  child.once('exit', () => {
    exited = true;
  });
  const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (exited) {
      throw new Error('Browser process exited before it became controllable');
    }
    const endpoint = await readDevToolsEndpoint({ fsPromises, path, profileDir });
    if (endpoint) {
      return { process: child, webSocketDebuggerUrl: endpoint };
    }
    await new Promise((resolve) => setTimeout(resolve, PORT_FILE_POLL_MS));
  }
  try {
    child.kill('SIGKILL');
  } catch {
    // already gone
  }
  throw new Error('Timed out waiting for the browser DevTools endpoint');
};

export const killChromeProcess = (child) => {
  if (!child) return;
  if (process.platform !== 'win32' && Number.isInteger(child.pid) && child.pid > 0) {
    try {
      process.kill(-child.pid, 'SIGKILL');
      return;
    } catch {
      // fall through to direct kill
    }
  }
  try {
    child.kill('SIGKILL');
  } catch {
    // already gone
  }
};
