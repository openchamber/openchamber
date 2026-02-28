#!/usr/bin/env node

import path from 'path';
import fs from 'fs';
import net from 'net';
import { spawn, spawnSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_PORT = 3000;
const PACKAGE_JSON = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

function getBunBinary() {
  if (typeof process.env.BUN_BINARY === 'string' && process.env.BUN_BINARY.trim().length > 0) {
    return process.env.BUN_BINARY.trim();
  }
  if (typeof process.env.BUN_INSTALL === 'string' && process.env.BUN_INSTALL.trim().length > 0) {
    return path.join(process.env.BUN_INSTALL.trim(), 'bin', 'bun');
  }
  return 'bun';
}

const BUN_BIN = getBunBinary();

function importFromFilePath(filePath) {
  return import(pathToFileURL(filePath).href);
}

function isBunRuntime() {
  return typeof globalThis.Bun !== 'undefined';
}

function isBunInstalled() {
  try {
    const result = spawnSync(BUN_BIN, ['--version'], { stdio: 'ignore', env: process.env });
    return result.status === 0;
  } catch {
    return false;
  }
}

function getPreferredServerRuntime() {
  return isBunInstalled() ? 'bun' : 'node';
}

function generateRandomPassword(length = 16) {
  const charset = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let password = '';
  for (let i = 0; i < length; i++) {
    const randomIndex = Math.floor(Math.random() * charset.length);
    password += charset[randomIndex];
  }
  return password;
}

async function displayTunnelQrCode(url) {
  try {
    const qrcode = await import('qrcode-terminal');
    console.log('\n📱 Scan this QR code to access the tunnel:\n');
    qrcode.default.generate(url, { small: true });
    console.log('');
  } catch (error) {
    console.warn('⚠️  Could not generate QR code:', error.message);
  }
}

function buildTunnelUrl(baseUrl, password, includePassword) {
  if (!includePassword || !password) {
    return baseUrl;
  }
  const url = new URL(baseUrl);
  url.searchParams.set('token', password);
  return url.toString();
}

function parseArgs() {
  const args = process.argv.slice(2);
  const envPassword = process.env.OPENCHAMBER_UI_PASSWORD || undefined;
  const options = { port: DEFAULT_PORT, daemon: false, uiPassword: envPassword, tryCfTunnel: false, tunnelQr: false, tunnelPasswordUrl: false };
  let command = 'serve';

  const consumeValue = (currentIndex, inlineValue) => {
    if (typeof inlineValue === 'string' && inlineValue.length > 0) {
      return { value: inlineValue, nextIndex: currentIndex };
    }
    const candidate = args[currentIndex + 1];
    if (typeof candidate === 'string' && !candidate.startsWith('-')) {
      return { value: candidate, nextIndex: currentIndex + 1 };
    }
    return { value: undefined, nextIndex: currentIndex };
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg.startsWith('-')) {
      let optionName;
      let inlineValue;

      if (arg.startsWith('--')) {
        const eqIndex = arg.indexOf('=');
        optionName = eqIndex >= 0 ? arg.slice(2, eqIndex) : arg.slice(2);
        inlineValue = eqIndex >= 0 ? arg.slice(eqIndex + 1) : undefined;
      } else {
        optionName = arg.slice(1);
        inlineValue = undefined;
      }

      switch (optionName) {
        case 'port':
        case 'p': {
          const { value, nextIndex } = consumeValue(i, inlineValue);
          i = nextIndex;
          const parsed = parseInt(value ?? '', 10);
          options.port = Number.isFinite(parsed) ? parsed : DEFAULT_PORT;
          break;
        }
        case 'daemon':
        case 'd':
          options.daemon = true;
          break;
        case 'try-cf-tunnel':
          options.tryCfTunnel = true;
          break;
        case 'tunnel-qr':
          options.tunnelQr = true;
          break;
        case 'tunnel-password-url':
          options.tunnelPasswordUrl = true;
          break;
        case 'ui-password': {
          const { value, nextIndex } = consumeValue(i, inlineValue);
          i = nextIndex;
          options.uiPassword = typeof value === 'string' ? value : '';
          break;
        }
        case 'help':
        case 'h':
          showHelp();
          process.exit(0);
          break;
        case 'version':
        case 'v':
          console.log(PACKAGE_JSON.version);
          process.exit(0);
          break;
      }
    } else {
      command = arg;
    }
  }

  return { command, options };
}

