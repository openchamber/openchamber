import fs from 'fs';
import { pathToFileURL } from 'url';
import { spawn } from 'child_process';
import { EXIT_CODE, TunnelCliError } from './cli-errors.js';
import { buildLocalUrl, resolveServeHost, assertSafeBrowserPort, resolveServeUiPassword, assertAuthenticatedNetworkExposure } from './cli-network.js';
import { fetchSystemInfoFromPort } from './cli-http.js';
import { isPortAvailable, resolveAvailablePort } from './cli-ports.js';
import { ensureLogsDir, getLogFilePath } from './cli-paths.js';
import { rotateLogFile } from './cli-log-files.js';
import { discoverOpenChamberInstanceOnPort, isDesktopRuntimeForPort } from './cli-lifecycle.js';
import { getPidFilePath, getInstanceFilePath, readInstanceOptions, writePidFile, writeInstanceOptions, removePidFile, isProcessRunning, terminateProcessTree } from './cli-process.js';
import { isNetworkExposedBindHost } from '../../server/lib/security/bind-host.js';
import { createOwnerInstanceId, normalizeOwnerInstanceId } from '../../server/lib/guardian/owner-identity.js';
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

import { maybeAutoStartGuardian } from './commands-guardian.js';

const DAEMON_READY_TIMEOUT_MS = 30000;

const resolveGuardianOwnerInstanceId = (options = {}) => {
  const configured = normalizeOwnerInstanceId(
    options.guardianOwnerInstanceId || process.env.OPENCHAMBER_GUARDIAN_OWNER_ID,
  );
  return configured || createOwnerInstanceId();
};

