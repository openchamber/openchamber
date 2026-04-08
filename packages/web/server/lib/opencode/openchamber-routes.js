export const registerOpenChamberRoutes = (app, dependencies) => {
  const {
    fs,
    os,
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
    backendRegistry,
    openCodeBackendRuntime,
    sessionBindingsRuntime,
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
      const tmpDir = os.tmpdir();
      const instanceFilePath = path.join(tmpDir, `openchamber-${currentPort}.json`);
      let storedOptions = { port: currentPort, daemon: true };
      try {
        const content = await fs.promises.readFile(instanceFilePath, 'utf8');
        storedOptions = JSON.parse(content);
      } catch {
      }

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
      const restartCmd = `(${restartCmdPrimary}) || (${restartCmdFallback})`;
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
        `updateCommand=${updateCmd}`,
        `restartCommand=${restartCmd}`,
        `logPath=${updateLogPath}`,
      ].join('\n');

      res.json({
        success: true,
        message: 'Update starting, server will restart shortly',
        version: updateInfo.version,
        packageManager: pm,
        autoRestart: true,
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
            ${updateCmd}
            if %ERRORLEVEL% EQU 0 (
              echo Update successful, restarting OpenChamber...
              ${restartCmd}
            ) else (
              echo Update failed
              exit /b 1
            )
            `
          : `
            printf '%s\n' ${quotePosix(logPreamble)}
            sleep 2
            ${updateCmd}
            if [ $? -eq 0 ]; then
              echo "Update successful, restarting OpenChamber..."
              ${restartCmd}
            else
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

  app.get('/api/openchamber/backends', async (_req, res) => {
    try {
      const settings = await readSettingsFromDiskMigrated();
      const defaultBackend = typeof settings?.defaultBackend === 'string' && settings.defaultBackend.trim().length > 0
        ? settings.defaultBackend.trim()
        : await backendRegistry.getDefaultBackendId();
      res.json({
        defaultBackend,
        backends: backendRegistry.listBackends(),
      });
    } catch (error) {
      console.error('Failed to list harness backends:', error);
      res.status(500).json({ error: 'Failed to list harness backends' });
    }
  });

  const getRequestedBackendId = async (req) => {
    const bodyBackendId = typeof req.body?.backendId === 'string' ? req.body.backendId.trim() : '';
    const queryBackendId = typeof req.query?.backendId === 'string' ? req.query.backendId.trim() : '';
    if (bodyBackendId) {
      return bodyBackendId;
    }
    if (queryBackendId) {
      return queryBackendId;
    }
    const settings = await readSettingsFromDiskMigrated();
    return typeof settings?.defaultBackend === 'string' && settings.defaultBackend.trim().length > 0
      ? settings.defaultBackend.trim()
      : await backendRegistry.getDefaultBackendId();
  };

  const sendUnsupportedBackend = (res, backendId) => {
    return res.status(501).json({
      error: `Backend "${backendId}" is not available yet`,
      backendId,
      code: 'BACKEND_UNSUPPORTED',
    });
  };

  const getBoundBackend = (sessionId) => sessionBindingsRuntime.getEffectiveBindingSync(sessionId);

  app.get('/api/openchamber/harness/control-surface', async (req, res) => {
    try {
      const sessionId = typeof req.query?.sessionId === 'string' ? req.query.sessionId.trim() : '';
      const binding = sessionId ? getBoundBackend(sessionId) : null;
      const backendId = binding?.backendId || await getRequestedBackendId(req);

      if (!backendRegistry.isBackendSelectable(backendId)) {
        return sendUnsupportedBackend(res, backendId);
      }
      if (backendId !== 'opencode') {
        return sendUnsupportedBackend(res, backendId);
      }

      const payload = await openCodeBackendRuntime.getControlSurface({
        directory: binding?.directory
          || (typeof req.query?.directory === 'string' ? req.query.directory : undefined),
        providerId: typeof req.query?.providerId === 'string' ? req.query.providerId : undefined,
        modelId: typeof req.query?.modelId === 'string' ? req.query.modelId : undefined,
      });

      return res.status(200).json(payload);
    } catch (error) {
      console.error('Failed to load harness control surface:', error);
      const message = error?.body?.error || error?.message || 'Failed to load control surface';
      return res.status(400).json({ error: message });
    }
  });

  app.post('/api/openchamber/harness/session', async (req, res) => {
    try {
      const backendId = await getRequestedBackendId(req);
      if (!backendRegistry.isBackendSelectable(backendId)) {
        return sendUnsupportedBackend(res, backendId);
      }

      if (backendId !== 'opencode') {
        return sendUnsupportedBackend(res, backendId);
      }

      const payload = await openCodeBackendRuntime.createSession({
        directory: typeof req.body?.directory === 'string' ? req.body.directory : undefined,
        title: typeof req.body?.title === 'string' ? req.body.title : undefined,
        parentID: typeof req.body?.parentID === 'string' ? req.body.parentID : undefined,
      });

      if (payload?.id) {
        await sessionBindingsRuntime.upsertBinding({
          sessionId: payload.id,
          backendId,
          backendSessionId: payload.id,
          directory: typeof payload.directory === 'string' ? payload.directory : null,
        });
      }

      return res.status(200).json(sessionBindingsRuntime.annotateSession(payload));
    } catch (error) {
      console.error('Failed to create harness session:', error);
      const message = error?.body?.error || error?.message || 'Failed to create session';
      return res.status(400).json({ error: message });
    }
  });

  app.post('/api/openchamber/harness/session/:sessionId/message', async (req, res) => {
    try {
      const sessionId = typeof req.params?.sessionId === 'string' ? req.params.sessionId : '';
      const binding = getBoundBackend(sessionId);
      if (!binding) {
        return res.status(404).json({ error: 'Session not found' });
      }
      if (!backendRegistry.isBackendSelectable(binding.backendId)) {
        return sendUnsupportedBackend(res, binding.backendId);
      }
      if (binding.backendId !== 'opencode') {
        return sendUnsupportedBackend(res, binding.backendId);
      }

      await openCodeBackendRuntime.promptAsync({
        sessionID: binding.backendSessionId,
        directory: typeof req.body?.directory === 'string' ? req.body.directory : binding.directory,
        messageID: typeof req.body?.messageID === 'string' ? req.body.messageID : undefined,
        model: req.body?.model,
        agent: typeof req.body?.agent === 'string' ? req.body.agent : undefined,
        variant: typeof req.body?.variant === 'string' ? req.body.variant : undefined,
        format: req.body?.format,
        parts: Array.isArray(req.body?.parts) ? req.body.parts : undefined,
      });

      return res.status(204).end();
    } catch (error) {
      console.error('Failed to send harness message:', error);
      const message = error?.body?.error || error?.message || 'Failed to send message';
      return res.status(400).json({ error: message });
    }
  });

  app.post('/api/openchamber/harness/session/:sessionId/command', async (req, res) => {
    try {
      const sessionId = typeof req.params?.sessionId === 'string' ? req.params.sessionId : '';
      const binding = getBoundBackend(sessionId);
      if (!binding) {
        return res.status(404).json({ error: 'Session not found' });
      }
      if (!backendRegistry.isBackendSelectable(binding.backendId)) {
        return sendUnsupportedBackend(res, binding.backendId);
      }
      if (binding.backendId !== 'opencode') {
        return sendUnsupportedBackend(res, binding.backendId);
      }

      const payload = await openCodeBackendRuntime.command({
        sessionID: binding.backendSessionId,
        directory: typeof req.body?.directory === 'string' ? req.body.directory : binding.directory,
        messageID: typeof req.body?.messageID === 'string' ? req.body.messageID : undefined,
        model: typeof req.body?.model === 'string' ? req.body.model : undefined,
        agent: typeof req.body?.agent === 'string' ? req.body.agent : undefined,
        command: typeof req.body?.command === 'string' ? req.body.command : '',
        arguments: typeof req.body?.arguments === 'string' ? req.body.arguments : '',
        variant: typeof req.body?.variant === 'string' ? req.body.variant : undefined,
        parts: Array.isArray(req.body?.parts) ? req.body.parts : undefined,
      });

      return res.status(200).json(payload ?? {});
    } catch (error) {
      console.error('Failed to send harness command:', error);
      const message = error?.body?.error || error?.message || 'Failed to run command';
      return res.status(400).json({ error: message });
    }
  });

  app.post('/api/openchamber/harness/session/:sessionId/abort', async (req, res) => {
    try {
      const sessionId = typeof req.params?.sessionId === 'string' ? req.params.sessionId : '';
      const binding = getBoundBackend(sessionId);
      if (!binding) {
        return res.status(404).json({ error: 'Session not found' });
      }
      if (!backendRegistry.isBackendSelectable(binding.backendId)) {
        return sendUnsupportedBackend(res, binding.backendId);
      }
      if (binding.backendId !== 'opencode') {
        return sendUnsupportedBackend(res, binding.backendId);
      }

      const ok = await openCodeBackendRuntime.abortSession({
        sessionID: binding.backendSessionId,
        directory: typeof req.body?.directory === 'string' ? req.body.directory : binding.directory,
      });

      return res.status(200).json({ ok: Boolean(ok) });
    } catch (error) {
      console.error('Failed to abort harness session:', error);
      const message = error?.body?.error || error?.message || 'Failed to abort session';
      return res.status(400).json({ error: message });
    }
  });

  app.post('/api/openchamber/harness/session/:sessionId/update', async (req, res) => {
    try {
      const sessionId = typeof req.params?.sessionId === 'string' ? req.params.sessionId : '';
      const binding = getBoundBackend(sessionId);
      if (!binding) {
        return res.status(404).json({ error: 'Session not found' });
      }
      if (!backendRegistry.isBackendSelectable(binding.backendId)) {
        return sendUnsupportedBackend(res, binding.backendId);
      }
      if (binding.backendId !== 'opencode') {
        return sendUnsupportedBackend(res, binding.backendId);
      }

      const payload = await openCodeBackendRuntime.updateSession({
        sessionID: binding.backendSessionId,
        directory: typeof req.body?.directory === 'string' ? req.body.directory : binding.directory,
        title: typeof req.body?.title === 'string' ? req.body.title : undefined,
        time: req.body?.time && typeof req.body.time === 'object' ? req.body.time : undefined,
      });

      return res.status(200).json(sessionBindingsRuntime.annotateSession(payload));
    } catch (error) {
      console.error('Failed to update harness session:', error);
      const message = error?.body?.error || error?.message || 'Failed to update session';
      return res.status(400).json({ error: message });
    }
  });
};
