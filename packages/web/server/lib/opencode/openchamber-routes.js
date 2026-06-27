import { resolveUpdateRestartOwnerForInstance } from '../systemd-user-service.js';

const UPDATE_STATUS_FILE_NAME = 'update-install-status';

function getUpdateStatusFilePath(pathImpl, openchamberDataDir) {
  return pathImpl.join(openchamberDataDir, UPDATE_STATUS_FILE_NAME);
}

function serializeUpdateStatusFile(payload) {
  return Object.entries(payload)
    .filter(([, value]) => typeof value === 'string' && value.length > 0)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
}

function parseUpdateStatusFile(content) {
  if (typeof content !== 'string' || content.trim().length === 0) {
    return null;
  }

  const payload = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (!key || !value) continue;
    payload[key] = value;
  }

  return Object.keys(payload).length > 0 ? payload : null;
}

function readUpdateStatus(pathImpl, fsImpl, openchamberDataDir) {
  try {
    const content = fsImpl.readFileSync(getUpdateStatusFilePath(pathImpl, openchamberDataDir), 'utf8');
    return parseUpdateStatusFile(content);
  } catch {
    return null;
  }
}

function writeUpdateStatus(pathImpl, fsImpl, openchamberDataDir, payload) {
  const filePath = getUpdateStatusFilePath(pathImpl, openchamberDataDir);
  fsImpl.mkdirSync(pathImpl.dirname(filePath), { recursive: true });
  fsImpl.writeFileSync(filePath, `${serializeUpdateStatusFile(payload)}\n`, 'utf8');
}

function quoteStatusValue(value) {
  return String(value || '').replace(/[\r\n]/g, ' ').trim();
}

function buildUpdateStatusPayload(base, overrides = {}) {
  const next = {
    ...base,
    ...overrides,
  };

  return Object.fromEntries(
    Object.entries(next)
      .filter(([, value]) => value !== null && value !== undefined && String(value).trim().length > 0)
      .map(([key, value]) => [key, quoteStatusValue(value)]),
  );
}

function buildPosixUpdateStatusCommand(statusFilePath, quotePosix, payload) {
  const lines = Object.entries(payload).map(([key, value]) => `${key}=${value}`);
  const quotedLines = lines.map((line) => quotePosix(line)).join(' ');
  return `printf '%s\\n' ${quotedLines} > ${quotePosix(statusFilePath)}`;
}

function buildWindowsUpdateStatusCommand(statusFilePath, quoteCmd, payload) {
  const lines = Object.entries(payload).map(([key, value]) => `${key}=${value}`);
  const body = lines.map((line) => `echo ${line}`).join('\r\n');
  return `(${body}) > ${quoteCmd(statusFilePath)}`;
}

