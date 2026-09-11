/**
 * Route registration for OpenChamber-managed Docker OpenCode instances.
 *
 * Routes (all behind the shared `/api` auth middleware of the host app):
 * - GET    /api/docker-instances                       list + feature state
 * - GET    /api/docker-instances/:id                   status snapshot (live health probe)
 * - POST   /api/docker-instances                       create (explicit user action)
 * - POST   /api/docker-instances/:id/activate          make active upstream (running only)
 * - POST   /api/docker-instances/deactivate            back to Local/external upstream
 * - POST   /api/docker-instances/:id/:action           start | stop | remove | cleanup
 *
 * The feature toggle gates every mutating route; the list route still answers
 * (with `enabled: false`) so the UI can decide what to render. The manager
 * never touches host OpenCode/OpenChamber config files.
 */

const INSTANCE_ACTIONS = new Set(['start', 'stop', 'remove', 'cleanup']);

const asTrimmedString = (value) => (typeof value === 'string' ? value.trim() : '');

export const registerDockerInstanceRoutes = (app, dependencies) => {
  const {
    manager,
    isFeatureEnabled,
    fsPromises,
    logger = console,
  } = dependencies;

  const guardEnabled = async (req, res) => {
    if (!await isFeatureEnabled()) {
      res.status(403).json({ error: 'Docker instances feature is disabled', code: 'FEATURE_DISABLED' });
      return false;
    }
    void req;
    return true;
  };

  const handleError = (res, error, fallbackMessage) => {
    const code = typeof error?.code === 'string' ? error.code : null;
    const statusByCode = {
      FEATURE_DISABLED: 403,
      NOT_FOUND: 404,
      NOT_CONNECTABLE: 409,
      IMAGE_MISSING: 409,
      INVALID_WORKSPACE: 400,
      INVALID_MOUNTS: 400,
    };
    const status = code && statusByCode[code] ? statusByCode[code] : 500;
    if (status === 500) {
      logger.error?.(`[docker-instances] ${fallbackMessage}:`, error);
    }
    const payload = {
      error: error instanceof Error ? error.message : fallbackMessage,
      code,
    };
    if (error?.currentState) payload.currentState = error.currentState;
    if (error?.canStart !== undefined) payload.canStart = error.canStart;
    if (error?.cleanedUp !== undefined) payload.cleanedUp = error.cleanedUp;
    if (error?.containerLogTail) payload.containerLogTail = error.containerLogTail;
    res.status(status).json(payload);
  };

  app.get('/api/docker-instances', async (_req, res) => {
    try {
      const enabled = await isFeatureEnabled();
      if (!enabled) {
        res.json({ enabled, instances: [], activeInstanceId: null, sharedSkillsHostPath: null });
        return;
      }
      const [instances, activeInstanceId] = await Promise.all([
        manager.listInstances(),
        manager.getActiveInstanceId(),
      ]);
      res.json({
        enabled,
        instances,
        activeInstanceId,
        // Exact host directory the shared-skills mount exposes for writes, so
        // the create dialog can disclose it verbatim before submission.
        sharedSkillsHostPath: dependencies.paths?.skillDir ?? null,
      });
    } catch (error) {
      handleError(res, error, 'Failed to list docker instances');
    }
  });

  app.get('/api/docker-instances/:id', async (req, res) => {
    try {
      if (!await guardEnabled(req, res)) return;
      const status = await manager.getInstanceStatus(req.params.id);
      res.json(status);
    } catch (error) {
      handleError(res, error, 'Failed to read docker instance status');
    }
  });

  app.post('/api/docker-instances', async (req, res) => {
    try {
      if (!await guardEnabled(req, res)) return;
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      // Diagnostics without values: when a create is rejected we log which
      // fields the request carried so field-name/payload mismatches surface
      // instantly. Never log the values themselves.
      const describeBody = () => `[docker-instances] create rejected (body keys: ${Object.keys(body).join(', ') || 'none'})`;
      const workspaceHostPath = asTrimmedString(body.workspaceHostPath);
      if (!workspaceHostPath) {
        logger.warn?.(describeBody());
        res.status(400).json({ error: 'workspaceHostPath is required', code: 'INVALID_WORKSPACE' });
        return;
      }
      let stats;
      try {
        stats = await fsPromises.stat(workspaceHostPath);
      } catch {
        logger.warn?.(describeBody());
        res.status(400).json({ error: `Workspace path does not exist: ${workspaceHostPath}`, code: 'INVALID_WORKSPACE' });
        return;
      }
      if (!stats.isDirectory()) {
        logger.warn?.(describeBody());
        res.status(400).json({ error: `Workspace path is not a directory: ${workspaceHostPath}`, code: 'INVALID_WORKSPACE' });
        return;
      }

      const sharing = body.sharing && typeof body.sharing === 'object' ? body.sharing : {};
      const record = await manager.createInstance({
        label: asTrimmedString(body.label),
        workspaceHostPath,
        sharing: {
          config: sharing.config === true,
          skills: sharing.skills === true,
          credentials: sharing.credentials === true,
          skillsHostDir: asTrimmedString(sharing.skillsHostDir) || undefined,
        },
        image: asTrimmedString(body.image) || undefined,
        port: Number.isSafeInteger(body.port) && body.port > 0 ? body.port : undefined,
        paths: dependencies.paths,
      });
      res.status(201).json(record);
    } catch (error) {
      handleError(res, error, 'Failed to create docker instance');
    }
  });

  app.post('/api/docker-instances/deactivate', async (req, res) => {
    try {
      if (!await guardEnabled(req, res)) return;
      await manager.deactivate();
      res.json({ ok: true });
    } catch (error) {
      handleError(res, error, 'Failed to deactivate docker instance');
    }
  });

  // Explicit, user-initiated image build (create-flow button). Never called
  // automatically; requires the feature toggle.
  app.post('/api/docker-instances/image/build', async (req, res) => {
    try {
      if (!await guardEnabled(req, res)) return;
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const imageName = asTrimmedString(body.imageName) || dependencies.defaultImageName;
      if (!imageName || !dependencies.dockerRuntime || !dependencies.dockerFilePath || !dependencies.dockerContextPath) {
        res.status(500).json({
          error: 'Image build is not available in this installation; build it manually with the shipped docker/opencode-instance/Dockerfile.',
          code: 'BUILD_UNAVAILABLE',
        });
        return;
      }
      const result = await dependencies.dockerRuntime.buildImage({
        imageName,
        dockerfilePath: dependencies.dockerFilePath,
        contextPath: dependencies.dockerContextPath,
      });
      res.json({ ok: true, ...result });
    } catch (error) {
      handleError(res, error, 'Failed to build the instance image');
    }
  });

  // Explicit, user-initiated image pull — the fast first-run path when a
  // prebuilt image exists in a registry. Never called automatically.
  app.post('/api/docker-instances/image/pull', async (req, res) => {
    try {
      if (!await guardEnabled(req, res)) return;
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const imageName = asTrimmedString(body.imageName) || dependencies.defaultImageName;
      if (!imageName || !dependencies.dockerRuntime) {
        res.status(500).json({ error: 'Image pull is not available in this installation.', code: 'PULL_UNAVAILABLE' });
        return;
      }
      const result = await dependencies.dockerRuntime.pullImage({ imageName });
      res.json({ ok: true, ...result });
    } catch (error) {
      handleError(res, error, 'Failed to pull the instance image');
    }
  });

  app.post('/api/docker-instances/:id/activate', async (req, res) => {
    try {
      if (!await guardEnabled(req, res)) return;
      const upstream = await manager.setActiveInstance(req.params.id);
      res.json({ ok: true, active: upstream });
    } catch (error) {
      handleError(res, error, 'Failed to activate docker instance');
    }
  });

  app.post('/api/docker-instances/:id/:action', async (req, res) => {
    try {
      if (!await guardEnabled(req, res)) return;
      const { id, action } = req.params;
      if (!INSTANCE_ACTIONS.has(action)) {
        res.status(404).json({ error: `Unknown action: ${action}`, code: 'UNKNOWN_ACTION' });
        return;
      }
      let result;
      if (action === 'start') result = await manager.startInstance(id);
      else if (action === 'stop') result = await manager.stopInstance(id);
      else if (action === 'remove') result = await manager.removeInstance(id);
      else result = await manager.cleanupInstance(id);
      res.json({ ok: true, instance: result ?? null });
    } catch (error) {
      handleError(res, error, `Failed to run docker instance action: ${req.params.action}`);
    }
  });
};
