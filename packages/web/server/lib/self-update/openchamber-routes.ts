import { publicEnterprisePolicy } from '../enterprise-mode.js';
import { withUserEnv } from '../injected-env.js';
import { isOpenCodeOlderThan } from '../opencode/compatibility.js';
import { webPackagePaths } from '../web-package-paths.js';
import type { Application, QueryValue } from '../shared/http-contracts.js';
import type { JsonValue } from '../shared/json-values.js';
import type { UpdateCheckResult } from '../package-manager.js';
import type { DesktopUpdater } from '../../index.js';
import type { createNotificationTemplateRuntime } from '../notifications/template-runtime.js';
import { isString } from '../shared/object-guards.js';

export interface OpenChamberRouteDependencies {
  fs: typeof import('node:fs');
  os?: Pick<typeof import('node:os'), 'homedir'>;
  path: typeof import('node:path');
  process: Pick<NodeJS.Process, 'env' | 'platform' | 'execPath' | 'exit'> & Partial<Pick<NodeJS.Process, 'getuid'>>;
  server: Pick<import('node:http').Server, 'address' | 'close'>;
  cliEntry?: string;
  openchamberDataDir: string;
  modelsDevApiUrl: string;
  modelsMetadataCacheTtl: number;
  readSettingsFromDiskMigrated: ReturnType<typeof import('../settings/settings-runtime.js').createSettingsRuntime>['readSettingsFromDiskMigrated'];
  fetchFreeZenModels: ReturnType<typeof createNotificationTemplateRuntime>['fetchFreeZenModels'];
  getCachedZenModels: ReturnType<typeof createNotificationTemplateRuntime>['getCachedZenModels'];
  desktopUpdater?: DesktopUpdater | null | undefined;
  getOpenCodeCompatibility: () => Promise<{ version: string | null }>;
}

type RouteUpdateInfo = Omit<UpdateCheckResult, 'currentVersion' | 'body'> & {
  currentVersion?: UpdateCheckResult['currentVersion'];
  body?: string | null | undefined;
  updateOwner?: string;
  installBlocked?: string;
  requiredOpenCodeVersion?: string;
  openCodeVersion?: string;
};

type LaunchOptions = {
  port?: JsonValue;
  daemon?: JsonValue;
  launchMode?: JsonValue;
  host?: JsonValue;
  apiOnly?: JsonValue;
  uiPassword?: JsonValue;
};

const hasLaunchProperties = (value: JsonValue): value is LaunchOptions => value !== null;
const hasErrorName = (value: unknown): value is { name?: unknown } => value !== null && value !== undefined;

const SYSTEMD_SERVICE_UNIT_PATTERN = /^[A-Za-z0-9:_.@-]+\.service$/;

function resolveSystemdServiceUnit(environment: NodeJS.ProcessEnv) {
  if (!environment.INVOCATION_ID) {
    return null;
  }

  const configuredUnit = isString(environment.OPENCHAMBER_SYSTEMD_UNIT)
    ? environment.OPENCHAMBER_SYSTEMD_UNIT.trim()
    : '';
  const unit = configuredUnit || 'openchamber.service';
  return SYSTEMD_SERVICE_UNIT_PATTERN.test(unit) ? unit : null;
}

function quotePosixShell(value: string | null) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

const LAUNCHD_SERVICE_ID = 'dev.openchamber.web';
const INSTALL_TARGET_ENV = ['HOME', 'NPM_CONFIG_PREFIX', 'npm_config_prefix', 'BUN_INSTALL', 'PNPM_HOME'] as const;