function createServeCommand({
  serverPath,
  bunBin,
  checkOpenCodeCLI,
  getPreferredServerRuntime,
  setForegroundServerActive,
  setForegroundShutdown,
}) {
async function serveCommand(options) {
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
    const storedOwnerInstanceId = targetPort > 0
      ? readInstanceOptions(await getInstanceFilePath(targetPort))?.guardianOwnerInstanceId
      : undefined;
    const guardianOwnerInstanceId = resolveGuardianOwnerInstanceId({
      ...options,
      guardianOwnerInstanceId: options.guardianOwnerInstanceId || storedOwnerInstanceId,
    });

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

    // Resolve the effective UI password before either launch path so a
    // password generated for `--ui-password` (no value) is set in the
    // daemon/foreground environment before spawning and persisted in the
    // instance state file the server and restart/status flows read.
    const resolvedUiPassword = resolveServeUiPassword(options);
    const effectiveUiPassword = resolvedUiPassword.password;
    const autoGeneratedUiPassword = resolvedUiPassword.generated === true;
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
      process.env.OPENCHAMBER_GUARDIAN_OWNER_ID = guardianOwnerInstanceId;
      // Default-true opt-out: when handoff is disabled, the server's
      // restartOpenCode() must skip the guardian handoff branch and use the
      // legacy restart path. Only override the env var when explicitly
      // disabled so unrelated process.env values are preserved.
      if (options.handoff === false) {
        process.env.OPENCHAMBER_RESTART_HANDOFF = 'disabled';
      }

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

      // The log fd is closed in human (non-quiet) mode above. Re-open a fresh
      // fd against the same path so maybeAutoStartGuardian → startGuardianDetached
      // can hand the child a real descriptor; in quiet mode the original logFd
      // is still open and we keep using it.
      const guardianLogFd = isQuietMode(options) ? logFd : fs.openSync(initialLogPath, 'a');
      try {
        await maybeAutoStartGuardian({ logFd: guardianLogFd, options, emitNotice });
      } finally {
        if (!isQuietMode(options)) {
          try { fs.closeSync(guardianLogFd); } catch { /* ignore */ }
        }
      }
      const { startWebUiServer } = await import(pathToFileURL(serverPath).href);
      let controller;
      try {
        controller = await startWebUiServer({
          port: targetPort,
          host: effectiveHost,
          uiPassword: effectiveUiPassword,
          apiOnly: options.apiOnly === true,
          attachSignals: false,
          exitOnShutdown: false,
        });
      } catch (startError) {
        // The guardian intentionally outlives the web server. A failed web
        // startup must not tear down an operator-owned or already-running
        // guardian; the next serve attempt can reuse the singleton.
        throw startError;
      }

      const resolvedPort = controller.getPort();

      // Write PID / instance files so status, stop, and restart can discover
      // this foreground instance the same way they discover daemon instances.
      const fgPidFilePath = await getPidFilePath(resolvedPort);
      const fgInstanceFilePath = await getInstanceFilePath(resolvedPort);
      writePidFile(fgPidFilePath, process.pid, emitNotice);
      const foregroundInstanceOptions = {
        port: resolvedPort,
        host: effectiveHost,
        launchMode: 'foreground',
        uiPassword: effectiveUiPassword,
        apiOnly: options.apiOnly === true,
        guardianOwnerInstanceId,
        startedAt: Date.now(),
      };
      writeInstanceOptions(fgInstanceFilePath, foregroundInstanceOptions, emitNotice);

      if (isQuietMode(options)) {
        if (!options.suppressQuietOutput) {
          realStdoutWrite(
            autoGeneratedUiPassword
              ? `${resolvedPort} pass:${effectiveUiPassword}\n`
              : `${resolvedPort}\n`
          );
        }
      } else if (autoGeneratedUiPassword && showOutput && !options.suppressStartupSummary) {
        console.log(`Generated UI password: ${effectiveUiPassword}`);
        console.log('Save this password — it is not shown again.');
      }

      // Remove the liveness marker on exit but retain an owner-only instance
      // record. A foreground service manager may restart this command without
      // going through `openchamber restart`; the next serve must still reuse
      // the same guardian owner identity. Explicit `openchamber stop` removes
      // the retained metadata after the process has exited.
      const cleanupFiles = () => {
        removePidFile(fgPidFilePath);
        writeInstanceOptions(fgInstanceFilePath, foregroundInstanceOptions, emitNotice);
      };

      process.on('exit', cleanupFiles);

      // Idempotent graceful shutdown with deterministic exit codes.
      let shutdownInProgress = false;
      const shutdownForegroundServer = async (signal = 'SIGTERM') => {
        if (shutdownInProgress) return;
        shutdownInProgress = true;
        try {
          await controller.stop({ exitProcess: false });
        } catch (error) {
          // A failed owner-scoped guardian stop leaves the web process and its
          // owner metadata authoritative for a retry. Do not remove the PID
          // marker or exit here, otherwise the next startup loses the stable
          // owner identity while the guardian child is still live.
          shutdownInProgress = false;
          console.error(
            'Foreground shutdown failed; preserving OpenChamber metadata for retry:',
            error?.message || error,
          );
          return false;
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

    await maybeAutoStartGuardian({ logFd, options, emitNotice });
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
        ...(options.handoff === false ? { OPENCHAMBER_RESTART_HANDOFF: 'disabled' } : {}),
        OPENCHAMBER_GUARDIAN_OWNER_ID: guardianOwnerInstanceId,
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
      uiPassword: effectiveUiPassword,
      apiOnly: options.apiOnly === true,
      guardianOwnerInstanceId,
    }, emitNotice);

    const serveResult = {
      port: resolvedPort,
      pid: child.pid,
      url: buildLocalUrl(resolvedPort, '/'),
      logs: `openchamber logs -p ${resolvedPort}`,
      launchMode: 'daemon',
    };

    if (isJsonMode(options)) {
      printJson({
        ...serveResult,
        messages: jsonMessages,
        ...(autoGeneratedUiPassword ? { password: effectiveUiPassword } : {}),
      });
      return resolvedPort;
    }

    if (isQuietMode(options)) {
      if (options.suppressQuietOutput) {
        return resolvedPort;
      }
      // A generated password is essential result data for scripts: include it
      // in the same compact `pass:` token form `openchamber status --quiet`
      // already emits. Configured passwords are never echoed.
      process.stdout.write(
        autoGeneratedUiPassword
          ? `${resolvedPort} pass:${effectiveUiPassword}\n`
          : `${resolvedPort}\n`
      );
      return resolvedPort;
    }

    serveSpin?.clear();

    if (!options.suppressStartupSummary && showOutput) {
      clackIntro('OpenChamber Started');
      logStatus('success', `port ${serveResult.port} (PID: ${serveResult.pid})`);
      if (autoGeneratedUiPassword) {
        logStatus('success', 'UI password', effectiveUiPassword);
        logStatus('warning', 'save this password', 'it is not shown again');
      }
      logStatus('info', `visit: ${serveResult.url}`);
      logStatus('info', `logs: ${serveResult.logs}`);
      clackOutro('daemon running');
    }

    return resolvedPort;
}

  return serveCommand;
}

export { createServeCommand };