function showHelp() {
  console.log(`
 OpenChamber - Web interface for the OpenCode AI coding agent

USAGE:
  openchamber [COMMAND] [OPTIONS]

COMMANDS:
  serve          Start the web server (default)
  stop           Stop running instance(s)
  restart        Stop and start the server
  status         Show server status
  update         Check for and install updates

OPTIONS:
  -p, --port              Web server port (default: ${DEFAULT_PORT})
  --ui-password           Protect browser UI with single password
  --try-cf-tunnel         Create a Cloudflare Quick Tunnel for remote access
  --tunnel-qr             Display QR code for tunnel URL (use with --try-cf-tunnel)
  --tunnel-password-url   Include password in tunnel URL for auto-login
  -d, --daemon            Run in background (serve command)
  -h, --help              Show help
  -v, --version           Show version

ENVIRONMENT:
  OPENCHAMBER_UI_PASSWORD      Alternative to --ui-password flag
  OPENCODE_HOST               External OpenCode server base URL, e.g. http://hostname:4096 (overrides OPENCODE_PORT)
  OPENCODE_PORT               Port of external OpenCode server to connect to
  OPENCODE_SKIP_START          Skip starting OpenCode, use external server

EXAMPLES:
  openchamber                    # Start on default port 3000 (or a free port)
  openchamber --port 8080        # Start on port 8080
  openchamber serve --daemon     # Start in background
  openchamber --try-cf-tunnel    # Start with Cloudflare Quick Tunnel
  openchamber stop               # Stop all running instances
  openchamber stop --port 3000   # Stop specific instance
  openchamber status             # Check status
  openchamber update             # Update to latest version
`);
}

const WINDOWS_EXTENSIONS = process.platform === 'win32'
  ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM')
      .split(';')
      .map((ext) => ext.trim().toLowerCase())
      .filter(Boolean)
      .map((ext) => (ext.startsWith('.') ? ext : `.${ext}`))
  : [''];

