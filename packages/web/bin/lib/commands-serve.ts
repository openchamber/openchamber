import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { spawn } from 'child_process';
import { EXIT_CODE, TunnelCliError } from './cli-errors.js';
import { buildLocalUrl, resolveServeHost, assertSafeBrowserPort, resolveServeUiPassword, assertAuthenticatedNetworkExposure } from './cli-network.js';
import { fetchSystemInfoFromPort } from './cli-http.js';
import { isPortAvailable, resolveAvailablePort } from './cli-ports.js';
import { ensureLogsDir, getLogFilePath } from './cli-paths.js';
import { rotateLogFile } from './cli-log-files.js';
import { discoverOpenChamberInstanceOnPort, isDesktopRuntimeForPort } from './cli-lifecycle.js';
import { getPidFilePath, getInstanceFilePath, readPidFile, writePidFile, writeInstanceOptions, removePidFile, removeInstanceFile, isProcessRunning, terminateProcessTree } from './cli-process.js';
import { isNetworkExposedBindHost } from '../../server/lib/security/bind-host.js';
import { resolveInheritedListenFd } from '../../server/lib/server-frame/server-startup-runtime.js';
import {
  HANDOFF_PROTOCOL_VERSION,
  HANDOFF_READY_MESSAGE,
  SELF_HANDOFF_SIGNAL,
  isSelfHandoffEnabled,
  notifySystemdReady,
  takeHandoffPredecessor,
  waitUntilServing,
} from '../../server/lib/opencode/self-handoff.js';
import { assignInjectedEnv, injectedEnvKeys, withoutInjectedEnv } from '../../server/lib/injected-env.js';
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
import type { CliOptions } from './cli-args.js';
import type { CliNotice } from './cli-process.js';
import { isString } from '../../server/lib/shared/object-guards.js';
import { HandoffProbeAbort } from '../../server/lib/opencode/handoff-probe.js';

export interface ServeOptions extends Partial<Omit<CliOptions, 'port' | 'host' | 'uiPassword' | 'apiOnly'>> {
  port?: unknown;
  host?: unknown;
  uiPassword?: unknown;
  apiOnly?: boolean | undefined;
  suppressUnsafePortWarning?: boolean;
  suppressUiPasswordWarning?: boolean;
  suppressStartupSummary?: boolean;
  suppressQuietOutput?: boolean;
}

interface GeneratedPasswordResult {
  password?: string | undefined;
}

export interface ServeDependencies {
  serverPath: string;
  checkOpenCodeCLI: (onNotice: (notice: CliNotice) => void) => Promise<string | undefined>;
  getServerRuntimeBinary: () => string;
  setForegroundServerActive: (active: boolean) => void;
  setForegroundShutdown: (handler: ((signal?: string) => Promise<void>) | null) => void;
}

function hasReadyMessageFields(value: unknown): value is { type?: unknown; port?: unknown } {
  return Boolean(value);
}

function isReadyMessage(value: unknown): value is { type: 'openchamber:ready'; port: number } {
  return hasReadyMessageFields(value) && value.type === 'openchamber:ready' && typeof value.port === 'number';
}

function isNoticeObject(value: unknown): value is { message?: unknown } {
  return Boolean(value) && typeof value === 'object';
}

function isCliNotice(value: unknown): value is { message: string } {
  return isNoticeObject(value) && typeof value.message === 'string';
}

function isServePort(value: unknown): value is number {
  return Number.isFinite(value);
}

const DAEMON_READY_TIMEOUT_MS = 30000;

// This CLI's own install: the entry it runs from and the version its package.json
// declares. Written into the instance file so a later `openchamber handoff` can tell
// what is running and whether it speaks handoff protocol 2.
const readOwnInstallInfo = () => {
  try {
    const entry = fs.realpathSync(path.resolve(process.argv[1]));
    const pkg = JSON.parse(fs.readFileSync(path.resolve(path.dirname(entry), '..', 'package.json'), 'utf8'));
    if (pkg?.name !== '@openchamber/web' || !/^\d+\.\d+\.\d+/.test(pkg?.version ?? '')) return null;
    return { entry, version: pkg.version };
  } catch {
    return null;
  }
};

