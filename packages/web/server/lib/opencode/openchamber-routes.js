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

  function readUpdateStatusFile(filePath) {
    try {
      const content = fs.readFileSync(filePath, 'utf8').trim();
      if (!content) {
        return null;
      }
      return JSON.parse(content);
    } catch {
      return null;
    }
  }

  function writeUpdateStatusFile(filePath, status) {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, `${JSON.stringify(status)}\n`, { encoding: 'utf8' });
    } catch (error) {
      console.warn('Failed to write update status file:', error);
    }
  }

  const updateLogPath = path.join(openchamberDataDir, 'update-install.log');
  const updateStatusFilePath = path.join(openchamberDataDir, 'update-status.json');

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
        installId: parseString(req.query.installId),
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
        const containerUpdateStatus = {
          state: 'installing',
          startedAt: Date.now(),
          targetVersion: updateInfo.version || null,
        };
        writeUpdateStatusFile(updateStatusFilePath, containerUpdateStatus);

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

          let logFd = null;
          try {
            fs.mkdirSync(path.dirname(updateLogPath), { recursive: true });
            logFd = fs.openSync(updateLogPath, 'a');
          } catch (logError) {
            console.warn('Failed to open update log file, continuing without log capture:', logError);
          }

          const child = spawnChild(shell, [shellFlag, updateCmd], {
            detached: true,
            stdio: logFd !== null ? ['ignore', logFd, logFd] : 'ignore',
            env: process.env,
          });

          const writeFinishedStatus = (state, exitCode, errorMessage) => {
            writeUpdateStatusFile(updateStatusFilePath, {
              state,
              startedAt: containerUpdateStatus.startedAt,
              targetVersion: updateInfo.version || null,
              finishedAt: Date.now(),
              ...(exitCode !== undefined && exitCode !== null ? { exitCode } : {}),
              ...(errorMessage ? { error: errorMessage } : {}),
            });
          };

          child.on('exit', (code) => {
            writeFinishedStatus(code === 0 ? 'success' : 'failed', code);
            if (code === 0) {
              console.log(`Update installed successfully (${pm}).`);
            } else {
              console.error(`Update failed (${pm}) with exit code ${code}. See ${updateLogPath}`);
            }
          });

          child.on('error', (spawnError) => {
            const message = spawnError instanceof Error ? spawnError.message : String(spawnError);
            console.error(`Failed to spawn update command (${updateCmd}):`, spawnError);
            writeFinishedStatus('failed', undefined, message);
          });

          child.unref();

          if (logFd !== null) {
            try {
              fs.closeSync(logFd);
            } catch {
            }
          }
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
      const isForegroundService = launchMode === 'foreground';

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
      const restartCmd = isForegroundService ? '' : `(${restartCmdPrimary}) || (${restartCmdFallback})`;
      const updateStatus = {
        state: 'installing',
        startedAt: Date.now(),
        targetVersion: updateInfo.version || null,
      };
      writeUpdateStatusFile(updateStatusFilePath, updateStatus);
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

          const shell = isWindows ? (process.env.ComSpec || 'cmd.exe') : 'sh';
          const shellFlag = isWindows ? '/c' : '-c';
          const quoteStatusFile = isWindows ? quoteCmd(updateStatusFilePath) : quotePosix(updateStatusFilePath);
          const script = isWindows
            ? `
            echo ${quoteCmd(logPreamble)}
            timeout /t 2 /nobreak >nul
            ${updateCmd}
            if %ERRORLEVEL% EQU 0 (
              echo {"state":"success"} 1> ${quoteStatusFile}
              echo Update successful, restarting OpenChamber...
              ${restartCmd || 'echo Service manager will restart OpenChamber.'}
            ) else (
              echo {"state":"failed","exitCode":%ERRORLEVEL%} 1> ${quoteStatusFile}
              echo Update failed
              exit /b 1
            )
            `
          : `
            printf '%s\n' ${quotePosix(logPreamble)}
            sleep 2
            ${updateCmd}
            code=$?
            if [ $code -eq 0 ]; then
              printf '%s\n' '{"state":"success"}' > ${quoteStatusFile}
              echo "Update successful, restarting OpenChamber..."
              ${restartCmd || 'echo "Service manager will restart OpenChamber."'}
            else
              printf '{"state":"failed","exitCode":%s}\\n' "$code" > ${quoteStatusFile}
              echo "Update failed"
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

        const child = spawnChild(shell, [shellFlag, script], {
          detached: true,
          stdio: logFd !== null ? ['ignore', logFd, logFd] : 'ignore',
          env: process.env,
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

  app.get('/api/openchamber/update-status', (_req, res) => {
    // Authoritative completion state for the in-app updater. Written by the
    // update-install flow before it responds, then replaced by the install
    // process when it finishes. `idle` means no install is recorded, which the
    // UI treats the same as an unreachable status endpoint.
    res.json(readUpdateStatusFile(updateStatusFilePath) || { state: 'idle' });
  });

  app.get('/api/openchamber/models-metadata', async (_req, res) => {
    try {
      const { getModelsMetadata } = await import('./models-metadata.js');
      const { metadata, fromCache, stale } = await getModelsMetadata({
        url: modelsDevApiUrl,
        ttlMs: modelsMetadataCacheTtl,
      });
      res.setHeader('Cache-Control', fromCache && !stale ? 'public, max-age=60' : 'public, max-age=300');
      res.json(metadata);
    } catch (error) {
      console.warn('Failed to fetch models.dev metadata via server:', error);
      const statusCode = error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 504 : 502;
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
        const statusCode = error?.name === 'AbortError' ? 504 : 502;
        res.status(statusCode).json({ error: 'Failed to retrieve zen models' });
      }
    }
  });
};
