import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { WebSocket } from 'ws';

// allow: SIZE_OK — process ownership, generation cancellation, and CDP readiness form one lifecycle state machine.
const DEVTOOLS_PORT_FILE = 'DevToolsActivePort';
const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_POLL_INTERVAL_MS = 50;

const checkDebugPortAvailable = (port) => new Promise((resolve, reject) => {
  const listener = net.createServer();
  listener.once('error', () => reject(new Error(
    `Chrome debugging port ${port} is unavailable on 127.0.0.1. Choose another port or stop the process using it.`,
  )));
  listener.listen({ host: '127.0.0.1', port, exclusive: true }, () => listener.close(resolve));
});

/** Chrome 109 introduced the required `--headless=new` launch mode. */
export const MINIMUM_CHROME_MAJOR_VERSION = 109;

const executableExists = (candidate, platform) => {
  try {
    fs.accessSync(candidate, platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const systemCandidates = (platform, env, pathModule) => {
  if (platform === 'darwin') {
    return ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
  }
  if (platform === 'win32') {
    const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean);
    return roots.map((root) => pathModule.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  }
  const names = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'];
  const pathEntries = String(env.PATH || '').split(pathModule.delimiter).filter(Boolean);
  return [
    ...pathEntries.flatMap((entry) => names.map((name) => pathModule.join(entry, name))),
    ...['/usr/bin', '/usr/sbin', '/usr/local/bin', '/snap/bin'].flatMap((entry) =>
      names.map((name) => pathModule.join(entry, name))),
  ];
};

const resolveChromeExecutable = ({ env, platform, pathModule, isExecutable }) => {
  const configured = typeof env.OPENCHAMBER_CHROME_PATH === 'string'
    ? env.OPENCHAMBER_CHROME_PATH.trim()
    : '';
  if (configured) {
    if (isExecutable(configured, platform)) return configured;
    throw new Error(
      `OPENCHAMBER_CHROME_PATH points to an unavailable Chrome executable: ${configured}. ` +
      'Set OPENCHAMBER_CHROME_PATH to an executable Chrome or Chromium binary.',
    );
  }
  const discovered = systemCandidates(platform, env, pathModule)
    .find((candidate) => isExecutable(candidate, platform));
  if (discovered) return discovered;
  throw new Error(
    'Chrome or Chromium was not found. Set OPENCHAMBER_CHROME_PATH to an executable Chrome or Chromium binary.',
  );
};

const parseDevToolsFile = (contents) => {
  const [portLine, websocketPath] = contents.split(/\r?\n/);
  const port = Number.parseInt(portLine?.trim() || '', 10);
  const suffix = websocketPath?.trim() || '';
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !suffix.startsWith('/devtools/browser/')) return null;
  return `ws://127.0.0.1:${port}${suffix}`;
};

const parseVersion = (payload) => {
  const product = typeof payload?.product === 'string' ? payload.product : '';
  const userAgent = typeof payload?.userAgent === 'string' ? payload.userAgent : '';
  const match = `${product} ${userAgent}`.match(/(?:Chrome|Chromium)\/(\d+)/i);
  if (!match) {
    throw new Error('Chrome Browser.getVersion returned no recognizable Chrome major version. Update Chrome and retry.');
  }
  return { ...payload, major: Number.parseInt(match[1], 10) };
};

const probeBrowserVersion = (webSocketDebuggerUrl, timeoutMs) => new Promise((resolve, reject) => {
  const socket = new WebSocket(webSocketDebuggerUrl, { handshakeTimeout: timeoutMs });
  const timeout = setTimeout(() => {
    socket.terminate();
    reject(new Error('Browser.getVersion probe timed out'));
  }, timeoutMs);
  const finish = (error, result) => {
    clearTimeout(timeout);
    socket.close();
    if (error) reject(error);
    else resolve(result);
  };
  socket.once('open', () => socket.send(JSON.stringify({ id: 1, method: 'Browser.getVersion' })));
  socket.once('error', (error) => finish(new Error(`Browser.getVersion probe failed: ${error.message}`)));
  socket.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString());
      if (message.id !== 1) return;
      if (message.error) finish(new Error(`Browser.getVersion probe failed: ${message.error.message || 'CDP error'}`));
      else finish(null, message.result);
    } catch (error) {
      finish(new Error(`Browser.getVersion returned invalid JSON: ${error.message}`));
    }
  });
});

