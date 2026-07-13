import fs from 'fs';
import { pathToFileURL } from 'url';
import { spawn } from 'child_process';
import { EXIT_CODE, TunnelCliError } from './cli-errors.js';
import { buildLocalUrl, resolveServeHost, assertSafeBrowserPort, hasUiPasswordConfigured, assertAuthenticatedNetworkExposure } from './cli-network.js';
import { fetchSystemInfoFromPort } from './cli-http.js';
import { isPortAvailable, resolveAvailablePort } from './cli-ports.js';
import { ensureLogsDir, getDataDir, getLogFilePath } from './cli-paths.js';
import { rotateLogFile } from './cli-log-files.js';
import { discoverOpenChamberInstanceOnPort, isDesktopRuntimeForPort } from './cli-lifecycle.js';
import { getPidFilePath, getInstanceFilePath, writePidFile, writeInstanceOptions, removePidFile, removeInstanceFile, isProcessRunning, terminateProcessTree } from './cli-process.js';
import { isNetworkExposedBindHost } from '../../server/lib/security/bind-host.js';
import { readActiveUpdateMaintenance, shouldDeferStartForUpdate } from '../../server/lib/openchamber-update/maintenance.js';
import {
  intro as clackIntro,
  outro as clackOutro,
  isJsonMode,
  isQuietMode,
  shouldRenderHumanOutput,
  createSpinner,
  printJson,
  logStatus,
} from '../cli-output.js';

const DAEMON_READY_TIMEOUT_MS = 30000;