function createServeCommand({
  serverPath,
  checkOpenCodeCLI,
  getServerRuntimeBinary,
  setForegroundServerActive,
  setForegroundShutdown,
}: ServeDependencies) {
async function serveCommand(options: ServeOptions) {
    // A self-handoff successor is started with its predecessor's pid in the environment; take it before anything spawns.
    const handoffPredecessor = takeHandoffPredecessor(process.env);
    const ownInstall = readOwnInstallInfo();
    const instanceIdentity = ownInstall
      ? { version: ownInstall.version, entry: ownInstall.entry, handoffProtocol: HANDOFF_PROTOCOL_VERSION }
      : {};
    const showOutput = shouldRenderHumanOutput(options);
    const jsonMessages: { level: string; code: string | undefined; message: string }[] = [];
    const emitNotice = (notice: CliNotice) => {
      if (!isCliNotice(notice)) return;
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
    // Under socket activation the unit's listening socket is already bound to the port and this
    // process inherits it. Probing the port would find it busy, and refuse to start, so the probes
    // are skipped: the inherited socket is the claim on the port.
    const inheritsListener = resolveInheritedListenFd(process.env, process.pid) !== null;
    const explicitPort = options.explicitPort === true;
    const effectiveHost = resolveServeHost(isString(options.host) ? options.host : undefined);
    const targetPort = await resolveAvailablePort(isServePort(options.port) ? options.port : undefined, explicitPort || inheritsListener, emitNotice);

    if (targetPort !== 0 && !options.suppressUnsafePortWarning) {
      assertSafeBrowserPort(targetPort, { context: 'OpenChamber serve' });
    }

    if (targetPort !== 0 && !inheritsListener) {
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
    const runtimeBin = getServerRuntimeBinary();

    ensureLogsDir();
    const initialLogPort = targetPort === 0 ? 'auto' : String(targetPort);
    const initialLogPath = getLogFilePath(initialLogPort);
    rotateLogFile(initialLogPath);
    const logFd = fs.openSync(initialLogPath, 'a');

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
    if (options.foreground) {
      if (isJsonMode(options)) {
        throw new TunnelCliError(
          '--json is not supported with --foreground. Use --json with background (daemon) mode instead.',
          EXIT_CODE.USAGE_ERROR
        );
      }

      if (opencodeBinary) {
        process.env.OPENCODE_BINARY = opencodeBinary;
      }
      for (const key of injectedEnvKeys(process.env)) delete process.env[key];
      assignInjectedEnv(process.env, {
        OPENCHAMBER_UI_PASSWORD: effectiveUiPassword || undefined,
        OPENCHAMBER_HOST: effectiveHost,
        OPENCHAMBER_RUNTIME: 'web',
        // One rotation start: the server reads this once at boot and
        // deletes it, so nothing it spawns can rotate again.
        OPENCHAMBER_ROTATE_MANAGED_CREDENTIALS: options.rotateCredentials === true ? 'true' : undefined,
      });

      const suppressServerOutput = isQuietMode(options);
      const realStdoutWrite = process.stdout.write.bind(process.stdout);
      if (suppressServerOutput) {
        const logStream = fs.createWriteStream(null, { fd: logFd });
        process.stdout.write = (chunk, encoding?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
          return logStream.write(chunk, encoding, callback);
        };
        process.stderr.write = (chunk, encoding?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
          return logStream.write(chunk, encoding, callback);
        };
      } else {
        try {
          fs.closeSync(logFd);
        } catch {
          void 0;
        }
      }

      if (!isQuietMode(options)) {
        console.log(`Starting OpenChamber on port ${targetPort === 0 ? 'auto' : targetPort} (foreground)`);
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
          // The successor takes over its predecessor's instance folder (instance-dir.js).
          handoffPredecessor,
          // A probe successor proves itself to the predecessor before it listens.
          handoffProbe: options.handoffProbe === true,
        });
      } catch (error) {
        // The probe gate refused the takeover (or the predecessor did): the
        // predecessor keeps serving, and this process exits without having
        // listened or written pid files. The outcome names the reason.
        if (error instanceof HandoffProbeAbort) {
          console.error(`[handoff] takeover refused before listening: ${error.message}`);
          process.exit(1);
        }
        throw error;
      }

      const resolvedPort = controller.getPort();

      // A self-handoff successor reports ready only once it serves in this process. It writes its
      // pid files after that, so a successor that never gets there leaves its predecessor's files alone.
      if (handoffPredecessor !== null) {
        await waitUntilServing(() => controller.httpServer?.listening === true && (options.apiOnly === true || controller.isReady()));
      }

      const fgPidFilePath = await getPidFilePath(resolvedPort);
      const fgInstanceFilePath = await getInstanceFilePath(resolvedPort);
      writePidFile(fgPidFilePath, process.pid, emitNotice);
      writeInstanceOptions(fgInstanceFilePath, {
        port: resolvedPort,
        host: effectiveHost,
        launchMode: 'foreground',
        uiPassword: effectiveUiPassword,
        apiOnly: options.apiOnly === true,
        ...instanceIdentity,
      }, emitNotice);

      // systemd (NotifyAccess=all) moves the main pid here before the predecessor exits. Then the predecessor
      // is told it can stop: the IPC message is sent last, so the unit has already been told about this pid.
      if (handoffPredecessor !== null) {
        notifySystemdReady({ pid: process.pid });
        process.send?.({ type: HANDOFF_READY_MESSAGE, pid: process.pid });
      }

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

      // Clean up PID / instance files. Once a successor has written them they name the successor, and this
      // process must leave them for it.
      const cleanupFiles = () => {
        const owner = readPidFile(fgPidFilePath);
        if (owner !== null && owner !== process.pid) return;
        removePidFile(fgPidFilePath);
        removeInstanceFile(fgInstanceFilePath);
      };

      process.on('exit', cleanupFiles);

      // SIGURG starts a successor on this socket and exits once the successor serves. `openchamber handoff` sends it.
      if (isSelfHandoffEnabled(process.env)) {
        process.on(SELF_HANDOFF_SIGNAL, () => {
          void controller.handOff({ exitProcess: false }).then((result: { ok: boolean }) => {
            if (!result.ok) return;
            cleanupFiles();
            setForegroundServerActive(false);
            setForegroundShutdown(null);
            process.exit(0);
          });
        });
      }

      let shutdownInProgress = false;
      const shutdownForegroundServer = async (signal = 'SIGTERM') => {
        if (shutdownInProgress) return;
        shutdownInProgress = true;
        try {
          // SIGTERM is the supervisor's stop: OpenCode keeps running so the next start can adopt it.
          await controller.stop({ exitProcess: false, keepOpenCode: signal === 'SIGTERM' });
        } catch {
          void 0;
        }
        cleanupFiles();
        setForegroundServerActive(false);
        setForegroundShutdown(null);
        const exitCode = signal === 'SIGINT' ? 130 : signal === 'SIGQUIT' ? 131 : 143;
        process.exit(exitCode);
      };

      setForegroundShutdown(shutdownForegroundServer);
      setForegroundServerActive(true);

      process.on('SIGINT', () => { void shutdownForegroundServer('SIGINT'); });
      process.on('SIGTERM', () => { void shutdownForegroundServer('SIGTERM'); });
      process.on('SIGQUIT', () => { void shutdownForegroundServer('SIGQUIT'); });
      process.on('SIGHUP', () => {
        controller.reload().catch(<Failure>(error: Failure) => console.error('Reload failed:', error));
      });

      await new Promise(() => {});
    }

    const serverArgs = [serverPath, '--port', String(targetPort)];
    serverArgs.push('--host', effectiveHost);
    if (options.apiOnly === true) {
      serverArgs.push('--api-only');
    }

    const serveSpin = showOutput ? createSpinner(options) : null;

    const childBaseEnv = withoutInjectedEnv(process.env);
    if (opencodeBinary) {
      childBaseEnv.OPENCODE_BINARY = opencodeBinary;
    }

    const child = spawn(runtimeBin, serverArgs, {
      detached: true,
      windowsHide: true,
      stdio: ['ignore', logFd, logFd, 'ipc'],
      env: assignInjectedEnv(childBaseEnv, {
        OPENCHAMBER_PORT: String(targetPort),
        OPENCHAMBER_RUNTIME: 'web',
        OPENCHAMBER_HOST: effectiveHost,
        OPENCHAMBER_UI_PASSWORD: effectiveUiPassword || undefined,
        OPENCHAMBER_API_ONLY: options.apiOnly === true ? 'true' : undefined,
        OPENCHAMBER_SKIP_OPENCODE_START: process.env.OPENCODE_SKIP_START || undefined,
        OPENCHAMBER_ROTATE_MANAGED_CREDENTIALS: options.rotateCredentials === true ? 'true' : undefined,
      }),
    });

    child.unref();
    serveSpin?.start(`Starting OpenChamber on port ${targetPort === 0 ? 'auto' : targetPort}...`);

    let resolvedPort;
    try {
      resolvedPort = await new Promise<number>((resolve, reject) => {
        let settled = false;
        const timeout = setTimeout(() => {
          if (settled) return;
          settled = true;
          reject(new Error(`OpenChamber daemon did not report ready within ${DAEMON_READY_TIMEOUT_MS / 1000}s`));
        }, DAEMON_READY_TIMEOUT_MS);

        child.on('message', (msg) => {
          if (settled) return;
          if (isReadyMessage(msg)) {
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
      if (child.connected) {
        child.disconnect();
      }
    } catch {
      void 0;
    }

    try {
      fs.closeSync(logFd);
    } catch {
      void 0;
    }

    const resolvedLogPath = getLogFilePath(resolvedPort);
    if (initialLogPath !== resolvedLogPath && !fs.existsSync(resolvedLogPath)) {
      try {
        fs.renameSync(initialLogPath, resolvedLogPath);
      } catch {
        void 0;
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
      ...instanceIdentity,
    }, emitNotice);

    const serveResult = {
      port: resolvedPort,
      pid: child.pid,
      url: buildLocalUrl(resolvedPort, '/'),
      logs: `openchamber logs -p ${resolvedPort}`,
      launchMode: 'daemon',
    };

    if (isJsonMode(options)) {
      const output = {
        ...serveResult,
        messages: jsonMessages,
      };
      const passwordResult: GeneratedPasswordResult = {};
      if (autoGeneratedUiPassword) passwordResult.password = effectiveUiPassword;
      printJson({ ...output, ...passwordResult });
      return resolvedPort;
    }

    if (isQuietMode(options)) {
      if (options.suppressQuietOutput) {
        return resolvedPort;
      }
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
