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

export const findBrowserExecutable = ({ fs, path, env = process.env, platform = process.platform, searchPathFor }) => {
  const explicit = typeof env.OPENCHAMBER_BROWSER_PATH === 'string' ? env.OPENCHAMBER_BROWSER_PATH.trim() : '';
  if (explicit) {
    return fs.existsSync(explicit) ? explicit : null;
  }
  if (platform === 'darwin') {
    for (const candidate of DARWIN_CANDIDATES) {
      if (fs.existsSync(candidate)) return candidate;
    }
    return null;
  }
  if (platform === 'win32') {
    for (const candidate of windowsCandidatePaths(env, path)) {
      if (fs.existsSync(candidate)) return candidate;
    }
    return null;
  }
  for (const candidate of LINUX_CANDIDATES) {
    const resolved = typeof searchPathFor === 'function' ? searchPathFor(candidate) : null;
    if (resolved) return resolved;
  }
  return null;
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

export const buildChromeLaunchArgs = ({ profileDir, isRoot = false }) => [
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
  '--mute-audio',
  '--window-size=1280,800',
  // Sandboxing is unavailable for root (typical for containers); headless work
  // continues without it there. Non-root keeps the sandbox.
  ...(isRoot ? ['--no-sandbox'] : []),
  'about:blank',
];

export const launchChrome = async ({ fsPromises, path, spawn, executable, profileDir, env = process.env }) => {
  await fsPromises.mkdir(profileDir, { recursive: true });
  await fsPromises.rm(path.join(profileDir, DEVTOOLS_PORT_FILE), { force: true }).catch(() => {});
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  const child = spawn(executable, buildChromeLaunchArgs({ profileDir, isRoot }), {
    env: { ...env },
    stdio: ['ignore', 'ignore', 'ignore'],
    detached: process.platform !== 'win32',
  });
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