function isExecutable(filePath) {
  try {
    const stats = fs.statSync(filePath);
    if (!stats.isFile()) {
      return false;
    }
    if (process.platform === 'win32') {
      return true;
    }
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch (error) {
    return false;
  }
}

function resolveExplicitBinary(candidate) {
  if (!candidate) {
    return null;
  }
  if (candidate.includes(path.sep) || path.isAbsolute(candidate)) {
    const resolved = path.isAbsolute(candidate) ? candidate : path.resolve(candidate);
    return isExecutable(resolved) ? resolved : null;
  }
  return null;
}

function searchPathFor(command) {
  const pathValue = process.env.PATH || '';
  const segments = pathValue.split(path.delimiter).filter(Boolean);
  for (const dir of segments) {
    for (const ext of WINDOWS_EXTENSIONS) {
      const fileName = process.platform === 'win32' ? `${command}${ext}` : command;
      const candidate = path.join(dir, fileName);
      if (isExecutable(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

async function checkOpenCodeCLI() {
  if (process.env.OPENCODE_BINARY) {
    const override = resolveExplicitBinary(process.env.OPENCODE_BINARY);
    if (override) {
      process.env.OPENCODE_BINARY = override;
      return override;
    }
    console.warn(`Warning: OPENCODE_BINARY="${process.env.OPENCODE_BINARY}" is not an executable file. Falling back to PATH lookup.`);
  }

  const resolvedFromPath = searchPathFor('opencode');
  if (resolvedFromPath) {
    process.env.OPENCODE_BINARY = resolvedFromPath;
    return resolvedFromPath;
  }

  if (process.platform !== 'win32') {
    const shellCandidates = [];
    if (process.env.SHELL) {
      shellCandidates.push(process.env.SHELL);
    }
    shellCandidates.push('/bin/bash', '/bin/zsh', '/bin/sh');

    for (const shellPath of shellCandidates) {
      if (!shellPath || !isExecutable(shellPath)) {
        continue;
      }
      try {
        const result = spawnSync(shellPath, ['-lic', 'command -v opencode'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        if (result.status === 0) {
          const candidate = result.stdout.trim().split(/\s+/).pop();
          if (candidate && isExecutable(candidate)) {
            const dir = path.dirname(candidate);
            const currentPath = process.env.PATH || '';
            const segments = currentPath.split(path.delimiter).filter(Boolean);
            if (!segments.includes(dir)) {
              segments.unshift(dir);
              process.env.PATH = segments.join(path.delimiter);
            }
            process.env.OPENCODE_BINARY = candidate;
            return candidate;
          }
        }
      } catch (error) {

      }
    }
  } else {
    try {
      const result = spawnSync('where', ['opencode'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      if (result.status === 0) {
        const candidate = result.stdout.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0);
        if (candidate && isExecutable(candidate)) {
          process.env.OPENCODE_BINARY = candidate;
          return candidate;
        }
      }
    } catch (error) {

    }
  }

  console.error('Error: Unable to locate the opencode CLI on PATH.');
  console.error(`Current PATH: ${process.env.PATH || '<empty>'}`);
  console.error('Ensure the CLI is installed and reachable, or set OPENCODE_BINARY to its full path.');
  process.exit(1);
}

async function isPortAvailable(port) {
  if (!Number.isFinite(port) || port <= 0) {
    return false;
  }

  // Don't specify host here; `server.listen(port)` in the web server also doesn't,
  // and on some platforms (notably macOS) IPv4/IPv6 binding differences can make
  // a 127.0.0.1-only probe report "free" while the real server bind fails.
  return await new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.on('error', () => resolve(false));
    server.listen({ port }, () => {
      server.close(() => resolve(true));
    });
  });
}


async function resolveAvailablePort(desiredPort) {
  const startPort = Number.isFinite(desiredPort) ? Math.trunc(desiredPort) : DEFAULT_PORT;

  // If user explicitly chose a port (incl 0), respect it.
  if (process.argv.includes('--port') || process.argv.includes('-p')) {
    return startPort;
  }

  // Prefer the default port for predictable URLs, but fall back to an OS-assigned
  // free port when it is already in use.
  if (await isPortAvailable(startPort)) {
    return startPort;
  }

  console.warn(`Port ${startPort} in use; using a free port`);
  return 0;
}

async function getPidFilePath(port) {
  const os = await import('os');
  const tmpDir = os.tmpdir();
  return path.join(tmpDir, `openchamber-${port}.pid`);
}

async function getInstanceFilePath(port) {
  const os = await import('os');
  const tmpDir = os.tmpdir();
  return path.join(tmpDir, `openchamber-${port}.json`);
}


function readPidFile(pidFilePath) {
  try {
    const content = fs.readFileSync(pidFilePath, 'utf8').trim();
    const pid = parseInt(content);
    if (isNaN(pid)) {
      return null;
    }
    return pid;
  } catch (error) {
    return null;
  }
}

function writePidFile(pidFilePath, pid) {
  try {
    fs.writeFileSync(pidFilePath, pid.toString());
  } catch (error) {
    console.warn(`Warning: Could not write PID file: ${error.message}`);
  }
}

function removePidFile(pidFilePath) {
  try {
    if (fs.existsSync(pidFilePath)) {
      fs.unlinkSync(pidFilePath);
    }
  } catch (error) {
    console.warn(`Warning: Could not remove PID file: ${error.message}`);
  }
}

/**
 * Read stored instance options (port, daemon, uiPassword)
 */
function readInstanceOptions(instanceFilePath) {
  try {
    const content = fs.readFileSync(instanceFilePath, 'utf8');
    return JSON.parse(content);
  } catch (error) {
    return null;
  }
}

/**
 * Write instance options for restart/update to reuse
 */
function writeInstanceOptions(instanceFilePath, options) {
  try {
    // Only store non-sensitive restart-relevant options
    const toStore = {
      port: options.port,
      daemon: options.daemon || false,
      // Store password existence but not value - will use env var
      hasUiPassword: typeof options.uiPassword === 'string',
    };
    // For daemon mode, we need to store the password to restart properly
    if (options.daemon && typeof options.uiPassword === 'string') {
      toStore.uiPassword = options.uiPassword;
    }
    fs.writeFileSync(instanceFilePath, JSON.stringify(toStore, null, 2));
  } catch (error) {
    console.warn(`Warning: Could not write instance file: ${error.message}`);
  }
}

function removeInstanceFile(instanceFilePath) {
  try {
    if (fs.existsSync(instanceFilePath)) {
      fs.unlinkSync(instanceFilePath);
    }
  } catch (error) {
    // Ignore
  }
}

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return false;
  }
}

async function requestServerShutdown(port) {
  if (!Number.isFinite(port) || port <= 0) return false;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/api/system/shutdown`, {
      method: 'POST',
      signal: controller.signal,
    });
    return resp.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

const commands = {
  async serve(options) {
    options.port = await resolveAvailablePort(options.port);

    const portWasSpecified = process.argv.includes('--port') || process.argv.includes('-p');

    // When using dynamic port (port=0), don't use pid/instance files - the port is
    // unknown until the server binds.
    if (options.port !== 0) {
      const pidFilePath = await getPidFilePath(options.port);
      const instanceFilePath = await getInstanceFilePath(options.port);

      const existingPid = readPidFile(pidFilePath);
      if (existingPid && isProcessRunning(existingPid)) {
        console.error(`Error: OpenChamber is already running on port ${options.port} (PID: ${existingPid})`);
        console.error('Use "openchamber stop" to stop the existing instance');
        process.exit(1);
      }

      // Persist for restart/update to reuse the chosen port.
      writeInstanceOptions(instanceFilePath, { ...options });
    } else if (portWasSpecified) {
      // Explicitly requested port=0; nothing to persist.
    }

    const opencodeBinary = await checkOpenCodeCLI();

    const serverPath = path.join(__dirname, '..', 'server', 'index.js');

    let effectiveUiPassword = options.uiPassword;
    let showAutoGeneratedPassword = false;

    if (options.tryCfTunnel && typeof effectiveUiPassword !== 'string') {
      effectiveUiPassword = generateRandomPassword(16);
      showAutoGeneratedPassword = true;
    }

    const serverArgs = [serverPath, '--port', options.port.toString()];
    if (typeof effectiveUiPassword === 'string') {
      serverArgs.push('--ui-password', effectiveUiPassword);
    }
    if (options.tryCfTunnel) {
      serverArgs.push('--try-cf-tunnel');
    }

    const preferredRuntime = getPreferredServerRuntime();
    const runtimeBin = preferredRuntime === 'bun' ? BUN_BIN : process.execPath;

    if (options.daemon) {
      const child = spawn(runtimeBin, serverArgs, {
        detached: true,
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        env: {
          ...process.env,
          OPENCHAMBER_PORT: options.port.toString(),
          OPENCODE_BINARY: opencodeBinary,
          ...(typeof effectiveUiPassword === 'string' ? { OPENCHAMBER_UI_PASSWORD: effectiveUiPassword } : {}),
          OPENCHAMBER_TRY_CF_TUNNEL: options.tryCfTunnel ? 'true' : 'false',
          ...(process.env.OPENCODE_SKIP_START ? { OPENCHAMBER_SKIP_OPENCODE_START: process.env.OPENCODE_SKIP_START } : {}),
        }
      });

      child.unref();

      const resolvedPort = await new Promise((resolve) => {
        let settled = false;
        const timeout = setTimeout(() => {
          if (settled) return;
          settled = true;
          resolve(options.port);
        }, 5000);

        child.on('message', (msg) => {
          if (settled) return;
          if (msg && msg.type === 'openchamber:ready' && typeof msg.port === 'number') {
            settled = true;
            clearTimeout(timeout);
            resolve(msg.port);
          }
        });

        child.on('exit', () => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          resolve(options.port);
        });
      });

      // Important: in daemon mode we must close the IPC channel, otherwise the CLI
      // process can hang around as the parent of the detached server.
      try {
        child.removeAllListeners('message');
        child.removeAllListeners('exit');
        if (typeof child.disconnect === 'function' && child.connected) {
          child.disconnect();
        }
      } catch {
        // ignore
      }

      if (isProcessRunning(child.pid)) {
        const pidFilePathResolved = await getPidFilePath(resolvedPort);
        const instanceFilePathResolved = await getInstanceFilePath(resolvedPort);

        writePidFile(pidFilePathResolved, child.pid);
        writeInstanceOptions(instanceFilePathResolved, { ...options, port: resolvedPort, uiPassword: effectiveUiPassword });

        console.log(`OpenChamber started in daemon mode on port ${resolvedPort}`);
        console.log(`PID: ${child.pid}`);
        console.log(`Visit: http://localhost:${resolvedPort}`);
        if (showAutoGeneratedPassword) {
          console.log(`\n🔐 Auto-generated password: \x1b[92m${effectiveUiPassword}\x1b[0m`);
          console.log('⚠️  Save this password - it won\'t be shown again!\n');
        }
      } else {
        console.error('Failed to start server in daemon mode');
        process.exit(1);
      }

      return;
    }

    process.env.OPENCODE_BINARY = opencodeBinary;
    if (typeof effectiveUiPassword === 'string') {
      process.env.OPENCHAMBER_UI_PASSWORD = effectiveUiPassword;
    }
    if (process.env.OPENCODE_SKIP_START) {
      process.env.OPENCHAMBER_SKIP_OPENCODE_START = process.env.OPENCODE_SKIP_START;
    }
    if (showAutoGeneratedPassword) {
      console.log(`\n🔐 Auto-generated password: \x1b[92m${effectiveUiPassword}\x1b[0m`);
      console.log('⚠️  Save this password - it won\'t be shown again!\n');
    }

    // Prefer bun when installed (much faster PTY). If CLI is running under Node,
    // run the server in a child process so Node doesn't have to load bun-pty.
    if (preferredRuntime === 'bun' && !isBunRuntime()) {
      const child = spawn(runtimeBin, serverArgs, {
        stdio: 'inherit',
        env: {
          ...process.env,
          OPENCHAMBER_PORT: options.port.toString(),
          OPENCODE_BINARY: opencodeBinary,
          ...(typeof effectiveUiPassword === 'string' ? { OPENCHAMBER_UI_PASSWORD: effectiveUiPassword } : {}),
          OPENCHAMBER_TRY_CF_TUNNEL: options.tryCfTunnel ? 'true' : 'false',
          ...(process.env.OPENCODE_SKIP_START ? { OPENCHAMBER_SKIP_OPENCODE_START: process.env.OPENCODE_SKIP_START } : {}),
        },
      });

      child.on('exit', (code) => {
        process.exit(typeof code === 'number' ? code : 1);
      });

      return;
    }

    const { startWebUiServer } = await importFromFilePath(serverPath);
    await startWebUiServer({
      port: options.port,
      attachSignals: true,
      exitOnShutdown: true,
      uiPassword: typeof effectiveUiPassword === 'string' ? effectiveUiPassword : null,
      tryCfTunnel: options.tryCfTunnel,
      onTunnelReady: async (url) => {
        const displayUrl = buildTunnelUrl(url, effectiveUiPassword, options.tunnelPasswordUrl);
        console.log(`\n🌐 Tunnel URL: \x1b[36m${displayUrl}\x1b[0m\n`);
        if (options.tunnelPasswordUrl && effectiveUiPassword) {
          console.log('🔑 Password is embedded in URL for auto-login\n');
        }
        if (options.tunnelQr) {
          await displayTunnelQrCode(displayUrl);
        }
      },
    });
  },

  async stop(options) {
    const os = await import('os');
    const tmpDir = os.tmpdir();

    let runningInstances = [];

    try {
      const files = fs.readdirSync(tmpDir);
      const pidFiles = files.filter(file => file.startsWith('openchamber-') && file.endsWith('.pid'));

      for (const file of pidFiles) {
        const port = parseInt(file.replace('openchamber-', '').replace('.pid', ''));
        if (!isNaN(port)) {
          const pidFilePath = path.join(tmpDir, file);
          const pid = readPidFile(pidFilePath);

          if (pid && isProcessRunning(pid)) {
            const instanceFilePath = path.join(tmpDir, `openchamber-${port}.json`);
            runningInstances.push({ port, pid, pidFilePath, instanceFilePath });
          } else {

            removePidFile(pidFilePath);
            removeInstanceFile(path.join(tmpDir, `openchamber-${port}.json`));
          }
        }
      }
    } catch (error) {

    }

    if (runningInstances.length === 0) {
      console.log('No running OpenChamber instances found');
      return;
    }

    const portWasSpecified = process.argv.includes('--port') || process.argv.includes('-p');

    if (portWasSpecified) {
      const targetInstance = runningInstances.find(inst => inst.port === options.port);

      if (!targetInstance) {
        console.log(`No OpenChamber instance found running on port ${options.port}`);
        return;
      }

      console.log(`Stopping OpenChamber (PID: ${targetInstance.pid}, Port: ${targetInstance.port})...`);

      try {
        await requestServerShutdown(targetInstance.port);
        process.kill(targetInstance.pid, 'SIGTERM');

        let attempts = 0;
        const maxAttempts = 10;

        const checkShutdown = setInterval(() => {
          attempts++;
          if (!isProcessRunning(targetInstance.pid)) {
            clearInterval(checkShutdown);
            removePidFile(targetInstance.pidFilePath);
            removeInstanceFile(targetInstance.instanceFilePath);
            console.log('OpenChamber stopped successfully');
          } else if (attempts >= maxAttempts) {
            clearInterval(checkShutdown);
            console.log('Force killing process...');
            process.kill(targetInstance.pid, 'SIGKILL');
            removePidFile(targetInstance.pidFilePath);
            removeInstanceFile(targetInstance.instanceFilePath);
            console.log('OpenChamber force stopped');
          }
        }, 500);

      } catch (error) {
        console.error(`Error stopping process: ${error.message}`);
        process.exit(1);
      }
    } else {

      console.log(`Stopping all OpenChamber instances (${runningInstances.length} found)...`);

      for (const instance of runningInstances) {
        console.log(`  Stopping instance on port ${instance.port} (PID: ${instance.pid})...`);

        try {
          await requestServerShutdown(instance.port);
          process.kill(instance.pid, 'SIGTERM');

          let attempts = 0;
          const maxAttempts = 10;

          await new Promise((resolve) => {
            const checkShutdown = setInterval(() => {
              attempts++;
              if (!isProcessRunning(instance.pid)) {
                clearInterval(checkShutdown);
                removePidFile(instance.pidFilePath);
                removeInstanceFile(instance.instanceFilePath);
                console.log(`    Port ${instance.port} stopped successfully`);
                resolve(true);
              } else if (attempts >= maxAttempts) {
                clearInterval(checkShutdown);
                console.log(`    Force killing port ${instance.port}...`);
                try {
                  process.kill(instance.pid, 'SIGKILL');
                  removePidFile(instance.pidFilePath);
                  removeInstanceFile(instance.instanceFilePath);
                  console.log(`    Port ${instance.port} force stopped`);
                } catch (e) {

                }
                resolve(true);
              }
            }, 500);
          });

        } catch (error) {
          console.error(`    Error stopping port ${instance.port}: ${error.message}`);
        }
      }

      console.log('\nAll OpenChamber instances stopped');
    }
  },

  async restart(options) {
    const os = await import('os');
    const tmpDir = os.tmpdir();

    // Find running instances to get their stored options
    let instancesToRestart = [];

    try {
      const files = fs.readdirSync(tmpDir);
      const pidFiles = files.filter(file => file.startsWith('openchamber-') && file.endsWith('.pid'));

      for (const file of pidFiles) {
        const port = parseInt(file.replace('openchamber-', '').replace('.pid', ''));
        if (!isNaN(port)) {
          const pidFilePath = path.join(tmpDir, file);
          const instanceFilePath = path.join(tmpDir, `openchamber-${port}.json`);
          const pid = readPidFile(pidFilePath);

          if (pid && isProcessRunning(pid)) {
            const storedOptions = readInstanceOptions(instanceFilePath);
            instancesToRestart.push({
              port,
              pid,
              pidFilePath,
              instanceFilePath,
              storedOptions: storedOptions || { port, daemon: false },
            });
          }
        }
      }
    } catch (error) {
      // Ignore
    }

    const portWasSpecified = process.argv.includes('--port') || process.argv.includes('-p');

    if (instancesToRestart.length === 0) {
      console.log('No running OpenChamber instances to restart');
      console.log('Use "openchamber serve" to start a new instance');
      return;
    }

    if (portWasSpecified) {
      // Restart specific instance
      const target = instancesToRestart.find(inst => inst.port === options.port);
      if (!target) {
        console.log(`No OpenChamber instance found running on port ${options.port}`);
        return;
      }
      instancesToRestart = [target];
    }

    for (const instance of instancesToRestart) {
      console.log(`Restarting OpenChamber on port ${instance.port}...`);

      // Merge stored options with any explicitly provided options
      const restartOptions = {
        ...instance.storedOptions,
        // CLI-provided options override stored ones
        ...(portWasSpecified ? { port: options.port } : {}),
        ...(process.argv.includes('--daemon') || process.argv.includes('-d') ? { daemon: options.daemon } : {}),
        ...(process.argv.includes('--ui-password') ? { uiPassword: options.uiPassword } : {}),
      };

      // Stop the instance
      try {
        await requestServerShutdown(instance.port);
        process.kill(instance.pid, 'SIGTERM');
        // Wait for it to stop
        let attempts = 0;
        while (isProcessRunning(instance.pid) && attempts < 20) {
          await new Promise(resolve => setTimeout(resolve, 250));
          attempts++;
        }
        if (isProcessRunning(instance.pid)) {
          process.kill(instance.pid, 'SIGKILL');
        }
        removePidFile(instance.pidFilePath);
      } catch (error) {
        console.warn(`Warning: Could not stop instance: ${error.message}`);
      }

      // Small delay before restart
      await new Promise(resolve => setTimeout(resolve, 500));

      // Start with merged options
      await commands.serve(restartOptions);
    }
  },

  async status() {
    const os = await import('os');
    const tmpDir = os.tmpdir();

    let runningInstances = [];
    let stoppedInstances = [];

    try {
      const files = fs.readdirSync(tmpDir);
      const pidFiles = files.filter(file => file.startsWith('openchamber-') && file.endsWith('.pid'));

      for (const file of pidFiles) {
        const port = parseInt(file.replace('openchamber-', '').replace('.pid', ''));
        if (!isNaN(port)) {
          const pidFilePath = path.join(tmpDir, file);
          const pid = readPidFile(pidFilePath);

          if (pid && isProcessRunning(pid)) {
            runningInstances.push({ port, pid, pidFilePath });
          } else {

            removePidFile(pidFilePath);
            stoppedInstances.push({ port });
          }
        }
      }
    } catch (error) {

    }

    if (runningInstances.length === 0) {
      console.log('OpenChamber Status:');
      console.log('  Status: Stopped');
      if (stoppedInstances.length > 0) {
        console.log(`  Previously used ports: ${stoppedInstances.map(s => s.port).join(', ')}`);
      }
      return;
    }

    console.log('OpenChamber Status:');
    for (const [index, instance] of runningInstances.entries()) {
      if (runningInstances.length > 1) {
        console.log(`\nInstance ${index + 1}:`);
      }
      console.log('  Status: Running');
      console.log(`  PID: ${instance.pid}`);
      console.log(`  Port: ${instance.port}`);
      console.log(`  Visit: http://localhost:${instance.port}`);

      try {
        const { execSync } = await import('child_process');
        const startTime = execSync(`ps -o lstart= -p ${instance.pid}`, { encoding: 'utf8' }).trim();
        console.log(`  Start Time: ${startTime}`);
      } catch (error) {

      }
    }
  },

  async update() {
    const os = await import('os');
    const tmpDir = os.tmpdir();
    const packageManagerPath = path.join(__dirname, '..', 'server', 'lib', 'package-manager.js');
    const {
      checkForUpdates,
      executeUpdate,
      detectPackageManager,
      getCurrentVersion,
    } = await importFromFilePath(packageManagerPath);

    // Check for running instances before update
    let runningInstances = [];
    try {
      const files = fs.readdirSync(tmpDir);
      const pidFiles = files.filter(file => file.startsWith('openchamber-') && file.endsWith('.pid'));

      for (const file of pidFiles) {
        const port = parseInt(file.replace('openchamber-', '').replace('.pid', ''));
        if (!isNaN(port)) {
          const pidFilePath = path.join(tmpDir, file);
          const instanceFilePath = path.join(tmpDir, `openchamber-${port}.json`);
          const pid = readPidFile(pidFilePath);

          if (pid && isProcessRunning(pid)) {
            const storedOptions = readInstanceOptions(instanceFilePath);
            runningInstances.push({
              port,
              pid,
              pidFilePath,
              instanceFilePath,
              storedOptions: storedOptions || { port, daemon: true },
            });
          }
        }
      }
    } catch (error) {
      // Ignore
    }

    console.log('Checking for updates...');
    console.log(`Current version: ${getCurrentVersion()}`);

    const updateInfo = await checkForUpdates();

    if (updateInfo.error) {
      console.error(`Error: ${updateInfo.error}`);
      process.exit(1);
    }

    if (!updateInfo.available) {
      console.log('\nYou are running the latest version.');
      return;
    }

    console.log(`\nNew version available: ${updateInfo.version}`);

    if (updateInfo.body) {
      console.log('\nChangelog:');
      console.log('─'.repeat(40));
      // Simple formatting for CLI
      const formatted = updateInfo.body
        .replace(/^## \[(\d+\.\d+\.\d+)\] - \d{4}-\d{2}-\d{2}/gm, '\nv$1')
        .replace(/^### /gm, '\n')
        .replace(/^- /gm, '  • ');
      console.log(formatted);
      console.log('─'.repeat(40));
    }

    // Stop running instances before update
    if (runningInstances.length > 0) {
      console.log(`\nStopping ${runningInstances.length} running instance(s) before update...`);
      for (const instance of runningInstances) {
        try {
          await requestServerShutdown(instance.port);
          process.kill(instance.pid, 'SIGTERM');
          let attempts = 0;
          while (isProcessRunning(instance.pid) && attempts < 20) {
            await new Promise(resolve => setTimeout(resolve, 250));
            attempts++;
          }
          if (isProcessRunning(instance.pid)) {
            process.kill(instance.pid, 'SIGKILL');
          }
          removePidFile(instance.pidFilePath);
          console.log(`  Stopped instance on port ${instance.port}`);
        } catch (error) {
          console.warn(`  Warning: Could not stop instance on port ${instance.port}`);
        }
      }
    }

    const pm = detectPackageManager();
    console.log(`\nDetected package manager: ${pm}`);
    console.log('Installing update...\n');

    const result = executeUpdate(pm);

    if (result.success) {
      console.log('\nUpdate successful!');

      // Restart previously running instances
      if (runningInstances.length > 0) {
        console.log(`\nRestarting ${runningInstances.length} instance(s)...`);
        for (const instance of runningInstances) {
          try {
            // Force daemon mode for restart after update
            const restartOptions = {
              ...instance.storedOptions,
              daemon: true,
            };
            await commands.serve(restartOptions);
            console.log(`  Restarted instance on port ${instance.port}`);
          } catch (error) {
            console.error(`  Failed to restart instance on port ${instance.port}: ${error.message}`);
            console.log(`  Run manually: openchamber serve --port ${instance.port} --daemon`);
          }
        }
      }
    } else {
      console.error('\nUpdate failed.');
      console.error(`Exit code: ${result.exitCode}`);
      process.exit(1);
    }
  },

};

async function main() {
  const { command, options } = parseArgs();

  if (!commands[command]) {
    console.error(`Error: Unknown command '${command}'`);
    console.error('Use --help to see available commands');
    process.exit(1);
  }

  try {
    await commands[command](options);
  } catch (error) {
    console.error(`Error executing command '${command}': ${error.message}`);
    process.exit(1);
  }
}

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  process.exit(1);
});

main();

export { commands, parseArgs, getPidFilePath };
