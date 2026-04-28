import TOML from '@iarna/toml';

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

  const getBoundBackend = async (sessionId) => sessionBindingsRuntime.getEffectiveBinding(sessionId);
  const getBackendRuntime = (backendId) => backendRegistry.getRuntime(backendId);
  const parsePositiveNumber = (value) => {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      return value;
    }
    if (typeof value === 'string' && value.trim().length > 0) {
      const parsed = Number.parseInt(value, 10);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
    }
    return undefined;
  };
  const parseDirectory = (req, fallback) => {
    if (typeof req.body?.directory === 'string') return req.body.directory;
    if (typeof req.query?.directory === 'string') return req.query.directory;
    return fallback;
  };
  const toHarnessSession = (session, backendId) => {
    if (!session || typeof session !== 'object' || typeof session.id !== 'string') {
      throw new Error('Invalid harness session response');
    }
    return {
      id: session.id,
      backendId: typeof session.backendId === 'string' ? session.backendId : backendId,
      title: typeof session.title === 'string' ? session.title : '',
      directory: typeof session.directory === 'string' ? session.directory : (typeof session.cwd === 'string' ? session.cwd : null),
      parentId: typeof session.parentId === 'string' ? session.parentId : (typeof session.parentID === 'string' ? session.parentID : null),
      time: session.time && typeof session.time === 'object' ? session.time : { created: 0 },
      ...(session.metadata && typeof session.metadata === 'object' ? { metadata: session.metadata } : {}),
    };
  };
  const toHarnessMessageRecord = (record, backendId) => {
    if (!record || typeof record !== 'object' || !record.info || !Array.isArray(record.parts)) {
      throw new Error('Invalid harness message response');
    }
    const info = record.info;
    const message = {
      id: info.id,
      sessionId: info.sessionId || info.sessionID || '',
      role: info.role === 'assistant' || info.role === 'system' ? info.role : 'user',
      time: info.time && typeof info.time === 'object' ? info.time : { created: 0 },
      ...(typeof info.finish === 'string' ? { finish: info.finish } : {}),
      ...(info.attribution && typeof info.attribution === 'object' ? { attribution: info.attribution } : {}),
    };
    if (typeof message.id !== 'string') {
      throw new Error('Invalid harness message response');
    }
    const parts = record.parts.map((part) => {
      if (part?.kind) return part;
      const base = { id: part.id, sessionId: part.sessionId || part.sessionID || message.sessionId, messageId: part.messageId || part.messageID || message.id };
      if (part.type === 'text') return { ...base, kind: 'text', text: typeof part.text === 'string' ? part.text : '' };
      if (part.type === 'reasoning') return { ...base, kind: 'reasoning', text: typeof part.text === 'string' ? part.text : '' };
      if (part.type === 'tool') return { ...base, kind: 'tool', tool: { id: part.callID || part.id, name: part.tool || 'tool', category: 'custom', status: part.state?.status === 'completed' ? 'completed' : part.state?.status === 'error' ? 'failed' : 'running', input: part.state?.input, output: typeof part.state?.output === 'string' ? part.state.output : undefined, error: typeof part.state?.error === 'string' ? part.state.error : undefined, raw: part } };
      if (part.type === 'file') return { ...base, kind: 'attachment', attachment: { id: part.id, name: part.filename, mimeType: part.mime, url: part.url } };
      return { ...base, kind: 'custom', content: part };
    });
    return { info: message, parts, backendId };
  };
  const toRuntimeModel = (runConfig) => {
    const modelId = typeof runConfig?.model?.modelId === 'string' ? runConfig.model.modelId : '';
    const slashIndex = modelId.indexOf('/');
    if (slashIndex > 0) {
      return { providerID: modelId.slice(0, slashIndex), modelID: modelId.slice(slashIndex + 1) };
    }
    if (modelId) {
      return modelId;
    }
    return undefined;
  };
  const getRunConfigOption = (runConfig, optionId) => {
    const options = Array.isArray(runConfig?.options) ? runConfig.options : [];
    const option = options.find((entry) => entry?.id === optionId);
    return typeof option?.value === 'string' ? option.value : undefined;
  };
  const getMessageId = (body) => {
    if (typeof body?.messageId === 'string') return body.messageId;
    if (typeof body?.messageID === 'string') return body.messageID;
    return undefined;
  };
  const getParentSessionId = (body) => {
    if (typeof body?.parentSessionId === 'string') return body.parentSessionId;
    if (typeof body?.parentID === 'string') return body.parentID;
    return undefined;
  };

  app.get('/api/openchamber/harness/control-surface', async (req, res) => {
    try {
      const sessionId = typeof req.query?.sessionId === 'string' ? req.query.sessionId.trim() : '';
      const binding = sessionId ? await getBoundBackend(sessionId) : null;
      const backendId = binding?.backendId || await getRequestedBackendId(req);

      if (!backendRegistry.isBackendSelectable(backendId)) {
        return sendUnsupportedBackend(res, backendId);
      }
      const runtime = getBackendRuntime(backendId);
      if (!runtime?.getControlSurface) {
        return sendUnsupportedBackend(res, backendId);
      }

      const payload = await runtime.getControlSurface({
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

  app.get('/api/openchamber/harness/sessions', async (req, res) => {
    try {
      const requestedBackendId = typeof req.query?.backendId === 'string' ? req.query.backendId.trim() : '';
      const directory = parseDirectory(req);
      const limit = parsePositiveNumber(req.query?.limit);
      const archived = req.query?.archived === 'true';
      const roots = req.query?.roots === 'false' ? false : undefined;
      const descriptors = requestedBackendId
        ? [backendRegistry.getBackend(requestedBackendId)].filter(Boolean)
        : backendRegistry.listBackends().filter((backend) => backend.available && backend.capabilities?.sessions);
      const sessions = [];

      for (const descriptor of descriptors) {
        if (!backendRegistry.isBackendSelectable(descriptor.id)) {
          continue;
        }
        const runtime = getBackendRuntime(descriptor.id);
        if (!runtime?.listSessions) {
          continue;
        }
        const backendSessions = await runtime.listSessions({ directory, limit, archived, roots });
        if (Array.isArray(backendSessions)) {
          sessions.push(...backendSessions.map((session) => toHarnessSession(sessionBindingsRuntime.annotateSession({ ...session, backendId: descriptor.id }), descriptor.id)));
        }
      }

      sessions.sort((a, b) => (b?.time?.updated ?? b?.time?.created ?? 0) - (a?.time?.updated ?? a?.time?.created ?? 0));
      return res.status(200).json(limit ? sessions.slice(0, limit) : sessions);
    } catch (error) {
      console.error('Failed to list harness sessions:', error);
      const message = error?.body?.error || error?.message || 'Failed to list sessions';
      return res.status(400).json({ error: message });
    }
  });

  app.get('/api/openchamber/harness/session/:sessionId', async (req, res) => {
    try {
      const sessionId = typeof req.params?.sessionId === 'string' ? req.params.sessionId : '';
      const binding = await getBoundBackend(sessionId);
      if (!binding) {
        return res.status(404).json({ error: 'Session not found' });
      }
      if (!backendRegistry.isBackendSelectable(binding.backendId)) {
        return sendUnsupportedBackend(res, binding.backendId);
      }
      const runtime = getBackendRuntime(binding.backendId);
      if (!runtime?.getSession) {
        return sendUnsupportedBackend(res, binding.backendId);
      }

      const payload = await runtime.getSession({
        sessionID: binding.backendSessionId,
        directory: parseDirectory(req, binding.directory),
      });
      if (!payload) {
        return res.status(404).json({ error: 'Session not found' });
      }
      return res.status(200).json(toHarnessSession(sessionBindingsRuntime.annotateSession(payload), binding.backendId));
    } catch (error) {
      console.error('Failed to read harness session:', error);
      const message = error?.body?.error || error?.message || 'Failed to read session';
      return res.status(400).json({ error: message });
    }
  });

  app.get('/api/openchamber/harness/session/:sessionId/messages', async (req, res) => {
    try {
      const sessionId = typeof req.params?.sessionId === 'string' ? req.params.sessionId : '';
      const binding = await getBoundBackend(sessionId);
      if (!binding) {
        return res.status(404).json({ error: 'Session not found' });
      }
      if (!backendRegistry.isBackendSelectable(binding.backendId)) {
        return sendUnsupportedBackend(res, binding.backendId);
      }
      const runtime = getBackendRuntime(binding.backendId);
      if (!runtime?.getMessages) {
        return sendUnsupportedBackend(res, binding.backendId);
      }

      const payload = await runtime.getMessages({
        sessionID: binding.backendSessionId,
        directory: parseDirectory(req, binding.directory),
        limit: parsePositiveNumber(req.query?.limit),
        before: typeof req.query?.before === 'string' ? req.query.before : undefined,
      });
      return res.status(200).json(Array.isArray(payload) ? payload.map((record) => toHarnessMessageRecord(record, binding.backendId)) : []);
    } catch (error) {
      console.error('Failed to read harness session messages:', error);
      const message = error?.body?.error || error?.message || 'Failed to read session messages';
      return res.status(400).json({ error: message });
    }
  });

  app.post('/api/openchamber/harness/session', async (req, res) => {
    try {
      const backendId = await getRequestedBackendId(req);
      if (!backendRegistry.isBackendSelectable(backendId)) {
        return sendUnsupportedBackend(res, backendId);
      }
      const runtime = getBackendRuntime(backendId);
      if (!runtime?.createSession) {
        return sendUnsupportedBackend(res, backendId);
      }

      const payload = await runtime.createSession({
        directory: typeof req.body?.directory === 'string' ? req.body.directory : undefined,
        title: typeof req.body?.title === 'string' ? req.body.title : undefined,
        parentID: getParentSessionId(req.body),
      });

      if (payload?.id) {
        await sessionBindingsRuntime.upsertBinding({
          sessionId: payload.id,
          backendId,
          backendSessionId: payload.id,
          directory: typeof payload.directory === 'string' ? payload.directory : null,
        });
      }

      return res.status(200).json(toHarnessSession(sessionBindingsRuntime.annotateSession(payload), backendId));
    } catch (error) {
      console.error('Failed to create harness session:', error);
      const message = error?.body?.error || error?.message || 'Failed to create session';
      return res.status(400).json({ error: message });
    }
  });

  app.post('/api/openchamber/harness/session/:sessionId/message', async (req, res) => {
    try {
      const sessionId = typeof req.params?.sessionId === 'string' ? req.params.sessionId : '';
      const binding = await getBoundBackend(sessionId);
      if (!binding) {
        return res.status(404).json({ error: 'Session not found' });
      }
      if (!backendRegistry.isBackendSelectable(binding.backendId)) {
        return sendUnsupportedBackend(res, binding.backendId);
      }
      const runtime = getBackendRuntime(binding.backendId);
      if (!runtime?.promptAsync) {
        return sendUnsupportedBackend(res, binding.backendId);
      }

      await runtime.promptAsync({
        sessionID: binding.backendSessionId,
        directory: typeof req.body?.directory === 'string' ? req.body.directory : binding.directory,
        messageID: getMessageId(req.body),
        model: req.body?.model ?? toRuntimeModel(req.body?.runConfig),
        agent: typeof req.body?.agent === 'string' ? req.body.agent : req.body?.runConfig?.interactionMode,
        variant: typeof req.body?.variant === 'string' ? req.body.variant : getRunConfigOption(req.body?.runConfig, 'variant') ?? getRunConfigOption(req.body?.runConfig, 'effort'),
        format: req.body?.format,
        parts: Array.isArray(req.body?.parts) ? req.body.parts : undefined,
        sandboxOverride: typeof req.body?.sandboxOverride === 'string' ? req.body.sandboxOverride : undefined,
      });

      return res.status(204).end();
    } catch (error) {
      console.error('Failed to send harness message:', error);
      const message = error?.body?.error || error?.message || 'Failed to send message';
      return res.status(400).json({ error: message });
    }
  });

  app.post('/api/openchamber/harness/session/:sessionId/prompt', async (req, res) => {
    try {
      const sessionId = typeof req.params?.sessionId === 'string' ? req.params.sessionId : '';
      const binding = await getBoundBackend(sessionId);
      if (!binding) {
        return res.status(404).json({ error: 'Session not found' });
      }
      if (!backendRegistry.isBackendSelectable(binding.backendId)) {
        return sendUnsupportedBackend(res, binding.backendId);
      }
      const runtime = getBackendRuntime(binding.backendId);
      if (!runtime?.prompt) {
        return sendUnsupportedBackend(res, binding.backendId);
      }

      const payload = await runtime.prompt({
        sessionID: binding.backendSessionId,
        directory: typeof req.body?.directory === 'string' ? req.body.directory : binding.directory,
        messageID: getMessageId(req.body),
        model: req.body?.model ?? toRuntimeModel(req.body?.runConfig),
        agent: typeof req.body?.agent === 'string' ? req.body.agent : req.body?.runConfig?.interactionMode,
        variant: typeof req.body?.variant === 'string' ? req.body.variant : getRunConfigOption(req.body?.runConfig, 'variant') ?? getRunConfigOption(req.body?.runConfig, 'effort'),
        format: req.body?.format,
        parts: Array.isArray(req.body?.parts) ? req.body.parts : undefined,
      });

      return res.status(200).json(payload ?? {});
    } catch (error) {
      console.error('Failed to prompt harness session:', error);
      const message = error?.body?.error || error?.message || 'Failed to prompt session';
      return res.status(400).json({ error: message });
    }
  });

  app.post('/api/openchamber/harness/session/:sessionId/command', async (req, res) => {
    try {
      const sessionId = typeof req.params?.sessionId === 'string' ? req.params.sessionId : '';
      const binding = await getBoundBackend(sessionId);
      if (!binding) {
        return res.status(404).json({ error: 'Session not found' });
      }
      if (!backendRegistry.isBackendSelectable(binding.backendId)) {
        return sendUnsupportedBackend(res, binding.backendId);
      }
      const runtime = getBackendRuntime(binding.backendId);
      if (!runtime?.command) {
        return sendUnsupportedBackend(res, binding.backendId);
      }

      const payload = await runtime.command({
        sessionID: binding.backendSessionId,
        directory: typeof req.body?.directory === 'string' ? req.body.directory : binding.directory,
        messageID: getMessageId(req.body),
        model: typeof req.body?.model === 'string' ? req.body.model : toRuntimeModel(req.body?.runConfig),
        agent: typeof req.body?.agent === 'string' ? req.body.agent : req.body?.runConfig?.interactionMode,
        command: typeof req.body?.command === 'string' ? req.body.command : (typeof req.body?.commandId === 'string' ? req.body.commandId : ''),
        arguments: typeof req.body?.arguments === 'string' ? req.body.arguments : '',
        variant: typeof req.body?.variant === 'string' ? req.body.variant : getRunConfigOption(req.body?.runConfig, 'variant') ?? getRunConfigOption(req.body?.runConfig, 'effort'),
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
      const binding = await getBoundBackend(sessionId);
      if (!binding) {
        return res.status(404).json({ error: 'Session not found' });
      }
      if (!backendRegistry.isBackendSelectable(binding.backendId)) {
        return sendUnsupportedBackend(res, binding.backendId);
      }
      const runtime = getBackendRuntime(binding.backendId);
      if (!runtime?.abortSession) {
        return sendUnsupportedBackend(res, binding.backendId);
      }

      const ok = await runtime.abortSession({
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

  app.post('/api/openchamber/harness/session/:sessionId/revert', async (req, res) => {
    try {
      const sessionId = typeof req.params?.sessionId === 'string' ? req.params.sessionId : '';
      const binding = await getBoundBackend(sessionId);
      if (!binding) {
        return res.status(404).json({ error: 'Session not found' });
      }
      if (!backendRegistry.isBackendSelectable(binding.backendId)) {
        return sendUnsupportedBackend(res, binding.backendId);
      }
      const runtime = getBackendRuntime(binding.backendId);
      if (!runtime?.revertSession) {
        return sendUnsupportedBackend(res, binding.backendId);
      }

      const messageID = typeof req.body?.messageId === 'string'
        ? req.body.messageId
        : (typeof req.body?.messageID === 'string' ? req.body.messageID : '');
      if (!messageID) {
        return res.status(400).json({ error: 'Message ID is required' });
      }

      const payload = await runtime.revertSession({
        sessionID: binding.backendSessionId,
        directory: typeof req.body?.directory === 'string' ? req.body.directory : binding.directory,
        messageID,
        partID: typeof req.body?.partId === 'string'
          ? req.body.partId
          : (typeof req.body?.partID === 'string' ? req.body.partID : undefined),
      });

      return res.status(200).json(toHarnessSession(sessionBindingsRuntime.annotateSession(payload), binding.backendId));
    } catch (error) {
      console.error('Failed to revert harness session:', error);
      const message = error?.body?.error || error?.message || 'Failed to revert session';
      return res.status(400).json({ error: message });
    }
  });

  app.post('/api/openchamber/harness/session/:sessionId/unrevert', async (req, res) => {
    try {
      const sessionId = typeof req.params?.sessionId === 'string' ? req.params.sessionId : '';
      const binding = await getBoundBackend(sessionId);
      if (!binding) {
        return res.status(404).json({ error: 'Session not found' });
      }
      if (!backendRegistry.isBackendSelectable(binding.backendId)) {
        return sendUnsupportedBackend(res, binding.backendId);
      }
      const runtime = getBackendRuntime(binding.backendId);
      if (!runtime?.unrevertSession) {
        return sendUnsupportedBackend(res, binding.backendId);
      }

      const payload = await runtime.unrevertSession({
        sessionID: binding.backendSessionId,
        directory: typeof req.body?.directory === 'string' ? req.body.directory : binding.directory,
      });

      return res.status(200).json(toHarnessSession(sessionBindingsRuntime.annotateSession(payload), binding.backendId));
    } catch (error) {
      console.error('Failed to unrevert harness session:', error);
      const message = error?.body?.error || error?.message || 'Failed to unrevert session';
      return res.status(400).json({ error: message });
    }
  });

  app.post('/api/openchamber/harness/session/:sessionId/update', async (req, res) => {
    try {
      const sessionId = typeof req.params?.sessionId === 'string' ? req.params.sessionId : '';
      const binding = await getBoundBackend(sessionId);
      if (!binding) {
        return res.status(404).json({ error: 'Session not found' });
      }
      if (!backendRegistry.isBackendSelectable(binding.backendId)) {
        return sendUnsupportedBackend(res, binding.backendId);
      }
      const runtime = getBackendRuntime(binding.backendId);
      if (!runtime?.updateSession) {
        return sendUnsupportedBackend(res, binding.backendId);
      }

      const payload = await runtime.updateSession({
        sessionID: binding.backendSessionId,
        directory: typeof req.body?.directory === 'string' ? req.body.directory : binding.directory,
        title: typeof req.body?.title === 'string' ? req.body.title : undefined,
        time: req.body?.time && typeof req.body.time === 'object' ? req.body.time : undefined,
      });

      return res.status(200).json(toHarnessSession(sessionBindingsRuntime.annotateSession(payload), binding.backendId));
    } catch (error) {
      console.error('Failed to update harness session:', error);
      const message = error?.body?.error || error?.message || 'Failed to update session';
      return res.status(400).json({ error: message });
    }
  });

  app.delete('/api/openchamber/harness/session/:sessionId', async (req, res) => {
    try {
      const sessionId = typeof req.params?.sessionId === 'string' ? req.params.sessionId : '';
      const binding = await getBoundBackend(sessionId);
      if (!binding) {
        return res.status(404).json({ error: 'Session not found' });
      }
      const descriptor = backendRegistry.getBackend(binding.backendId);
      if (!descriptor?.capabilities?.delete || !backendRegistry.isBackendSelectable(binding.backendId)) {
        return sendUnsupportedBackend(res, binding.backendId);
      }
      const runtime = getBackendRuntime(binding.backendId);
      if (!runtime?.deleteSession) {
        return sendUnsupportedBackend(res, binding.backendId);
      }

      const ok = await runtime.deleteSession({
        sessionID: binding.backendSessionId,
        directory: typeof req.body?.directory === 'string' ? req.body.directory : binding.directory,
      });

      return res.status(200).json({ ok: Boolean(ok) });
    } catch (error) {
      console.error('Failed to delete harness session:', error);
      const message = error?.body?.error || error?.message || 'Failed to delete session';
      return res.status(400).json({ error: message });
    }
  });

  app.post('/api/openchamber/harness/session/:sessionId/fork', async (req, res) => {
    try {
      const sessionId = typeof req.params?.sessionId === 'string' ? req.params.sessionId : '';
      const binding = await getBoundBackend(sessionId);
      if (!binding) {
        return res.status(404).json({ error: 'Session not found' });
      }
      if (!backendRegistry.isBackendSelectable(binding.backendId)) {
        return sendUnsupportedBackend(res, binding.backendId);
      }
      const runtime = getBackendRuntime(binding.backendId);
      if (!runtime?.forkSession) {
        return sendUnsupportedBackend(res, binding.backendId);
      }

      const payload = await runtime.forkSession({
        sessionID: binding.backendSessionId,
        directory: typeof req.body?.directory === 'string' ? req.body.directory : binding.directory,
        messageID: getMessageId(req.body),
      });

      if (payload?.id) {
        await sessionBindingsRuntime.upsertBinding({
          sessionId: payload.id,
          backendId: binding.backendId,
          backendSessionId: payload.id,
          directory: typeof payload.directory === 'string' ? payload.directory : binding.directory ?? null,
        });
      }

      return res.status(200).json(toHarnessSession(sessionBindingsRuntime.annotateSession(payload), binding.backendId));
    } catch (error) {
      console.error('Failed to fork harness session:', error);
      const message = error?.body?.error || error?.message || 'Failed to fork session';
      return res.status(400).json({ error: message });
    }
  });

  app.post('/api/openchamber/harness/session/:sessionId/share', async (req, res) => {
    try {
      const sessionId = typeof req.params?.sessionId === 'string' ? req.params.sessionId : '';
      const binding = await getBoundBackend(sessionId);
      if (!binding) {
        return res.status(404).json({ error: 'Session not found' });
      }
      const descriptor = backendRegistry.getBackend(binding.backendId);
      if (!descriptor?.capabilities?.share || !backendRegistry.isBackendSelectable(binding.backendId)) {
        return sendUnsupportedBackend(res, binding.backendId);
      }
      const runtime = getBackendRuntime(binding.backendId);
      if (!runtime?.shareSession) {
        return sendUnsupportedBackend(res, binding.backendId);
      }

      const payload = await runtime.shareSession({
        sessionID: binding.backendSessionId,
        directory: typeof req.body?.directory === 'string' ? req.body.directory : binding.directory,
      });

      return res.status(200).json(toHarnessSession(sessionBindingsRuntime.annotateSession(payload), binding.backendId));
    } catch (error) {
      console.error('Failed to share harness session:', error);
      const message = error?.body?.error || error?.message || 'Failed to share session';
      return res.status(400).json({ error: message });
    }
  });

  app.post('/api/openchamber/harness/session/:sessionId/unshare', async (req, res) => {
    try {
      const sessionId = typeof req.params?.sessionId === 'string' ? req.params.sessionId : '';
      const binding = await getBoundBackend(sessionId);
      if (!binding) {
        return res.status(404).json({ error: 'Session not found' });
      }
      const descriptor = backendRegistry.getBackend(binding.backendId);
      if (!descriptor?.capabilities?.share || !backendRegistry.isBackendSelectable(binding.backendId)) {
        return sendUnsupportedBackend(res, binding.backendId);
      }
      const runtime = getBackendRuntime(binding.backendId);
      if (!runtime?.unshareSession) {
        return sendUnsupportedBackend(res, binding.backendId);
      }

      const payload = await runtime.unshareSession({
        sessionID: binding.backendSessionId,
        directory: typeof req.body?.directory === 'string' ? req.body.directory : binding.directory,
      });

      return res.status(200).json(toHarnessSession(sessionBindingsRuntime.annotateSession(payload), binding.backendId));
    } catch (error) {
      console.error('Failed to unshare harness session:', error);
      const message = error?.body?.error || error?.message || 'Failed to unshare session';
      return res.status(400).json({ error: message });
    }
  });

  app.post('/api/openchamber/harness/session/:sessionId/blocking-request/:requestId/reply', async (req, res) => {
    try {
      const sessionId = typeof req.params?.sessionId === 'string' ? req.params.sessionId : '';
      const requestId = typeof req.params?.requestId === 'string' ? req.params.requestId : '';
      const binding = await getBoundBackend(sessionId);
      if (!binding) {
        return res.status(404).json({ error: 'Session not found' });
      }
      const descriptor = backendRegistry.getBackend(binding.backendId);
      if (!descriptor?.capabilities?.approvals || !backendRegistry.isBackendSelectable(binding.backendId)) {
        return sendUnsupportedBackend(res, binding.backendId);
      }
      const runtime = getBackendRuntime(binding.backendId);
      const kind = typeof req.body?.kind === 'string' ? req.body.kind : '';
      const directory = typeof req.body?.directory === 'string' ? req.body.directory : binding.directory;

      if (kind === 'permission') {
        if (!runtime?.replyToPermission) return sendUnsupportedBackend(res, binding.backendId);
        const reply = typeof req.body?.reply === 'string' ? req.body.reply : req.body?.response;
        await runtime.replyToPermission(requestId, reply, { directory, sessionID: binding.backendSessionId });
        return res.status(200).json({ ok: true });
      }
      if (kind === 'question') {
        if (!runtime?.replyToQuestion) return sendUnsupportedBackend(res, binding.backendId);
        const answers = Array.isArray(req.body?.answers) ? req.body.answers : req.body?.response;
        await runtime.replyToQuestion(requestId, answers, { directory, sessionID: binding.backendSessionId });
        return res.status(200).json({ ok: true });
      }
      return res.status(400).json({ error: 'Unsupported blocking request kind' });
    } catch (error) {
      console.error('Failed to reply to harness blocking request:', error);
      const message = error?.body?.error || error?.message || 'Failed to reply to blocking request';
      return res.status(400).json({ error: message });
    }
  });

  app.post('/api/openchamber/harness/session/:sessionId/blocking-request/:requestId/reject', async (req, res) => {
    try {
      const sessionId = typeof req.params?.sessionId === 'string' ? req.params.sessionId : '';
      const requestId = typeof req.params?.requestId === 'string' ? req.params.requestId : '';
      const binding = await getBoundBackend(sessionId);
      if (!binding) {
        return res.status(404).json({ error: 'Session not found' });
      }
      const descriptor = backendRegistry.getBackend(binding.backendId);
      if (!descriptor?.capabilities?.approvals || !backendRegistry.isBackendSelectable(binding.backendId)) {
        return sendUnsupportedBackend(res, binding.backendId);
      }
      const runtime = getBackendRuntime(binding.backendId);
      const kind = typeof req.body?.kind === 'string' ? req.body.kind : '';
      const directory = typeof req.body?.directory === 'string' ? req.body.directory : binding.directory;

      if (kind === 'permission') {
        if (!runtime?.replyToPermission) return sendUnsupportedBackend(res, binding.backendId);
        await runtime.replyToPermission(requestId, 'reject', { directory, sessionID: binding.backendSessionId });
        return res.status(200).json({ ok: true });
      }
      if (kind === 'question') {
        if (!runtime?.rejectQuestion) return sendUnsupportedBackend(res, binding.backendId);
        await runtime.rejectQuestion(requestId, { directory, sessionID: binding.backendSessionId });
        return res.status(200).json({ ok: true });
      }
      return res.status(400).json({ error: 'Unsupported blocking request kind' });
    } catch (error) {
      console.error('Failed to reject harness blocking request:', error);
      const message = error?.body?.error || error?.message || 'Failed to reject blocking request';
      return res.status(400).json({ error: message });
    }
  });

  app.get('/api/openchamber/codex/prompts', async (_req, res) => {
    try {
      const codexHome = process.env.OPENCHAMBER_CODEX_HOME
        || process.env.CODEX_HOME
        || path.join(os.homedir(), '.codex');
      const promptsDir = path.join(codexHome, 'prompts');

      let files;
      try {
        files = await fs.promises.readdir(promptsDir);
      } catch (error) {
        if (error && typeof error === 'object' && error.code === 'ENOENT') {
          return res.json({ prompts: [] });
        }
        throw error;
      }

      const mdFiles = files.filter((f) => f.endsWith('.md'));
      const prompts = await Promise.all(
        mdFiles.map(async (filename) => {
          const filePath = path.join(promptsDir, filename);
          const content = await fs.promises.readFile(filePath, 'utf8');
          const name = filename.replace(/\.md$/, '');
          return { name, content, path: filePath };
        }),
      );

      return res.json({ prompts });
    } catch (error) {
      console.error('Failed to list Codex prompts:', error);
      return res.status(500).json({ error: 'Failed to list Codex prompts' });
    }
  });

  const resolveCodexPromptsDir = () => {
    const codexHome = process.env.OPENCHAMBER_CODEX_HOME
      || process.env.CODEX_HOME
      || path.join(os.homedir(), '.codex');
    return path.join(codexHome, 'prompts');
  };

  const sanitizePromptName = (name) => {
    if (typeof name !== 'string') return null;
    const cleaned = name.trim().replace(/\.md$/i, '').replace(/[/\\]/g, '');
    return cleaned.length > 0 ? cleaned : null;
  };

  const parsePromptFile = (raw) => {
    if (typeof raw !== 'string' || !raw.startsWith('---\n')) {
      return { metadata: {}, body: raw || '' };
    }
    const endIndex = raw.indexOf('\n---\n', 4);
    if (endIndex === -1) {
      return { metadata: {}, body: raw };
    }
    const frontmatter = raw.slice(4, endIndex);
    const body = raw.slice(endIndex + 5);
    const metadata = {};
    for (const line of frontmatter.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const colonIndex = trimmed.indexOf(':');
      if (colonIndex === -1) continue;
      const key = trimmed.slice(0, colonIndex).trim().toLowerCase();
      let value = trimmed.slice(colonIndex + 1).trim();
      if (!value) continue;
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      metadata[key] = value;
    }
    return { metadata, body };
  };

  const buildPromptFile = (metadata, body) => {
    const fmEntries = Object.entries(metadata).filter(([, v]) => typeof v === 'string' && v.trim().length > 0);
    if (fmEntries.length === 0) {
      return body || '';
    }
    const fmLines = fmEntries.map(([key, value]) => `${key}: ${value}`);
    return `---\n${fmLines.join('\n')}\n---\n\n${body || ''}`;
  };

  app.get('/api/openchamber/codex/prompts/:name', async (req, res) => {
    try {
      const name = sanitizePromptName(req.params.name);
      if (!name) return res.status(400).json({ error: 'Invalid prompt name' });
      const filePath = path.join(resolveCodexPromptsDir(), `${name}.md`);
      const raw = await fs.promises.readFile(filePath, 'utf8');
      const { metadata, body } = parsePromptFile(raw);
      return res.json({
        name,
        description: metadata.description || '',
        argumentHint: metadata['argument-hint'] || '',
        template: body.trim(),
        path: filePath,
      });
    } catch (error) {
      if (error?.code === 'ENOENT') return res.status(404).json({ error: 'Prompt not found' });
      return res.status(500).json({ error: 'Failed to read prompt' });
    }
  });

  app.put('/api/openchamber/codex/prompts/:name', async (req, res) => {
    try {
      const name = sanitizePromptName(req.params.name);
      if (!name) return res.status(400).json({ error: 'Invalid prompt name' });

      const promptsDir = resolveCodexPromptsDir();
      await fs.promises.mkdir(promptsDir, { recursive: true });
      const filePath = path.join(promptsDir, `${name}.md`);

      // Accept either structured fields or raw content
      const body = req.body || {};
      let fileContent;
      if (typeof body.template === 'string') {
        const metadata = {};
        if (typeof body.description === 'string' && body.description.trim()) {
          metadata.description = body.description.trim();
        }
        if (typeof body.argumentHint === 'string' && body.argumentHint.trim()) {
          metadata['argument-hint'] = body.argumentHint.trim();
        }
        fileContent = buildPromptFile(metadata, body.template);
      } else {
        fileContent = typeof body.content === 'string' ? body.content : '';
      }

      await fs.promises.writeFile(filePath, fileContent, 'utf8');
      return res.json({ name, path: filePath });
    } catch (error) {
      console.error('Failed to write Codex prompt:', error);
      return res.status(500).json({ error: 'Failed to save prompt' });
    }
  });

  app.delete('/api/openchamber/codex/prompts/:name', async (req, res) => {
    try {
      const name = sanitizePromptName(req.params.name);
      if (!name) return res.status(400).json({ error: 'Invalid prompt name' });
      const filePath = path.join(resolveCodexPromptsDir(), `${name}.md`);
      await fs.promises.unlink(filePath);
      return res.json({ ok: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return res.status(404).json({ error: 'Prompt not found' });
      return res.status(500).json({ error: 'Failed to delete prompt' });
    }
  });

  // ── Codex MCP servers (TOML config) ──────────────────────────────────

  const resolveCodexConfigPath = () => {
    const codexHome = process.env.OPENCHAMBER_CODEX_HOME
      || process.env.CODEX_HOME
      || path.join(os.homedir(), '.codex');
    return path.join(codexHome, 'config.toml');
  };

  const readCodexConfig = async () => {
    try {
      const raw = await fs.promises.readFile(resolveCodexConfigPath(), 'utf8');
      return TOML.parse(raw);
    } catch (error) {
      if (error?.code === 'ENOENT') return {};
      throw error;
    }
  };

  const writeCodexConfig = async (config) => {
    const configPath = resolveCodexConfigPath();
    await fs.promises.mkdir(path.dirname(configPath), { recursive: true });
    await fs.promises.writeFile(configPath, TOML.stringify(config), 'utf8');
  };

  app.get('/api/openchamber/codex/mcp', async (_req, res) => {
    try {
      const config = await readCodexConfig();
      const mcpServers = config.mcp_servers && typeof config.mcp_servers === 'object'
        ? config.mcp_servers
        : {};
      const servers = Object.entries(mcpServers).map(([name, value]) => {
        const server = value && typeof value === 'object' ? value : {};
        return {
          name,
          type: typeof server.url === 'string' ? 'remote' : 'local',
          command: Array.isArray(server.args)
            ? [server.command, ...server.args].filter(Boolean)
            : (typeof server.command === 'string' ? [server.command] : []),
          url: typeof server.url === 'string' ? server.url : undefined,
          environment: server.env && typeof server.env === 'object'
            ? Object.entries(server.env).map(([key, val]) => ({ key, value: String(val) }))
            : [],
          enabled: server.enabled !== false,
          scope: 'user',
        };
      });
      return res.json({ servers });
    } catch (error) {
      console.error('Failed to list Codex MCP servers:', error);
      return res.status(500).json({ error: 'Failed to list Codex MCP servers' });
    }
  });

  app.put('/api/openchamber/codex/mcp/:name', async (req, res) => {
    try {
      const name = typeof req.params.name === 'string' ? req.params.name.trim() : '';
      if (!name) return res.status(400).json({ error: 'Invalid server name' });
      const config = await readCodexConfig();
      if (!config.mcp_servers) config.mcp_servers = {};

      const body = req.body || {};
      const entry = {};
      if (body.type === 'remote' && typeof body.url === 'string') {
        entry.url = body.url;
      } else {
        const cmd = Array.isArray(body.command) ? body.command.filter(Boolean) : [];
        if (cmd.length > 0) {
          entry.command = cmd[0];
          if (cmd.length > 1) entry.args = cmd.slice(1);
        }
      }
      if (Array.isArray(body.environment) && body.environment.length > 0) {
        entry.env = {};
        for (const { key, value } of body.environment) {
          if (typeof key === 'string' && key.trim()) entry.env[key.trim()] = String(value ?? '');
        }
      }
      if (body.enabled === false) entry.enabled = false;

      config.mcp_servers[name] = entry;
      await writeCodexConfig(config);
      return res.json({ ok: true });
    } catch (error) {
      console.error('Failed to save Codex MCP server:', error);
      return res.status(500).json({ error: 'Failed to save Codex MCP server' });
    }
  });

  app.delete('/api/openchamber/codex/mcp/:name', async (req, res) => {
    try {
      const name = typeof req.params.name === 'string' ? req.params.name.trim() : '';
      if (!name) return res.status(400).json({ error: 'Invalid server name' });
      const config = await readCodexConfig();
      if (!config.mcp_servers || !config.mcp_servers[name]) {
        return res.status(404).json({ error: 'Server not found' });
      }
      delete config.mcp_servers[name];
      await writeCodexConfig(config);
      return res.json({ ok: true });
    } catch (error) {
      console.error('Failed to delete Codex MCP server:', error);
      return res.status(500).json({ error: 'Failed to delete Codex MCP server' });
    }
  });

  // ── Codex skills (file-based) ────────────────────────────────────────

  const resolveCodexSkillsDir = () => {
    const codexHome = process.env.OPENCHAMBER_CODEX_HOME
      || process.env.CODEX_HOME
      || path.join(os.homedir(), '.codex');
    return path.join(codexHome, 'skills');
  };

  const resolveCodexSkillSearchPaths = (projectDirectory) => {
    const home = os.homedir();
    const paths = [];
    // Project-scoped paths first
    if (projectDirectory) {
      paths.push({ dir: path.join(projectDirectory, '.codex', 'skills'), source: 'codex', scope: 'project' });
      paths.push({ dir: path.join(projectDirectory, '.agents', 'skills'), source: 'agents', scope: 'project' });
    }
    // User-scoped paths
    paths.push({ dir: resolveCodexSkillsDir(), source: 'codex', scope: 'user' });
    paths.push({ dir: path.join(home, '.agents', 'skills'), source: 'agents', scope: 'user' });
    return paths;
  };

  const parseSkillMd = (raw, fallbackName) => {
    const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
    let name = fallbackName;
    let description = '';
    if (fmMatch) {
      const fmLines = fmMatch[1].split('\n');
      for (const line of fmLines) {
        const nameMatch = line.match(/^name:\s*["']?(.+?)["']?\s*$/);
        const descMatch = line.match(/^description:\s*["']?(.+?)["']?\s*$/);
        if (nameMatch) name = nameMatch[1];
        if (descMatch) description = descMatch[1];
      }
    }
    const body = fmMatch ? raw.slice(fmMatch[0].length).trim() : raw.trim();
    return { name, description, body };
  };

  app.get('/api/openchamber/codex/skills', async (req, res) => {
    try {
      const projectDirectory = typeof req.query?.directory === 'string' ? req.query.directory.trim() : null;
      const searchPaths = resolveCodexSkillSearchPaths(projectDirectory);
      const skills = [];
      const seen = new Set();

      for (const { dir, source, scope } of searchPaths) {
        let entries;
        try {
          entries = await fs.promises.readdir(dir, { withFileTypes: true });
        } catch (error) {
          if (error?.code === 'ENOENT') continue;
          throw error;
        }

        for (const entry of entries) {
          if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
          if (seen.has(entry.name)) continue;
          const skillDir = path.join(dir, entry.name);
          const skillMdPath = path.join(skillDir, 'SKILL.md');
          try {
            const raw = await fs.promises.readFile(skillMdPath, 'utf8');
            const parsed = parseSkillMd(raw, entry.name);
            seen.add(entry.name);
            // Infer group from parent directory structure (e.g., "domain/skill-name")
            const parentDir = path.basename(path.dirname(skillDir));
            const isInSubfolder = parentDir !== 'skills' && parentDir !== '.codex' && parentDir !== '.agents';
            skills.push({
              name: parsed.name,
              description: parsed.description,
              path: skillDir,
              source,
              scope,
              group: isInSubfolder ? parentDir : undefined,
              content: parsed.body,
            });
          } catch {
            // Skip skills without SKILL.md
          }
        }
      }
      return res.json({ skills });
    } catch (error) {
      console.error('Failed to list Codex skills:', error);
      return res.status(500).json({ error: 'Failed to list Codex skills' });
    }
  });

  app.get('/api/openchamber/codex/skills/:name', async (req, res) => {
    try {
      const name = typeof req.params.name === 'string' ? req.params.name.trim().replace(/[/\\]/g, '') : '';
      if (!name) return res.status(400).json({ error: 'Invalid skill name' });
      // Search across all Codex skill paths
      for (const { dir, source } of resolveCodexSkillSearchPaths()) {
        const skillMdPath = path.join(dir, name, 'SKILL.md');
        try {
          const content = await fs.promises.readFile(skillMdPath, 'utf8');
          return res.json({ name, content, source, path: path.dirname(skillMdPath) });
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
      }
      return res.status(404).json({ error: 'Skill not found' });
    } catch (error) {
      return res.status(500).json({ error: 'Failed to read skill' });
    }
  });

  app.put('/api/openchamber/codex/skills/:name', async (req, res) => {
    try {
      const name = typeof req.params.name === 'string' ? req.params.name.trim().replace(/[/\\]/g, '') : '';
      if (!name) return res.status(400).json({ error: 'Invalid skill name' });
      const content = typeof req.body?.content === 'string' ? req.body.content : '';
      const skillDir = path.join(resolveCodexSkillsDir(), name);
      await fs.promises.mkdir(skillDir, { recursive: true });
      await fs.promises.writeFile(path.join(skillDir, 'SKILL.md'), content, 'utf8');
      return res.json({ name, content, path: skillDir });
    } catch (error) {
      console.error('Failed to write Codex skill:', error);
      return res.status(500).json({ error: 'Failed to save skill' });
    }
  });

  app.delete('/api/openchamber/codex/skills/:name', async (req, res) => {
    try {
      const name = typeof req.params.name === 'string' ? req.params.name.trim().replace(/[/\\]/g, '') : '';
      if (!name) return res.status(400).json({ error: 'Invalid skill name' });
      const skillDir = path.join(resolveCodexSkillsDir(), name);
      await fs.promises.rm(skillDir, { recursive: true, force: true });
      return res.json({ ok: true });
    } catch (error) {
      return res.status(500).json({ error: 'Failed to delete skill' });
    }
  });
};