/**
 * Create one host-scoped Chrome lifecycle manager.
 *
 * `ensureProcess()` coalesces callers for the current generation. Pass a larger
 * `{ generation }` to supersede and kill the prior launch. Register `shutdown`
 * in the server's ordered graceful-shutdown sequence.
 */
export const createChromeProcessManager = (options = {}) => {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const pathModule = options.pathModule ?? path;
  const fsPromises = options.fsPromises ?? fs.promises;
  const spawn = options.spawn ?? nodeSpawn;
  const isExecutable = options.isExecutable ?? executableExists;
  const tmpDir = options.tmpDir ?? os.tmpdir();
  const startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const minimumMajorVersion = options.minimumMajorVersion ?? MINIMUM_CHROME_MAJOR_VERSION;
  const versionProbe = options.probeVersion ?? probeBrowserVersion;
  const processLike = options.processLike ?? process;
  let generation = 0;
  let active = null;

  const removeProfile = async (record) => {
    if (!record?.profileDir) return;
    await fsPromises.rm(record.profileDir, { recursive: true, force: true });
  };

  const terminate = async (record) => {
    if (!record) return;
    record.intentional = true;
    if (!record.exited) {
      if (platform !== 'win32' && Number.isInteger(record.child.pid)) {
        try { processLike.kill(-record.child.pid, 'SIGKILL'); } catch {}
      }
      try { record.child.kill('SIGKILL'); } catch {}
    }
    await removeProfile(record);
  };

  const cancel = (holder, error, kill = true) => {
    if (holder.cancelError) return;
    holder.cancelError = error;
    holder.resolveCancelled(error);
    if (kill && holder.record) void terminate(holder.record);
  };

  const raceCancellation = (promise, holder) => Promise.race([
    promise,
    holder.cancelled.then((error) => { throw error; }),
  ]);

  const waitForEndpoint = async (record, holder, deadline) => {
    let fileCheckedAfterStderr = false;
    while (Date.now() < deadline) {
      let endpoint = null;
      try {
        endpoint = parseDevToolsFile(
          await fsPromises.readFile(pathModule.join(record.profileDir, DEVTOOLS_PORT_FILE), 'utf8'),
        );
      } catch {}
      if (endpoint) return endpoint;
      if (record.stderrEndpoint && fileCheckedAfterStderr) return record.stderrEndpoint;
      if (record.stderrEndpoint) fileCheckedAfterStderr = true;
      await raceCancellation(
        new Promise((resolve) => setTimeout(resolve, Math.min(pollIntervalMs, deadline - Date.now()))),
        holder,
      );
    }
    const portDetail = holder.debugPort > 0 ? ` on configured port ${holder.debugPort}` : '';
    throw new Error(`Timed out waiting for Chrome generation ${holder.generation} DevTools readiness${portDetail}`);
  };

  const launch = async (holder) => {
    let record = null;
    let profileDir = null;
    try {
      holder.debugPort = options.getDebugPort ? options.getDebugPort() : 0;
      if (!Number.isInteger(holder.debugPort) || holder.debugPort < 0 || holder.debugPort > 65535) {
        throw new Error('Chrome debugging port must be an integer from 0 to 65535');
      }
      if (holder.debugPort > 0) await checkDebugPortAvailable(holder.debugPort);
      const executable = resolveChromeExecutable({ env, platform, pathModule, isExecutable });
      profileDir = await fsPromises.mkdtemp(
        pathModule.join(tmpDir, `openchamber-chrome-${holder.generation}-`),
      );
      await fsPromises.chmod(profileDir, 0o700);
      if (holder.cancelError) {
        await fsPromises.rm(profileDir, { recursive: true, force: true });
        throw holder.cancelError;
      }
      const args = [
        '--headless=new',
        '--webrtc-ip-handling-policy=disable_non_proxied_udp',
        `--remote-debugging-port=${holder.debugPort}`,
        '--remote-debugging-address=127.0.0.1',
        `--user-data-dir=${profileDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        'about:blank',
      ];
      const child = spawn(executable, args, {
        env: { ...env },
        stdio: ['ignore', 'ignore', 'pipe'],
        detached: platform !== 'win32',
        windowsHide: true,
      });
      record = { child, profileDir, intentional: false, exited: false, stderrEndpoint: null };
      holder.record = record;
      child.stderr?.on('data', (chunk) => {
        const match = String(chunk).match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[^\s]+)/);
        if (match) record.stderrEndpoint = match[1];
      });
      child.once('error', (error) => cancel(holder,
        new Error(`Chrome generation ${holder.generation} failed to spawn: ${error.message}`), false));
      child.once('exit', (code, signal) => {
        record.exited = true;
        if (record.intentional) return;
        cancel(holder, new Error(
          `Chrome generation ${holder.generation} exited unexpectedly ` +
          `(code ${code ?? 'null'}${signal ? `, signal ${signal}` : ''})`,
        ), false);
        void removeProfile(record);
        if (active === holder) active = null;
      });

      const deadline = Date.now() + startupTimeoutMs;
      const webSocketDebuggerUrl = await waitForEndpoint(record, holder, deadline);
      const activePort = Number(new URL(webSocketDebuggerUrl).port);
      if (holder.debugPort > 0 && activePort !== holder.debugPort) {
        throw new Error(`Chrome debugging port ${holder.debugPort} was requested, but the child announced port ${activePort}`);
      }
      options.beforeVersionProbe?.({ process: child, generation: holder.generation, webSocketDebuggerUrl });
      const remainingMs = Math.max(1, deadline - Date.now());
      let rawVersion;
      try {
        rawVersion = await raceCancellation(versionProbe(webSocketDebuggerUrl, remainingMs), holder);
      } catch (error) {
        if (!holder.cancelError && !record.exited) {
          await Promise.race([
            holder.cancelled,
            new Promise((resolve) => setTimeout(resolve, Math.min(100, remainingMs))),
          ]);
        }
        throw holder.cancelError ?? error;
      }
      const version = parseVersion(rawVersion);
      if (version.major < minimumMajorVersion) {
        throw new Error(
          `Chrome ${minimumMajorVersion}+ is required, but Browser.getVersion reported ${version.major}. ` +
          'Update Chrome or set OPENCHAMBER_CHROME_PATH to a newer executable.',
        );
      }
      if (holder.cancelError || active !== holder) throw holder.cancelError ?? new Error('Chrome launch was superseded');
      holder.ready = true;
      holder.result = {
        process: child,
        generation: holder.generation,
        webSocketDebuggerUrl,
        activePort,
        version,
      };
      return holder.result;
    } catch (error) {
      await terminate(record);
      if (!record && profileDir) {
        await fsPromises.rm(profileDir, { recursive: true, force: true });
      }
      if (active === holder) active = null;
      throw error;
    }
  };

  const startGeneration = (targetGeneration) => {
    let resolveCancelled;
    const holder = {
      generation: targetGeneration,
      debugPort: null,
      record: null,
      ready: false,
      result: null,
      cancelError: null,
      cancelled: new Promise((resolve) => { resolveCancelled = resolve; }),
      resolveCancelled: null,
      promise: null,
    };
    holder.resolveCancelled = resolveCancelled;
    active = holder;
    holder.promise = launch(holder);
    return holder.promise;
  };

  const ensureProcess = ({ generation: requestedGeneration = generation } = {}) => {
    if (!Number.isInteger(requestedGeneration) || requestedGeneration < 0) {
      return Promise.reject(new Error('Chrome generation must be a non-negative integer'));
    }
    if (requestedGeneration < generation) {
      return Promise.reject(new Error(`Chrome generation ${requestedGeneration} was superseded by generation ${generation}`));
    }
    if (requestedGeneration > generation) {
      const previous = active;
      generation = requestedGeneration;
      active = null;
      if (previous) cancel(previous,
        new Error(`Chrome generation ${previous.generation} was superseded by generation ${generation}`));
    }
    if (active?.generation === generation) return active.ready ? Promise.resolve(active.result) : active.promise;
    return startGeneration(generation);
  };

  const kill = async () => {
    generation += 1;
    const previous = active;
    active = null;
    if (!previous) return;
    cancel(previous, new Error(`Chrome generation ${previous.generation} was stopped`), false);
    await previous.promise.catch(() => {});
    await terminate(previous.record);
  };

  const manager = {
    ensureProcess,
    kill,
    shutdown: kill,
    async getPrivatePorts() {
      const holder = active;
      if (!holder) return [];
      // An automatic listener can exist before the version probe completes.
      // Discovery waits for that launch or its cleanup before granting ports.
      await holder.promise.catch(() => {});
      return [holder.debugPort, holder.result?.activePort].filter((port) => Number.isInteger(port) && port > 0);
    },
    get generation() { return generation; },
    get activePort() { return active?.result?.activePort ?? null; },
    get launchDebugPort() { return active?.debugPort ?? null; },
    get webSocketDebuggerUrl() { return active?.result?.webSocketDebuggerUrl ?? null; },
  };
  options.registerShutdownHook?.(manager.shutdown);
  return manager;
};