function createServeCommand({
  serverPath,
  bunBin,
  checkOpenCodeCLI,
  getPreferredServerRuntime,
  setForegroundServerActive,
  setForegroundShutdown,
}) {
async function serveCommand(options) {
    const activeUpdate = readActiveUpdateMaintenance({ openchamberDataDir: getDataDir() });
    if (shouldDeferStartForUpdate(activeUpdate, {
      transactionId: process.env.OPENCHAMBER_UPDATE_TRANSACTION_ID,
      foreground: options.foreground === true,
    })) {
      throw new TunnelCliError(
        `OpenChamber update ${activeUpdate.id} is still in progress; startup is deferred.`,
        EXIT_CODE.GENERAL_ERROR,
      );
    }
    const showOutput = shouldRenderHumanOutput(options);
    const jsonMessages = [];
    const emitNotice = (notice) => {
      if (!notice || typeof notice !== 'object' || typeof notice.message !== 'string') return;
      const level = notice.level === 'error' ? 'error' : (notice.level === 'warning' ? 'warning' : 'info');

      if (isJsonMode(options)) {
        jsonMessages.push({
          level,
          code: notice.code,
          message: notice.message,
        });
        return;
      }

      if (showOutput) {
        logStatus(level, notice.message);
        return;
      }

      if (!isQuietMode(options)) {
        const prefix = level === 'warning' ? 'Warning' : level === 'error' ? 'Error' : 'Info';
        const line = `${prefix}: ${notice.message}`;
        if (level === 'error') {
          console.error(line);
        } else {
          console.warn(line);
        }
      }
    };
    const explicitPort = options.explicitPort === true;
    const effectiveHost = resolveServeHost(options.host);
    const targetPort = await resolveAvailablePort(options.port, explicitPort, emitNotice);

    if (targetPort !== 0 && !options.suppressUnsafePortWarning) {
      assertSafeBrowserPort(targetPort, { context: 'OpenChamber serve' });
    }

    if (targetPort !== 0) {
      const existingInstance = await discoverOpenChamberInstanceOnPort(targetPort, { host: effectiveHost });
      if (existingInstance?.runtime === 'desktop') {
        throw new Error(
          `Port ${targetPort} is used by OpenChamber Desktop app. Choose another port or stop the desktop app.`
        );
      }
      if (existingInstance) {
        const pidSuffix = Number.isFinite(existingInstance.pid) ? ` (PID: ${existingInstance.pid})` : '';
        if (existingInstance.source === 'probe') {
          throw new Error(`OpenChamber is already running on port ${targetPort}. Use \`openchamber status\` or \`openchamber stop --port ${targetPort}\`.`);
        }
        throw new Error(`OpenChamber is already running on port ${targetPort}${pidSuffix}`);
      }

      if (explicitPort && !(await isPortAvailable(targetPort, effectiveHost))) {
        const systemInfo = await fetchSystemInfoFromPort(targetPort, globalThis.fetch, effectiveHost);
        if (isDesktopRuntimeForPort(systemInfo, targetPort)) {
          throw new Error(
            `Port ${targetPort} is used by OpenChamber Desktop app. Choose another port or stop the desktop app.`
          );
        }
        const systemInfoRuntimeMatchesPort = systemInfo?.runtime !== 'desktop' || isDesktopRuntimeForPort(systemInfo, targetPort);
        if (systemInfo?.runtime && systemInfoRuntimeMatchesPort) {
          throw new Error(`OpenChamber is already running on port ${targetPort}. Use \`openchamber status\` or \`openchamber stop --port ${targetPort}\`.`);
        }
        throw new Error(`Port ${targetPort} is already in use by another process.`);
      }
    }

    const opencodeBinary = await checkOpenCodeCLI(emitNotice);
    const preferredRuntime = getPreferredServerRuntime();
    const runtimeBin = preferredRuntime === 'bun' ? bunBin : process.execPath;

    ensureLogsDir();
    const initialLogPort = targetPort === 0 ? 'auto' : String(targetPort);
    const initialLogPath = getLogFilePath(initialLogPort);
    rotateLogFile(initialLogPath);
    const logFd = fs.openSync(initialLogPath, 'a');

    const effectiveUiPassword = hasUiPasswordConfigured(options.uiPassword) ? options.uiPassword : undefined;
    assertAuthenticatedNetworkExposure({
      host: effectiveHost,
      uiPassword: effectiveUiPassword,
    });
    if (!effectiveUiPassword && !options.suppressUiPasswordWarning) {
      const bindHost = effectiveHost;
      const networkExposed = isNetworkExposedBindHost(bindHost);
      const warningLine = 'OPENCHAMBER_UI_PASSWORD is not set';
      const warningDetail = networkExposed
        ? `server is bound to ${bindHost} and reachable on your network with no UI auth. `
          + 'Set --ui-password or OPENCHAMBER_UI_PASSWORD before exposing it over LAN.'
        : 'browser UI is unsecured. Use --ui-password or OPENCHAMBER_UI_PASSWORD.';
      if (showOutput) {
        logStatus('warning', warningLine, warningDetail);
      } else if (isJsonMode(options)) {
        emitNotice({
          level: 'warning',
          code: 'UI_PASSWORD_MISSING',
          message: `${warningLine}; ${warningDetail}`,
        });
      } else if (!isQuietMode(options)) {
        console.warn(`Warning: ${warningLine}; ${warningDetail}`);
      }
    }
    // Foreground mode: run server inline so the CLI process is the server process.
    // Required for process managers like systemd (Type=simple) that track the
    // direct child rather than a detached grandchild.
    // IMPORTANT: foreground MUST remain inline (in-process). Do not convert to
    // child-process orchestration — that causes shell job-control suspension.
    if (options.foreground) {
      if (isJsonMode(options)) {
        throw new TunnelCliError(
          '--json is not supported with --foreground. Use --json with background (daemon) mode instead.',
          EXIT_CODE.USAGE_ERROR
        );
      }

      // Propagate resolved values into env before importing the server module.
      if (opencodeBinary) {
        process.env.OPENCODE_BINARY = opencodeBinary;
      }
      if (effectiveUiPassword) {
        process.env.OPENCHAMBER_UI_PASSWORD = effectiveUiPassword;
      }
      process.env.OPENCHAMBER_HOST = effectiveHost;
      process.env.OPENCHAMBER_RUNTIME = 'web';

      // In --quiet mode, redirect stdout/stderr to the log file so that
      // server runtime output (console.log calls) does not pollute the
      // deterministic CLI output contract.  In plain human mode, close the
      // log fd and let output go to the inherited terminal as before.
      const suppressServerOutput = isQuietMode(options);
      // Keep a reference to the real stdout.write so CLI output (port, JSON)
      // can bypass the log-file redirect.
      const realStdoutWrite = process.stdout.write.bind(process.stdout);
      if (suppressServerOutput) {
        const logStream = fs.createWriteStream(null, { fd: logFd });
        process.stdout.write = (chunk, encoding, callback) => {
          return logStream.write(chunk, encoding, callback);
        };
        process.stderr.write = (chunk, encoding, callback) => {
          return logStream.write(chunk, encoding, callback);
        };
      } else {
        // Close the log fd – in foreground human mode stdout/stderr are
        // inherited from the parent (e.g. journald/terminal).
        try {
          fs.closeSync(logFd);
        } catch {
        }
      }

      if (!isQuietMode(options)) {
        console.log(`Starting OpenChamber on port ${targetPort === 0 ? 'auto' : targetPort} (foreground)`);
      }

      const { startWebUiServer } = await import(pathToFileURL(serverPath).href);
      const controller = await startWebUiServer({
        port: targetPort,
        host: effectiveHost,
        uiPassword: effectiveUiPassword,
        apiOnly: options.apiOnly === true,
        attachSignals: false,
        exitOnShutdown: false,
      });

      const resolvedPort = controller.getPort();

      // Write PID / instance files so status, stop, and restart can discover
      // this foreground instance the same way they discover daemon instances.
      const fgPidFilePath = await getPidFilePath(resolvedPort);
      const fgInstanceFilePath = await getInstanceFilePath(resolvedPort);
      writePidFile(fgPidFilePath, process.pid, emitNotice);
      writeInstanceOptions(fgInstanceFilePath, {
        port: resolvedPort,
        host: effectiveHost,
        launchMode: 'foreground',
        serviceManager: process.env.OPENCHAMBER_SERVICE_MANAGER,
        uiPassword: effectiveUiPassword,
        apiOnly: options.apiOnly === true,
      }, emitNotice);

      if (isQuietMode(options)) {
        if (!options.suppressQuietOutput) {
          realStdoutWrite(`${resolvedPort}\n`);
        }
      }

      // Clean up PID / instance files.
      const cleanupFiles = () => {
        removePidFile(fgPidFilePath);
        removeInstanceFile(fgInstanceFilePath);
      };

      process.on('exit', cleanupFiles);

      // Idempotent graceful shutdown with deterministic exit codes.
      let shutdownInProgress = false;
      const shutdownForegroundServer = async (signal = 'SIGTERM') => {
        if (shutdownInProgress) return;
        shutdownInProgress = true;
        try {
          await controller.stop({ exitProcess: false });
        } catch {
        }
        cleanupFiles();
        setForegroundServerActive(false);
        setForegroundShutdown(null);
        const exitCode = signal === 'SIGINT' ? 130 : signal === 'SIGQUIT' ? 131 : 143;
        process.exit(exitCode);
      };

      // Expose shutdown to the global SIGINT handler.
      setForegroundShutdown(shutdownForegroundServer);
      setForegroundServerActive(true);

      // Register signal handlers (additive, no removeAllListeners).
      process.on('SIGINT', () => { void shutdownForegroundServer('SIGINT'); });
      process.on('SIGTERM', () => { void shutdownForegroundServer('SIGTERM'); });
      process.on('SIGQUIT', () => { void shutdownForegroundServer('SIGQUIT'); });

      // Block forever – the process stays alive until signalled.
      await new Promise(() => {});
    }

    const serverArgs = [serverPath, '--port', String(targetPort)];
    serverArgs.push('--host', effectiveHost);
    if (options.apiOnly === true) {
      serverArgs.push('--api-only');
    }

    const serveSpin = showOutput ? createSpinner(options) : null;

    const child = spawn(runtimeBin, serverArgs, {
      detached: true,
      windowsHide: true,
      stdio: ['ignore', logFd, logFd, 'ipc'],
      env: {
        ...process.env,
        OPENCHAMBER_PORT: String(targetPort),
        OPENCHAMBER_RUNTIME: 'web',
        OPENCODE_BINARY: opencodeBinary,
        OPENCHAMBER_HOST: effectiveHost,
        ...(effectiveUiPassword ? { OPENCHAMBER_UI_PASSWORD: effectiveUiPassword } : {}),
        ...(options.apiOnly === true ? { OPENCHAMBER_API_ONLY: 'true' } : {}),
        ...(process.env.OPENCODE_SKIP_START ? { OPENCHAMBER_SKIP_OPENCODE_START: process.env.OPENCODE_SKIP_START } : {}),
      },
    });

    child.unref();
    serveSpin?.start(`Starting OpenChamber on port ${targetPort === 0 ? 'auto' : targetPort}...`);

    let resolvedPort;
    try {
      resolvedPort = await new Promise((resolve, reject) => {
        let settled = false;
        const timeout = setTimeout(() => {
          if (settled) return;
          settled = true;
          reject(new Error(`OpenChamber daemon did not report ready within ${DAEMON_READY_TIMEOUT_MS / 1000}s`));
        }, DAEMON_READY_TIMEOUT_MS);

        child.on('message', (msg) => {
          if (settled) return;
          if (msg && msg.type === 'openchamber:ready' && typeof msg.port === 'number') {
            settled = true;
            clearTimeout(timeout);
            resolve(msg.port);
          }
        });

        child.on('error', (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          reject(error);
        });

        child.on('exit', (code, signal) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          reject(new Error(`OpenChamber daemon exited before reporting ready${signal ? ` (${signal})` : ` (code ${code ?? 'unknown'})`}`));
        });
      });
    } catch (error) {
      await terminateProcessTree(child.pid, { gracefulTimeoutMs: 1500, forceTimeoutMs: 1500 });
      throw error;
    }

    try {
      if (typeof child.disconnect === 'function' && child.connected) {
        child.disconnect();
      }
    } catch {
    }

    try {
      fs.closeSync(logFd);
    } catch {
    }

    const resolvedLogPath = getLogFilePath(resolvedPort);
    if (initialLogPath !== resolvedLogPath && !fs.existsSync(resolvedLogPath)) {
      try {
        fs.renameSync(initialLogPath, resolvedLogPath);
      } catch {
      }
    }

    if (!isProcessRunning(child.pid)) {
      serveSpin?.error('Failed to start OpenChamber');
      throw new Error('Failed to start server in daemon mode');
    }

    const pidFilePath = await getPidFilePath(resolvedPort);
    const instanceFilePath = await getInstanceFilePath(resolvedPort);
    writePidFile(pidFilePath, child.pid, emitNotice);
    writeInstanceOptions(instanceFilePath, {
      port: resolvedPort,
      host: effectiveHost,
      launchMode: 'daemon',
      serviceManager: undefined,
      uiPassword: effectiveUiPassword,
      apiOnly: options.apiOnly === true,
    }, emitNotice);

    const serveResult = {
      port: resolvedPort,
      pid: child.pid,
      url: buildLocalUrl(resolvedPort, '/'),
      logs: `openchamber logs -p ${resolvedPort}`,
      launchMode: 'daemon',
    };

    if (isJsonMode(options)) {
      printJson({ ...serveResult, messages: jsonMessages });
      return resolvedPort;
    }

    if (isQuietMode(options)) {
      if (options.suppressQuietOutput) {
        return resolvedPort;
      }
      process.stdout.write(`${resolvedPort}\n`);
      return resolvedPort;
    }

    serveSpin?.clear();

    if (!options.suppressStartupSummary && showOutput) {
      clackIntro('OpenChamber Started');
      logStatus('success', `port ${serveResult.port} (PID: ${serveResult.pid})`);
      logStatus('info', `visit: ${serveResult.url}`);
      logStatus('info', `logs: ${serveResult.logs}`);
      clackOutro('daemon running');
    }

    return resolvedPort;
}

  return serveCommand;
}

export { createServeCommand };