export const registerOpenChamberRoutes = (app, dependencies) => {
  const {
    fs,
    path,
    process,
    server,
    __dirname,
    openchamberDataDir,
    modelsDevApiUrl,
    modelsMetadataCacheTtl,
    readSettingsFromDiskMigrated,
    fetchFreeZenModels,
    getCachedZenModels,
  } = dependencies;

  let cachedModelsMetadata = null;
  let cachedModelsMetadataTimestamp = 0;

  app.get('/api/openchamber/update-check', async (req, res) => {
    try {
      const { checkForUpdates } = await import('../package-manager.js');
      const parseString = (value) => (typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined);
      const parseReportUsage = (value) => {
        if (typeof value !== 'string') return true;
        const normalized = value.trim().toLowerCase();
        if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
        return true;
      };
      const inferDeviceClass = (ua) => {
        const value = (ua || '').toLowerCase();
        if (!value) return 'unknown';
        if (value.includes('ipad') || value.includes('tablet')) return 'tablet';
        if (value.includes('mobi') || value.includes('android') || value.includes('iphone')) return 'mobile';
        return 'desktop';
      };
      const userAgent = typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : '';

      const updateInfo = await checkForUpdates({
        appType: parseString(req.query.appType),
        deviceClass: parseString(req.query.deviceClass) || inferDeviceClass(userAgent),
        platform: parseString(req.query.platform),
        arch: parseString(req.query.arch),
        instanceMode: parseString(req.query.instanceMode),
        currentVersion: parseString(req.query.currentVersion),
        reportUsage: parseReportUsage(parseString(req.query.reportUsage)),
      });
      res.json(updateInfo);
    } catch (error) {
      console.error('Failed to check for updates:', error);
      res.status(500).json({
        available: false,
        error: error instanceof Error ? error.message : 'Failed to check for updates',
      });
    }
  });

  app.post('/api/openchamber/update-install', async (_req, res) => {
    try {
      const { spawn: spawnChild } = await import('child_process');
      const {
        checkForUpdates,
        getUpdateCommand,
        detectPackageManagerDetails,
      } = await import('../package-manager.js');

      const updateInfo = await checkForUpdates();
      if (!updateInfo.available) {
        return res.status(400).json({ error: 'No update available' });
      }

      const pmDetails = detectPackageManagerDetails();
      const pm = pmDetails.packageManager;
      const updateCmd = getUpdateCommand(pm);
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

      const currentPort = server.address()?.port || 3000;
      const instanceFilePath = path.join(openchamberDataDir, 'run', `openchamber-${currentPort}.json`);
      let storedOptions = { port: currentPort, daemon: true };
      try {
        const content = await fs.promises.readFile(instanceFilePath, 'utf8');
        storedOptions = JSON.parse(content);
      } catch {
      }
      const launchMode = storedOptions.launchMode === 'foreground' ? 'foreground' : 'daemon';
      const restartOwner = resolveUpdateRestartOwnerForInstance({
        launchMode,
        port: storedOptions.port,
      });
      const managedForegroundController = restartOwner.controller;

      const isWindows = process.platform === 'win32';
      const quotePosix = (value) => `'${String(value).replace(/'/g, "'\\''")}'`;
      const quoteCmd = (value) => {
        const stringValue = String(value);
        return `"${stringValue.replace(/"/g, '""')}"`;
      };

      const cliPath = path.resolve(__dirname, '..', 'bin', 'cli.js');
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
      if (storedOptions.uiPassword) {
        if (isWindows) {
          const escapedPw = storedOptions.uiPassword.replace(/"/g, '""');
          restartCmdPrimary += ` --ui-password "${escapedPw}"`;
          restartCmdFallback += ` --ui-password "${escapedPw}"`;
        } else {
          const escapedPw = storedOptions.uiPassword.replace(/'/g, "'\\''");
          restartCmdPrimary += ` --ui-password '${escapedPw}'`;
          restartCmdFallback += ` --ui-password '${escapedPw}'`;
        }
      }
      if (storedOptions.apiOnly === true) {
        restartCmdPrimary += ' --api-only';
        restartCmdFallback += ' --api-only';
      }
      const restartCmd = managedForegroundController
        ? managedForegroundController.start.shellCommand
        : `(${restartCmdPrimary}) || (${restartCmdFallback})`;
      const stopCmd = managedForegroundController?.stop.shellCommand || '';
      const useSystemdRunDetachedUpdate = Boolean(managedForegroundController);
      const updateStatusFilePath = getUpdateStatusFilePath(path, openchamberDataDir);
      const statusBase = buildUpdateStatusPayload({
        currentVersion: updateInfo.currentVersion || 'unknown',
        targetVersion: updateInfo.version || 'unknown',
        launchMode,
        restartManager: restartOwner.kind,
      });
      writeUpdateStatus(path, fs, openchamberDataDir, buildUpdateStatusPayload(statusBase, { state: 'queued' }));
      const statusCmd = (state) => {
        const payload = buildUpdateStatusPayload(statusBase, { state });
        return isWindows
          ? buildWindowsUpdateStatusCommand(updateStatusFilePath, quoteCmd, payload)
          : buildPosixUpdateStatusCommand(updateStatusFilePath, quotePosix, payload);
      };
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
        `serviceManager=${managedForegroundController?.label || 'none'}`,
        `launcher=${useSystemdRunDetachedUpdate ? 'systemd-run --user' : 'direct-detached-shell'}`,
        `updateCommand=${updateCmd}`,
        `stopCommand=${stopCmd || 'pid/process-exit'}`,
        `restartCommand=${restartCmd || 'service-manager'}`,
        `statusFile=${updateStatusFilePath}`,
        `logPath=${updateLogPath}`,
      ].join('\n');

      res.json({
        success: true,
        message: 'Update starting, server will restart shortly',
        version: updateInfo.version,
        packageManager: pm,
        autoRestart: true,
        restartManager: restartOwner.kind,
      });

        setTimeout(() => {
          console.log(`\nInstalling update using ${pm}...`);
          console.log(`Running: ${updateCmd}`);
          console.log(logPreamble);

          const shell = isWindows ? (process.env.ComSpec || 'cmd.exe') : 'sh';
          const shellFlag = isWindows ? '/c' : '-c';
          const script = isWindows
            ? `
            echo ${quoteCmd(logPreamble)}
            timeout /t 2 /nobreak >nul
            ${statusCmd('stopping_service')}
            ${stopCmd || 'rem no service stop required'}
            if %ERRORLEVEL% NEQ 0 (
              ${statusCmd('failed_stop')}
              echo Failed to stop OpenChamber before update
              exit /b 1
            )
            ${statusCmd('installing_update')}
            ${updateCmd}
            if %ERRORLEVEL% EQU 0 (
              ${statusCmd('restarting_service')}
              echo Update successful, restarting OpenChamber...
              ${restartCmd || 'echo Service manager will restart OpenChamber.'}
              if %ERRORLEVEL% NEQ 0 (
                ${statusCmd('failed_restart')}
                echo Update succeeded but restart failed
                exit /b 1
              )
              ${statusCmd('completed')}
            ) else (
              ${statusCmd('failed_install')}
              echo Update failed
              exit /b 1
            )
            `
          : `
            printf '%s\n' ${quotePosix(logPreamble)}
            sleep 2
            ${statusCmd('stopping_service')}
            ${stopCmd || ':'}
            if [ $? -ne 0 ]; then
              ${statusCmd('failed_stop')}
              echo "Failed to stop OpenChamber before update"
              exit 1
            fi
            ${statusCmd('installing_update')}
            ${updateCmd}
            if [ $? -eq 0 ]; then
              ${statusCmd('restarting_service')}
              echo "Update successful, restarting OpenChamber..."
              ${restartCmd || 'echo "Service manager will restart OpenChamber."'}
              if [ $? -ne 0 ]; then
                ${statusCmd('failed_restart')}
                echo "Update succeeded but service restart failed"
                exit 1
              fi
              ${statusCmd('completed')}
            else
              ${statusCmd('failed_install')}
              echo "Update failed"
              ${managedForegroundController ? `${restartCmd}
              if [ $? -ne 0 ]; then
                ${statusCmd('failed_restart')}
                echo "Update failed and service restart also failed"
              fi` : ':'}
              exit 1
            fi
          `;

        let logFd = null;
        try {
          fs.mkdirSync(path.dirname(updateLogPath), { recursive: true });
          logFd = fs.openSync(updateLogPath, 'a');
        } catch (logError) {
          console.warn('Failed to open update log file, continuing without log capture:', logError);
        }

        const systemdRunArgs = [
          '--user',
          ...(typeof process.env.PATH === 'string' && process.env.PATH.length > 0 ? ['-E', 'PATH'] : []),
          '--unit', `openchamber-update-${Date.now()}`,
          '--collect',
          '--quiet',
          'sh',
          '-lc',
          script,
        ];

        const child = useSystemdRunDetachedUpdate
          ? spawnChild('systemd-run', systemdRunArgs, {
            detached: true,
            stdio: logFd !== null ? ['ignore', logFd, logFd] : 'ignore',
            env: process.env,
          })
          : spawnChild(shell, [shellFlag, script], {
            detached: true,
            stdio: logFd !== null ? ['ignore', logFd, logFd] : 'ignore',
            env: process.env,
          });
        child.on('error', (error) => {
          try {
            writeUpdateStatus(path, fs, openchamberDataDir, buildUpdateStatusPayload(statusBase, { state: 'failed_launch' }));
          } catch {
          }
          console.error('Failed to launch detached update process:', error);
        });
        child.unref();

        if (logFd !== null) {
          try {
            fs.closeSync(logFd);
          } catch {
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

  app.get('/api/openchamber/update-status', async (_req, res) => {
    try {
      const status = readUpdateStatus(path, fs, openchamberDataDir);
      res.json(status || { state: 'idle' });
    } catch (error) {
      console.error('Failed to read update status:', error);
      res.status(500).json({ state: 'unknown', error: error instanceof Error ? error.message : 'Failed to read update status' });
    }
  });

  app.get('/api/openchamber/models-metadata', async (_req, res) => {
    const now = Date.now();

    if (cachedModelsMetadata && now - cachedModelsMetadataTimestamp < modelsMetadataCacheTtl) {
      res.setHeader('Cache-Control', 'public, max-age=60');
      return res.json(cachedModelsMetadata);
    }

    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timeout = controller ? setTimeout(() => controller.abort(), 8000) : null;

    try {
      const response = await fetch(modelsDevApiUrl, {
        signal: controller?.signal,
        headers: {
          Accept: 'application/json'
        }
      });

      if (!response.ok) {
        throw new Error(`models.dev responded with status ${response.status}`);
      }

      const metadata = await response.json();
      cachedModelsMetadata = metadata;
      cachedModelsMetadataTimestamp = Date.now();

      res.setHeader('Cache-Control', 'public, max-age=300');
      res.json(metadata);
    } catch (error) {
      console.warn('Failed to fetch models.dev metadata via server:', error);

      if (cachedModelsMetadata) {
        res.setHeader('Cache-Control', 'public, max-age=60');
        res.json(cachedModelsMetadata);
      } else {
        const statusCode = error?.name === 'AbortError' ? 504 : 502;
        res.status(statusCode).json({ error: 'Failed to retrieve model metadata' });
      }
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
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
        const statusCode = error?.name === 'AbortError' ? 504 : 502;
        res.status(statusCode).json({ error: 'Failed to retrieve zen models' });
      }
    }
  });
};
