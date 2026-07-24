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
    gracefulShutdown,
    readSettingsFromDiskMigrated,
    fetchFreeZenModels,
    getCachedZenModels,
  } = dependencies;

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
      if (process.env.OPENCHAMBER_RUNTIME === 'desktop') {
        return res.status(409).json({ error: 'Desktop installations must use the native application updater' });
      }
      const { spawn: spawnChild, spawnSync } = await import('child_process');
      const {
        checkForUpdates,
        getUpdateLaunchSpec,
        detectPackageManagerDetails,
      } = await import('../package-manager.js');
      const { startUpdateTransaction } = await import('../openchamber-update/runtime.js');

      const updateInfo = await checkForUpdates();
      if (updateInfo.error) {
        return res.status(503).json({ error: updateInfo.error });
      }
      if (!updateInfo.available) {
        return res.status(400).json({ error: 'No update available' });
      }
      const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
      const currentVersion = typeof updateInfo.currentVersion === 'string' ? updateInfo.currentVersion.trim() : '';
      const targetVersion = typeof updateInfo.version === 'string' ? updateInfo.version.trim() : '';
      if (!versionPattern.test(targetVersion)) {
        return res.status(502).json({ error: 'Update service returned an invalid target version' });
      }
      if (!versionPattern.test(currentVersion)) {
        return res.status(500).json({ error: 'The installed OpenChamber version could not be verified' });
      }

      const isContainer =
        fs.existsSync('/.dockerenv') ||
        Boolean(process.env.CONTAINER) ||
        process.env.container === 'docker';

      if (isContainer) {
        return res.status(409).json({
          error: 'Container installations must be updated by replacing the container image',
        });
      }
      const pmDetails = detectPackageManagerDetails();
      const pm = pmDetails.packageManager;
      const ownershipReasons = new Set(['install-path-owner', 'global-root-owner', 'forced-env-owner']);
      if (!ownershipReasons.has(pmDetails.reason) || !pmDetails.packagePath) {
        return res.status(409).json({
          error: 'The package manager that owns this OpenChamber installation could not be verified. Run openchamber update from the installation environment.',
        });
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
      const knownServiceManagers = new Set(['systemd', 'launchd', 'windows-task']);
      const persistedServiceManager = typeof storedOptions.serviceManager === 'string' ? storedOptions.serviceManager : '';
      const environmentServiceManager = typeof process.env.OPENCHAMBER_SERVICE_MANAGER === 'string'
        ? process.env.OPENCHAMBER_SERVICE_MANAGER
        : '';
      let serviceManager = null;
      if (knownServiceManagers.has(persistedServiceManager)) {
        serviceManager = persistedServiceManager;
      } else if (knownServiceManagers.has(environmentServiceManager)) {
        serviceManager = environmentServiceManager;
      }
      if (!serviceManager && launchMode === 'foreground' && process.platform === 'win32') {
        const taskStatus = spawnSync('schtasks.exe', ['/Query', '/TN', 'dev.openchamber.web'], {
          stdio: 'ignore',
          windowsHide: true,
        });
        if (taskStatus.status === 0) serviceManager = 'windows-task';
      }
      if (launchMode === 'foreground' && !serviceManager) {
        return res.status(409).json({
          error: 'Automatic update requires a recognized service manager for foreground servers. Run openchamber update from the terminal.',
        });
      }
      const isForegroundService = launchMode === 'foreground';
      const packagePath = pmDetails.packagePath || path.resolve(__dirname, '..');
      const cliPath = path.join(packagePath, 'bin', 'cli.js');
      const restartArgs = [cliPath, 'serve', '--port', String(storedOptions.port || currentPort), '--quiet'];
      if (storedOptions.host) {
        restartArgs.push('--host', storedOptions.host);
      }
      if (storedOptions.apiOnly === true) {
        restartArgs.push('--api-only');
      }
      const configuredHealthHost = typeof storedOptions.host === 'string' ? storedOptions.host.trim() : '';
      let healthHost = configuredHealthHost.replace(/^\[|\]$/g, '');
      if (!configuredHealthHost || configuredHealthHost === '0.0.0.0') {
        healthHost = '127.0.0.1';
      } else if (configuredHealthHost === '::' || configuredHealthHost === '[::]') {
        healthHost = '::1';
      }
      const healthUrl = new URL('/health', `http://${healthHost.includes(':') ? `[${healthHost}]` : healthHost}:${storedOptions.port || currentPort}`).toString();
      const install = getUpdateLaunchSpec(pm, targetVersion, {
        command: pmDetails.packageManagerCommand || undefined,
      });
      const rollback = getUpdateLaunchSpec(pm, currentVersion, {
        command: pmDetails.packageManagerCommand || undefined,
      });
      const transaction = await startUpdateTransaction({
        openchamberDataDir,
        currentVersion,
        targetVersion,
        packageManager: pm,
        packagePath,
        install,
        rollback,
        stop: {
          command: process.execPath,
          args: [cliPath, 'stop', '--port', String(storedOptions.port || currentPort), '--quiet'],
        },
        restart: {
          mode: isForegroundService ? 'service' : 'daemon',
          command: process.execPath,
          args: restartArgs,
          env: storedOptions.uiPassword
            ? { OPENCHAMBER_UI_PASSWORD: storedOptions.uiPassword }
            : {},
          healthUrl,
          serviceManager,
          ...(serviceManager === 'windows-task'
            ? { serviceCommand: 'schtasks.exe', serviceArgs: ['/Run', '/TN', 'dev.openchamber.web'] }
            : {}),
        },
        oldPid: process.pid,
        helperManager: serviceManager === 'systemd' || serviceManager === 'launchd' ? serviceManager : null,
        spawnChild,
      });

      console.log(`OpenChamber update transaction ${transaction.id} prepared (${currentVersion} -> ${targetVersion}, ${pm})`);
      let shutdownScheduled = false;
      const scheduleShutdown = () => {
        if (shutdownScheduled) return;
        shutdownScheduled = true;
        const shutdownTimer = setTimeout(() => {
          if (typeof gracefulShutdown === 'function') {
            void gracefulShutdown({ exitProcess: true });
          } else {
            process.exit(0);
          }
        }, 250);
        shutdownTimer.unref?.();
      };
      res.once('finish', scheduleShutdown);
      res.once('close', scheduleShutdown);
      return res.status(202).json({
        accepted: true,
        transactionId: transaction.id,
        currentVersion: transaction.currentVersion,
        targetVersion: transaction.targetVersion,
        packageManager: pm,
        restartManager: isForegroundService ? 'service' : 'cli',
      });
    } catch (error) {
      console.error('Failed to install update:', error);
      res.status(Number.isInteger(error?.statusCode) ? error.statusCode : 500).json({
        error: error instanceof Error ? error.message : 'Failed to install update',
      });
    }
  });

  app.get('/api/openchamber/update-status/:transactionId', async (req, res) => {
    const { readUpdateTransactionStatus } = await import('../openchamber-update/runtime.js');
    const status = readUpdateTransactionStatus(openchamberDataDir, req.params.transactionId);
    if (!status) {
      return res.status(404).json({ error: 'Update transaction not found' });
    }
    res.setHeader('Cache-Control', 'no-store');
    return res.json(status);
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