const resolveLaunchdPlistPath = (pathModule: typeof import('node:path'), osModule: Pick<typeof import('node:os'), 'homedir'>) =>
  pathModule.join(osModule.homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_SERVICE_ID}.plist`);

const escapeBatchEchoLine = (line: string) => {
  if (!line) return 'echo.';
  return `echo ${line.replace(/%/g, '%%').replace(/[&|<>()^]/g, '^$&')}`;
};

const buildWindowsUpdateScript = ({ logPreamble, updateCmd, restartCmd }: { logPreamble: string; updateCmd: string; restartCmd: string }) => [
  '@echo off',
  ...logPreamble.split('\n').map(escapeBatchEchoLine),
  'ping -n 3 127.0.0.1 >nul',
  `call ${updateCmd.replace(/%/g, '%%')}`,
  'if %ERRORLEVEL% EQU 0 (',
  '  echo Update successful, restarting OpenChamber...',
  `  ${restartCmd ? restartCmd.replace(/%/g, '%%') : 'echo Service manager will restart OpenChamber.'}`,
  ') else (',
  '  echo Update failed',
  ')',
  'del "%~f0"',
  '',
].join('\r\n');

export const registerOpenChamberRoutes = (app: Application, dependencies: OpenChamberRouteDependencies) => {
  const {
    fs,
    os,
    path,
    process,
    server,
    cliEntry = webPackagePaths.cliEntry,
    openchamberDataDir,
    modelsDevApiUrl,
    modelsMetadataCacheTtl,
    readSettingsFromDiskMigrated: _readSettingsFromDiskMigrated,
    fetchFreeZenModels,
    getCachedZenModels,
    desktopUpdater,
    getOpenCodeCompatibility,
  } = dependencies;

  let desktopRestartError: string | null = null;

  const readOpenCodeShortfall = async (version: UpdateCheckResult['version']) => {
    const { fetchRequiredOpenCodeVersion } = await import('../package-manager.js');
    const requiredOpenCodeVersion = await fetchRequiredOpenCodeVersion(version);
    if (!requiredOpenCodeVersion) return null;
    const openCodeVersion = (await getOpenCodeCompatibility().catch(() => null))?.version ?? null;
    return openCodeVersion && isOpenCodeOlderThan(openCodeVersion, requiredOpenCodeVersion)
      ? { requiredOpenCodeVersion, openCodeVersion }
      : null;
  };

  const readLaunchState = async () => {
    const address = server.address();
    const currentPort = (address && !isString(address) ? address.port : undefined) || 3000;
    const instanceFilePath = path.join(openchamberDataDir, 'run', `openchamber-${currentPort}.json`);
    let storedOptions: JsonValue = { port: currentPort, daemon: true };
    try {
      const content = await fs.promises.readFile(instanceFilePath, 'utf8');
      storedOptions = JSON.parse(content);
    } catch {
      void 0;
    }
    if (!hasLaunchProperties(storedOptions)) throw new TypeError("Cannot read properties of null (reading 'launchMode')");
    const launchMode = storedOptions.launchMode === 'foreground' ? 'foreground' : 'daemon';
    const isForegroundService = launchMode === 'foreground';
    const isDarwin = process.platform === 'darwin';
    const systemdServiceUnit = isForegroundService && !isDarwin ? resolveSystemdServiceUnit(process.env) : null;
    const osModule = os || (await import('os'));
    const launchdPlistPath = isDarwin ? resolveLaunchdPlistPath(path, osModule) : null;
    const isLaunchdService = Boolean(
      isDarwin
      && isForegroundService
      && process.env?.XPC_SERVICE_NAME === LAUNCHD_SERVICE_ID
      && launchdPlistPath
      && fs.existsSync(launchdPlistPath),
    );
    return { storedOptions, launchMode, isForegroundService, systemdServiceUnit, isLaunchdService, launchdPlistPath };
  };

  app.get('/api/openchamber/enterprise-policy', (_req, res) => {
    res.json(publicEnterprisePolicy());
  });

  app.get('/api/openchamber/update-check', async (req, res) => {
    try {
      const parseString = (value: QueryValue | undefined) => (isString(value) && value.trim().length > 0 ? value.trim() : undefined);
      const parseReportUsage = (value: string | undefined) => {
        if (value === undefined) return true;
        const normalized = value.trim().toLowerCase();
        if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
        return true;
      };
      const inferDeviceClass = (ua: string) => {
        const value = (ua || '').toLowerCase();
        if (!value) return 'unknown';
        if (value.includes('ipad') || value.includes('tablet')) return 'tablet';
        if (value.includes('mobi') || value.includes('android') || value.includes('iphone')) return 'mobile';
        return 'desktop';
      };
      const userAgent = isString(req.headers['user-agent']) ? req.headers['user-agent'] : '';
      const updateRequest = {
        appType: parseString(req.query.appType),
        deviceClass: parseString(req.query.deviceClass) || inferDeviceClass(userAgent),
        platform: parseString(req.query.platform),
        arch: parseString(req.query.arch),
        instanceMode: parseString(req.query.instanceMode),
        currentVersion: parseString(req.query.currentVersion),
        installId: parseString(req.query.installId),
        reportUsage: parseReportUsage(parseString(req.query.reportUsage)),
      };
      let updateInfo: RouteUpdateInfo;
      if (process.env.OPENCHAMBER_RUNTIME === 'desktop' && updateRequest.appType === 'web') {
        if (desktopRestartError && req.query.updateStatus === 'true') {
          return res.status(503).json({
            code: 'DESKTOP_UPDATE_RESTART_FAILED',
            error: desktopRestartError,
          });
        }
        if (!desktopUpdater) {
          return res.status(503).json({
            available: false,
            code: 'DESKTOP_UPDATER_UNAVAILABLE',
            error: 'The desktop updater is not available.',
          });
        }
        updateInfo = {
          ...await desktopUpdater.check(),
          packageManager: 'electron',
          updateOwner: 'electron-updater',
        };
      } else {
        const { checkForUpdates, isUnmanagedInstall } = await import('../package-manager.js');
        updateInfo = await checkForUpdates(updateRequest);
        if (updateInfo?.available && updateRequest.appType === 'web') {
          const openCodeShortfall = await readOpenCodeShortfall(updateInfo.version);
          if (openCodeShortfall) {
            updateInfo = { ...updateInfo, installBlocked: 'opencode-version', ...openCodeShortfall };
          } else if (isUnmanagedInstall()) {
            updateInfo = { ...updateInfo, installBlocked: 'manual-install' };
          } else {
            const { isForegroundService, systemdServiceUnit, isLaunchdService } = await readLaunchState();
            if (isForegroundService && !systemdServiceUnit && !isLaunchdService) {
              updateInfo = { ...updateInfo, installBlocked: 'service-manager' };
            }
          }
        }
      }
      res.json(updateInfo);
    } catch (error) {
      console.error('Failed to check for updates:', error);
      res.status(500).json({
        available: false,
        error: error instanceof Error ? error.message : 'Failed to check for updates',
      });
    }
  });

  app.get('/api/openchamber/release-notes', async (req, res) => {
    const { fetchReleaseNotes, VERSION_PATTERN, CANARY_VERSION_PATTERN } = await import('../changelog/update-notes.js');
    const isVersion = (value: string) => VERSION_PATTERN.test(value) || CANARY_VERSION_PATTERN.test(value);
    const version = String(req.query.version ?? '');
    const since = req.query.since === undefined ? undefined : String(req.query.since);
    if (!isVersion(version) || (since !== undefined && !isVersion(since))) {
      return res.status(400).json({ error: 'version and since must be OpenChamber versions' });
    }
    const { compareVersions } = await import('../version-order.js');
    const releases = await fetchReleaseNotes(version, since, compareVersions);
    if (!releases) {
      return res.status(502).json({ error: 'Release notes are unavailable' });
    }
    res.json({ releases });
  });

  app.post('/api/openchamber/update-install', async (_req, res) => {
    try {
      if (process.env.OPENCHAMBER_RUNTIME === 'desktop') {
        if (!desktopUpdater) {
          return res.status(503).json({
            code: 'DESKTOP_UPDATER_UNAVAILABLE',
            error: 'The desktop updater is not available.',
          });
        }

        desktopRestartError = null;
        const updateInfo = await desktopUpdater.install();
        if (!updateInfo?.available) {
          return res.status(400).json({ error: 'No update available' });
        }
        if (updateInfo.installBlocked === 'desktop-host') {
          return res.status(409).json({
            code: 'DESKTOP_UPDATE_LOCAL_ONLY',
            error: 'Update OpenChamber on the computer it runs on.',
          });
        }

        res.json({
          success: true,
          message: 'Desktop update downloaded, host will restart shortly',
          version: updateInfo.version,
          packageManager: 'electron',
          updateOwner: 'electron-updater',
          autoRestart: true,
          restartManager: 'electron-updater',
        });

        setImmediate(() => {
          Promise.resolve()
            .then(() => desktopUpdater.restart())
            .catch((error) => {
              desktopRestartError = error instanceof Error ? error.message : 'Failed to restart after desktop update';
              console.error('Failed to restart after desktop update:', error);
            });
        });
        return;
      }

      const { spawn: spawnChild, spawnSync } = await import('child_process');
      const {
        checkForUpdates,
        getUpdateCommand,
        detectPackageManagerDetails,
        isUnmanagedInstall,
      } = await import('../package-manager.js');

      const updateInfo = await checkForUpdates();
      if (!updateInfo.available) {
        return res.status(400).json({ error: 'No update available' });
      }

      const openCodeShortfall = await readOpenCodeShortfall(updateInfo.version);
      if (openCodeShortfall) {
        return res.status(409).json({
          code: 'OPENCODE_TOO_OLD',
          error: `OpenChamber ${updateInfo.version} needs OpenCode ${openCodeShortfall.requiredOpenCodeVersion}. This server has ${openCodeShortfall.openCodeVersion}. Update OpenCode first.`,
          ...openCodeShortfall,
        });
      }

      if (isUnmanagedInstall()) {
        return res.status(409).json({
          error: 'This copy can\'t update itself. Install the new version the way you installed it.',
        });
      }

      const pmDetails = detectPackageManagerDetails();
      const pm = pmDetails.packageManager;
      const updateCmd = getUpdateCommand(pm, { targetVersion: updateInfo.version });
      const isContainer =
        fs.existsSync('/.dockerenv') ||
        Boolean(process.env.CONTAINER) ||
        process.env.container === 'docker';

      if (isContainer) {
        res.json({
          success: true,
          message: 'Update starting, server will stay online',
          version: updateInfo.version,
          packageManager: pm,
          autoRestart: false,
        });

        setTimeout(() => {
          console.log(`\nInstalling update using ${pm} (container mode)...`);
          console.log(`Running: ${updateCmd}`);

          const shell = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : 'sh';
          const shellFlag = process.platform === 'win32' ? '/c' : '-c';
          const child = spawnChild(shell, [shellFlag, updateCmd], {
            detached: true,
            stdio: 'ignore',
            env: process.env,
          });
          child.unref();
        }, 500);

        return;
      }

      const { storedOptions, launchMode, isForegroundService, systemdServiceUnit, isLaunchdService, launchdPlistPath } = await readLaunchState();

      if (isForegroundService) {
        if (!systemdServiceUnit && !isLaunchdService) {
          return res.status(409).json({
            error: 'Foreground servers must be updated by their service manager. Set OPENCHAMBER_SYSTEMD_UNIT when running under systemd, or run openchamber update and restart the service.',
          });
        }

        if (systemdServiceUnit) {
          const startedByUserManager = Boolean(process.env.MANAGERPID);
          const serverRunsAsRoot = process.getuid?.() === 0;
          if (!startedByUserManager && !serverRunsAsRoot) {
            return res.status(409).json({
              code: 'SYSTEM_UNIT_UPDATE_MANUAL',
              error: `OpenChamber runs as a system service (${systemdServiceUnit}) under a non-root user, so it can't update itself. Update the copy this service runs with the package manager and account that installed it, then run systemctl restart ${systemdServiceUnit}.`,
            });
          }
          const userManagerFlags = startedByUserManager ? ['--user'] : [];
          const updateJobName = `openchamber-update-${Date.now()}`;
          const updateLogPath = startedByUserManager
            ? `journalctl --user-unit ${updateJobName}.service`
            : `journalctl -u ${updateJobName}.service`;
          const updateScript = [
            'set -eu',
            updateCmd,
            ['systemctl', ...userManagerFlags, 'restart', quotePosixShell(systemdServiceUnit)].join(' '),
          ].join('\n');
          const systemdRun = spawnSync('systemd-run', [
            ...userManagerFlags,
            `--unit=${updateJobName}`,
            '--collect',
            '--service-type=exec',
            `--setenv=PATH=${process.env.PATH || ''}`,
            ...INSTALL_TARGET_ENV.filter((name) => process.env[name]).map((name) => `--setenv=${name}=${process.env[name]}`),
            '/bin/sh',
            '-c',
            updateScript,
          ], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: 5000,
          });

          if (systemdRun.status !== 0) {
            const detail = (systemdRun.stderr || systemdRun.stdout || '').trim();
            return res.status(409).json({
              error: detail || `Could not queue update job for ${systemdServiceUnit}`,
            });
          }

          return res.json({
            success: true,
            message: 'Update queued; OpenChamber will restart after installation completes',
            version: updateInfo.version,
            packageManager: pm,
            autoRestart: true,
            restartManager: 'systemd',
            jobId: updateJobName,
            logPath: updateLogPath,
          });
        }
      }

      const isWindows = process.platform === 'win32';
      const quotePosix = (value: string) => `'${String(value).replace(/'/g, "'\\''")}'`;
      const quoteCmd = (value: string) => {
        const stringValue = String(value);
        return `"${stringValue.replace(/"/g, '""')}"`;
      };

      let restartCmd = '';
      if (isLaunchdService) {
        const quotedPlistPath = quotePosixShell(launchdPlistPath);
        restartCmd = `launchctl kickstart -k gui/$(id -u)/${LAUNCHD_SERVICE_ID} || launchctl bootstrap gui/$(id -u) ${quotedPlistPath}`;
      } else {
        const cliPath = cliEntry;
        const restartParts = [
          isWindows ? quoteCmd(process.execPath) : quotePosix(process.execPath),
          isWindows ? quoteCmd(cliPath) : quotePosix(cliPath),
          'serve',
          '--port',
          String(storedOptions.port),
        ];
        let restartCmdPrimary = restartParts.join(' ');
        let restartCmdFallback = `openchamber serve --port ${storedOptions.port}`;
        if (storedOptions.host) {
          if (!isString(storedOptions.host)) throw new TypeError('storedOptions.host.replace is not a function');
          if (isWindows) {
            const escapedHost = storedOptions.host.replace(/"/g, '""');
            restartCmdPrimary += ` --host "${escapedHost}"`;
            restartCmdFallback += ` --host "${escapedHost}"`;
          } else {
            const escapedHost = storedOptions.host.replace(/'/g, "'\\''");
            restartCmdPrimary += ` --host '${escapedHost}'`;
            restartCmdFallback += ` --host '${escapedHost}'`;
          }
        }
        if (storedOptions.apiOnly === true) {
          restartCmdPrimary += ' --api-only';
          restartCmdFallback += ' --api-only';
        }
        restartCmd = `(${restartCmdPrimary}) || (${restartCmdFallback})`;
      }
      const updateLogPath = path.join(openchamberDataDir, 'update-install.log');
      const logPreamble = [
        '',
        `=== OpenChamber update ${new Date().toISOString()} ===`,
        `currentVersion=${updateInfo.currentVersion || 'unknown'}`,
        `targetVersion=${updateInfo.version || 'unknown'}`,
        `packageManager=${pm}`,
        `packageManagerReason=${pmDetails.reason || 'unknown'}`,
        `packageManagerCommand=${pmDetails.packageManagerCommand || 'unknown'}`,
        `packagePath=${pmDetails.packagePath || 'unknown'}`,
        `globalNodeModulesRoot=${pmDetails.globalNodeModulesRoot || 'unknown'}`,
        `mode=${isContainer ? 'container' : 'restart'}`,
        `launchMode=${launchMode}`,
        `updateCommand=${updateCmd}`,
        `restartCommand=${restartCmd || 'service-manager'}`,
        `logPath=${updateLogPath}`,
      ].join('\n');

      const shell = isWindows ? (process.env.ComSpec || 'cmd.exe') : 'sh';
      const shellFlag = isWindows ? '/c' : '-c';
      const windowsScriptPath = path.join(openchamberDataDir, 'update-install.cmd');
      if (isWindows) {
        try {
          fs.mkdirSync(path.dirname(windowsScriptPath), { recursive: true });
          fs.writeFileSync(windowsScriptPath, buildWindowsUpdateScript({ logPreamble, updateCmd, restartCmd }), 'utf8');
        } catch (scriptError) {
          console.error('Failed to write the update script, update not started:', scriptError);
          return res.status(500).json({
            error: `Could not write the update script at ${windowsScriptPath}: ${scriptError instanceof Error ? scriptError.message : String(scriptError)}`,
          });
        }
      }

      res.json({
        success: true,
        message: 'Update starting, server will restart shortly',
        version: updateInfo.version,
        packageManager: pm,
        autoRestart: true,
        restartManager: isForegroundService ? 'service' : 'cli',
      });

        setTimeout(() => {
          console.log(`\nInstalling update using ${pm}...`);
          console.log(`Running: ${updateCmd}`);
          console.log(logPreamble);

          const script = isWindows
            ? windowsScriptPath
          : `
            printf '%s\n' ${quotePosix(logPreamble)}
            sleep 2
            ${updateCmd}
            if [ $? -eq 0 ]; then
              echo "Update successful, restarting OpenChamber..."
              ${restartCmd || 'echo "Service manager will restart OpenChamber."'}
            else
              echo "Update failed"
              exit 1
            fi
          `;

        let logFd: number | null = null;
        try {
          fs.mkdirSync(path.dirname(updateLogPath), { recursive: true });
          logFd = fs.openSync(updateLogPath, 'a');
        } catch (logError) {
          console.warn('Failed to open update log file, continuing without log capture:', logError);
        }

        if (isWindows) {
          try {
            server.close();
          } catch (closeError) {
            console.warn('Failed to close the listener before the update script:', closeError);
          }
        }

        const child = spawnChild(shell, [shellFlag, script], {
          detached: true,
          stdio: logFd !== null ? ['ignore', logFd, logFd] : 'ignore',
          env: storedOptions.uiPassword
            ? withUserEnv(process.env, { OPENCHAMBER_UI_PASSWORD: storedOptions.uiPassword })
            : process.env,
          windowsHide: true,
        });
        child.unref();

        if (logFd !== null) {
          try {
            fs.closeSync(logFd);
          } catch {
            void 0;
          }
        }

        console.log('Update process spawned, shutting down server...');

        setTimeout(() => {
          process.exit(0);
        }, 500);
      }, 500);
    } catch (error) {
      console.error('Failed to install update:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to install update',
      });
    }
  });

  app.get('/api/openchamber/models-metadata', async (_req, res) => {
    try {
      const { getModelsMetadata, toClientModelsMetadata } = await import('../opencode/models-metadata.js');
      const { metadata, fromCache, stale } = await getModelsMetadata({
        url: modelsDevApiUrl,
        ttlMs: modelsMetadataCacheTtl,
      });
      res.setHeader('Cache-Control', fromCache && !stale ? 'public, max-age=60' : 'public, max-age=300');
      res.json(toClientModelsMetadata(metadata));
    } catch (error) {
      console.warn('Failed to fetch models.dev metadata via server:', error);
      const statusCode = hasErrorName(error) && (error.name === 'TimeoutError' || error.name === 'AbortError') ? 504 : 502;
      res.status(statusCode).json({ error: 'Failed to retrieve model metadata' });
    }
  });

  app.get('/api/zen/models', async (_req, res) => {
    try {
      const models = await fetchFreeZenModels();
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.json({ models });
    } catch (error) {
      console.warn('Failed to fetch zen models:', error);
      const cachedZenModels = getCachedZenModels();
      if (cachedZenModels) {
        res.setHeader('Cache-Control', 'public, max-age=60');
        res.json(cachedZenModels);
      } else {
        const statusCode = hasErrorName(error) && error.name === 'AbortError' ? 504 : 502;
        res.status(statusCode).json({ error: 'Failed to retrieve zen models' });
      }
    }
  });
};
