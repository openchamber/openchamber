import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';

export const createOpenCodeLifecycleRuntime = (deps) => {
  const {
    state,
    env,
    syncToHmrState,
    syncFromHmrState,
    getOpenCodeAuthHeaders,
    buildOpenCodeUrl,
    waitForReady,
    normalizeApiPrefix,
    applyOpencodeBinaryFromSettings,
    ensureOpencodeCliEnv,
    ensureLocalOpenCodeServerPassword,
    buildWslExecArgs,
    resolveWslExecutablePath,
    resolveManagedOpenCodeLaunchSpec,
    setOpenCodePort,
    setDetectedOpenCodeApiPrefix,
    setupProxy,
    ensureOpenCodeApiPrefix,
    clearResolvedOpenCodeBinary,
    buildAugmentedPath,
    buildManagedOpenCodePath,
    getManagedOpenCodeShellEnvSnapshot,
  } = deps;

  const killProcessOnPort = (port) => {
    if (!port || process.platform === 'win32') return;
    try {
      const result = spawnSync('lsof', ['-ti', `:${port}`], { encoding: 'utf8', timeout: 5000, windowsHide: true });
      const output = result.stdout || '';
      const myPid = process.pid;
      for (const pidStr of output.split(/\s+/)) {
        const pid = parseInt(pidStr.trim(), 10);
        if (pid && pid !== myPid) {
          try {
            spawnSync('kill', ['-9', String(pid)], { stdio: 'ignore', timeout: 2000 });
          } catch {
          }
        }
      }
    } catch {
    }
  };

  const hasChildProcessExited = (child) => !child || child.exitCode !== null || child.signalCode !== null;

  const waitForChildProcessClose = (child, timeoutMs) => new Promise((resolve) => {
    if (!child || hasChildProcessExited(child)) {
      resolve(true);
      return;
    }

    let done = false;
    const finish = (closed) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.off('close', onClose);
      child.off('error', onError);
      resolve(closed);
    };

    const onClose = () => finish(true);
    const onError = () => finish(hasChildProcessExited(child));
    const timer = setTimeout(() => finish(hasChildProcessExited(child)), timeoutMs);

    child.once('close', onClose);
    child.once('error', onError);
  });

  const waitForPortRelease = (port, timeoutMs, hostname = env.ENV_CONFIGURED_OPENCODE_HOSTNAME) => {
    if (!port) {
      return Promise.resolve(true);
    }

    const probeHost = !hostname || hostname === '0.0.0.0' || hostname === '::' || hostname === '[::]'
      ? '127.0.0.1'
      : hostname;
    const deadline = Date.now() + timeoutMs;

    return new Promise((resolve) => {
      const attempt = () => {
        const socket = net.connect({ port, host: probeHost });
        let settled = false;

        const finish = (released) => {
          if (settled) return;
          settled = true;
          socket.removeAllListeners();
          socket.destroy();
          if (released || Date.now() >= deadline) {
            resolve(released);
            return;
          }
          setTimeout(attempt, 150);
        };

        socket.once('connect', () => finish(false));
        socket.once('timeout', () => finish(true));
        socket.once('error', (error) => {
          if (error && typeof error === 'object' && (error.code === 'ECONNREFUSED' || error.code === 'EHOSTUNREACH')) {
            finish(true);
            return;
          }
          finish(false);
        });
        socket.setTimeout(500);
      };

      attempt();
    });
  };

  const closeManagedOpenCodeChild = async (child) => {
    if (!child) {
      return;
    }

    const pid = child.pid;
    if (!pid || hasChildProcessExited(child)) {
      await waitForChildProcessClose(child, 250);
      return;
    }

    if (process.platform === 'win32') {
      try {
        child.kill();
      } catch {
      }

      if (await waitForChildProcessClose(child, 800)) {
        return;
      }

      try {
        spawnSync('taskkill', ['/pid', String(pid), '/t'], {
          stdio: 'ignore',
          timeout: 3000,
          windowsHide: true,
        });
      } catch {
      }

      if (await waitForChildProcessClose(child, 1500)) {
        return;
      }

      try {
        spawnSync('taskkill', ['/pid', String(pid), '/f', '/t'], {
          stdio: 'ignore',
          timeout: 5000,
          windowsHide: true,
        });
      } catch {
      }

      await waitForChildProcessClose(child, 3000);
      return;
    }

    try {
      child.kill('SIGTERM');
    } catch {
    }

    if (await waitForChildProcessClose(child, 2500)) {
      return;
    }

    try {
      child.kill('SIGKILL');
    } catch {
    }

    await waitForChildProcessClose(child, 1000);
  };

  const formatCapturedOutput = ({ stdout, stderr }) => {
    const parts = [];
    if (stdout.trim()) {
      parts.push(`stdout:\n${stdout.trim()}`);
    }
    if (stderr.trim()) {
      parts.push(`stderr:\n${stderr.trim()}`);
    }
    return parts.length > 0 ? parts.join('\n\n') : 'No stdout/stderr captured';
  };

  const createManagedOpenCodeServerProcess = async ({ hostname, port, timeout, cwd, env: processEnv, shellEnvKeysCount = 0 }) => {
    let binary = (process.env.OPENCODE_BINARY || 'opencode').trim() || 'opencode';
    let args = ['serve', '--hostname', hostname, '--port', String(port)];
    let launchWrapperType = null;

    if (process.platform === 'win32' && state.useWslForOpencode) {
      const wslBinary = state.resolvedWslBinary || resolveWslExecutablePath();
      if (!wslBinary) {
        throw new Error('WSL executable not found while attempting to launch OpenCode from WSL');
      }

      const wslOpencode = state.resolvedWslOpencodePath && state.resolvedWslOpencodePath.trim().length > 0
        ? state.resolvedWslOpencodePath.trim()
        : 'opencode';
      const serveHost = hostname === '127.0.0.1' ? '0.0.0.0' : hostname;

      binary = wslBinary;
      args = buildWslExecArgs([
        wslOpencode,
        'serve',
        '--hostname',
        serveHost,
        '--port',
        String(port),
      ], state.resolvedWslDistro);
    }

    if (process.platform === 'win32' && !state.useWslForOpencode) {
      const launchSpec = resolveManagedOpenCodeLaunchSpec(binary);
      if (launchSpec?.binary) {
        if (launchSpec.wrapperType) {
          console.log(`Launching OpenCode via ${launchSpec.wrapperType}: ${launchSpec.binary}`);
        }
        launchWrapperType = launchSpec.wrapperType || null;
        binary = launchSpec.binary;
        args = [...(Array.isArray(launchSpec.args) ? launchSpec.args : []), ...args];
      }
    }

    const pathValue = typeof processEnv?.PATH === 'string' ? processEnv.PATH : '';
    const pathEntryCount = pathValue ? pathValue.split(process.platform === 'win32' ? ';' : ':').filter(Boolean).length : 0;
    state.lastOpenCodeLaunchDiagnostics = {
      launchedAt: new Date().toISOString(),
      binary,
      args,
      cwd,
      hostname,
      port,
      wrapperType: launchWrapperType,
      pathEntryCount,
      hasShellEnv: shellEnvKeysCount > 0,
      shellEnvKeysCount,
    };
    console.log('[OpenCode] Launching managed server', state.lastOpenCodeLaunchDiagnostics);

    const child = spawn(binary, args, {
      cwd,
      env: processEnv,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const url = await new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let done = false;
      const finish = (handler, value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        child.stdout?.off('data', onStdout);
        child.stderr?.off('data', onStderr);
        child.off('exit', onExit);
        child.off('error', onError);
        handler(value);
      };

      const onStdout = (chunk) => {
        stdout += chunk.toString();
        const lines = stdout.split('\n');
        for (const line of lines) {
          if (!line.startsWith('opencode server listening')) continue;
          const match = line.match(/on\s+(https?:\/\/[^\s]+)/);
          if (!match) {
            finish(reject, new Error(`Failed to parse server url from output: ${line}`));
            return;
          }
          finish(resolve, match[1]);
          return;
        }
      };

      const onStderr = (chunk) => {
        stderr += chunk.toString();
      };

      const onExit = (code, signal) => {
        const reason = signal ? `signal ${signal}` : `code ${code}`;
        finish(reject, new Error(`OpenCode exited with ${reason}. ${formatCapturedOutput({ stdout, stderr })}`));
      };

      const onError = (error) => {
        finish(reject, error);
      };

      const timer = setTimeout(() => {
        finish(reject, new Error(`Timeout waiting for OpenCode to start after ${timeout}ms`));
      }, timeout);

      child.stdout?.on('data', onStdout);
      child.stderr?.on('data', onStderr);
      child.on('exit', onExit);
      child.on('error', onError);
    });

    return {
      url,
      async close() {
        await closeManagedOpenCodeChild(child);
      },
    };
  };

  const resolveManagedOpenCodePort = async (requestedPort, hostname = '127.0.0.1') => {
    if (typeof requestedPort === 'number' && Number.isFinite(requestedPort) && requestedPort > 0) {
      return requestedPort;
    }

    return await new Promise((resolve, reject) => {
      const server = net.createServer();
      const cleanup = () => {
        server.removeAllListeners('error');
        server.removeAllListeners('listening');
      };

      server.once('error', (error) => {
        cleanup();
        reject(error);
      });

      server.once('listening', () => {
        const address = server.address();
        const port = address && typeof address === 'object' ? address.port : 0;
        server.close(() => {
          cleanup();
          if (port > 0) {
            resolve(port);
            return;
          }
          reject(new Error('Failed to allocate OpenCode port'));
        });
      });

      server.listen(0, hostname);
    });
  };

  const isOpenCodeProcessHealthy = async () => {
    if (!state.openCodeProcess || !state.openCodePort) {
      return false;
    }

    try {
      const response = await fetch(buildOpenCodeUrl('/global/health', ''), {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          ...getOpenCodeAuthHeaders(),
        },
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) return false;
      const body = await response.json().catch(() => null);
      return body?.healthy === true;
    } catch {
      return false;
    }
  };

  const probeExternalOpenCode = async (port, origin) => {
    if (!port || port <= 0) {
      return false;
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      const base = origin ?? `http://127.0.0.1:${port}`;
      const response = await fetch(`${base}/global/health`, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          ...getOpenCodeAuthHeaders(),
        },
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!response.ok) return false;
      const body = await response.json().catch(() => null);
      return body?.healthy === true;
    } catch {
      return false;
    }
  };

  const waitForOpenCodePort = async (timeoutMs = 15000) => {
    if (state.openCodePort !== null) {
      return state.openCodePort;
    }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (state.openCodePort !== null) {
        return state.openCodePort;
      }
    }

    throw new Error('Timed out waiting for OpenCode port');
  };

  const START_OPEN_CODE_MAX_ATTEMPTS = 2;

  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const startOpenCodeOnce = async () => {
    const desiredPort = env.ENV_CONFIGURED_OPENCODE_PORT ?? 0;
    const spawnPort = await resolveManagedOpenCodePort(desiredPort, env.ENV_CONFIGURED_OPENCODE_HOSTNAME);
    console.log(
      desiredPort > 0
        ? `Starting OpenCode on requested port ${desiredPort}...`
        : `Starting OpenCode on allocated port ${spawnPort}...`
    );

    await applyOpencodeBinaryFromSettings();
    ensureOpencodeCliEnv();
    const openCodePassword = await ensureLocalOpenCodeServerPassword({ rotateManaged: true });
    const envPath = typeof buildManagedOpenCodePath === 'function'
      ? buildManagedOpenCodePath()
      : typeof buildAugmentedPath === 'function'
        ? buildAugmentedPath()
      : process.env.PATH;
    const shellEnv = typeof getManagedOpenCodeShellEnvSnapshot === 'function'
      ? getManagedOpenCodeShellEnvSnapshot() || {}
      : {};

    try {
      const serverInstance = await createManagedOpenCodeServerProcess({
        hostname: env.ENV_CONFIGURED_OPENCODE_HOSTNAME,
        port: spawnPort,
        timeout: 30000,
        cwd: state.openCodeWorkingDirectory,
        shellEnvKeysCount: Object.keys(shellEnv).length,
        env: {
          ...shellEnv,
          ...process.env,
          PATH: envPath,
          OPENCODE_SERVER_PASSWORD: openCodePassword,
        },
      });

      if (!serverInstance || !serverInstance.url) {
        throw new Error('OpenCode server started but URL is missing');
      }

      const url = new URL(serverInstance.url);
      const port = parseInt(url.port, 10);
      const prefix = normalizeApiPrefix(url.pathname);

      if (await waitForReady(serverInstance.url, 10000)) {
        setOpenCodePort(port);
        setDetectedOpenCodeApiPrefix(prefix);

        state.isOpenCodeReady = true;
        state.lastOpenCodeError = null;
        state.openCodeNotReadySince = 0;

        return serverInstance;
      }

      try {
        await serverInstance.close();
      } catch {
      }
      throw new Error('Server started but health check failed (timeout)');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      state.lastOpenCodeError = message;
      state.openCodePort = null;
      syncToHmrState();
      console.error(`Failed to start OpenCode: ${message}`);
      throw error;
    }
  };

  const startOpenCode = async () => {
    let lastError = null;
    for (let attempt = 1; attempt <= START_OPEN_CODE_MAX_ATTEMPTS; attempt += 1) {
      try {
        return await startOpenCodeOnce();
      } catch (error) {
        lastError = error;
        if (attempt >= START_OPEN_CODE_MAX_ATTEMPTS) {
          break;
        }

        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[OpenCode] Managed server startup failed on attempt ${attempt}/${START_OPEN_CODE_MAX_ATTEMPTS}; retrying: ${message}`);
        state.openCodePort = null;
        state.isOpenCodeReady = false;
        state.openCodeNotReadySince = Date.now();
        syncToHmrState();
        await delay(750 * attempt);
      }
    }

    throw lastError;
  };

  const restartOpenCode = async () => {
    if (state.isShuttingDown) return;
    if (state.currentRestartPromise) {
      await state.currentRestartPromise;
      return;
    }

    state.currentRestartPromise = (async () => {
      state.isRestartingOpenCode = true;
      state.isOpenCodeReady = false;
      state.openCodeNotReadySince = Date.now();
      console.log('Restarting OpenCode process...');

      if (state.isExternalOpenCode) {
        console.log('Re-probing external OpenCode server...');
        const probePort = state.openCodePort || env.ENV_CONFIGURED_OPENCODE_PORT || 4096;
        const probeOrigin = state.openCodeBaseUrl ?? env.ENV_CONFIGURED_OPENCODE_HOST?.origin;
        const healthy = await probeExternalOpenCode(probePort, probeOrigin);
        if (healthy) {
          console.log(`External OpenCode server on port ${probePort} is healthy`);
          setOpenCodePort(probePort);
          state.isOpenCodeReady = true;
          state.lastOpenCodeError = null;
          state.openCodeNotReadySince = 0;
          syncToHmrState();
        } else {
          state.lastOpenCodeError = `External OpenCode server on port ${probePort} is not responding`;
          console.error(state.lastOpenCodeError);
          throw new Error(state.lastOpenCodeError);
        }

        if (state.expressApp) {
          setupProxy(state.expressApp);
          ensureOpenCodeApiPrefix();
        }
        return;
      }

      const portToKill = state.openCodePort;

      if (state.openCodeProcess) {
        console.log('Stopping existing OpenCode process...');
        try {
          await state.openCodeProcess.close();
        } catch (error) {
          console.warn('Error closing OpenCode process:', error);
        }
        state.openCodeProcess = null;
        syncToHmrState();
      }

      killProcessOnPort(portToKill);
      if (!(await waitForPortRelease(portToKill, 5000))) {
        console.warn(`Timed out waiting for OpenCode port ${portToKill} to be released`);
      }

      if (env.ENV_CONFIGURED_OPENCODE_PORT) {
        console.log(`Using OpenCode port from environment: ${env.ENV_CONFIGURED_OPENCODE_PORT}`);
        setOpenCodePort(env.ENV_CONFIGURED_OPENCODE_PORT);
      } else {
        state.openCodePort = null;
        syncToHmrState();
      }

      state.openCodeApiPrefixDetected = true;
      state.openCodeApiPrefix = '';
      if (state.openCodeApiDetectionTimer) {
        clearTimeout(state.openCodeApiDetectionTimer);
        state.openCodeApiDetectionTimer = null;
      }

      state.lastOpenCodeError = null;
      state.openCodeProcess = await startOpenCode();
      syncToHmrState();

      if (state.expressApp) {
        setupProxy(state.expressApp);
        ensureOpenCodeApiPrefix();
      }
    })();

    try {
      await state.currentRestartPromise;
    } catch (error) {
      console.error(`Failed to restart OpenCode: ${error.message}`);
      state.lastOpenCodeError = error.message;
      if (!env.ENV_CONFIGURED_OPENCODE_PORT) {
        state.openCodePort = null;
        syncToHmrState();
      }
      state.openCodeApiPrefixDetected = true;
      state.openCodeApiPrefix = '';
      throw error;
    } finally {
      state.currentRestartPromise = null;
      state.isRestartingOpenCode = false;
    }
  };

  const waitForOpenCodeReady = async (timeoutMs = 20000, intervalMs = 400) => {
    if (!state.openCodePort) {
      throw new Error('OpenCode port is not available');
    }

    const deadline = Date.now() + timeoutMs;
    let lastError = null;

    while (Date.now() < deadline) {
      try {
        const [configResult, agentResult] = await Promise.all([
          fetch(buildOpenCodeUrl('/config', ''), {
            method: 'GET',
            headers: { Accept: 'application/json', ...getOpenCodeAuthHeaders() },
          }).catch((error) => error),
          fetch(buildOpenCodeUrl('/agent', ''), {
            method: 'GET',
            headers: { Accept: 'application/json', ...getOpenCodeAuthHeaders() },
          }).catch((error) => error),
        ]);

        if (configResult instanceof Error) {
          lastError = configResult;
          await new Promise((resolve) => setTimeout(resolve, intervalMs));
          continue;
        }

        if (!configResult.ok) {
          lastError = new Error(`OpenCode config endpoint responded with status ${configResult.status}`);
          await new Promise((resolve) => setTimeout(resolve, intervalMs));
          continue;
        }

        await configResult.json().catch(() => null);

        if (agentResult instanceof Error) {
          lastError = agentResult;
          await new Promise((resolve) => setTimeout(resolve, intervalMs));
          continue;
        }

        if (!agentResult.ok) {
          lastError = new Error(`Agent endpoint responded with status ${agentResult.status}`);
          await new Promise((resolve) => setTimeout(resolve, intervalMs));
          continue;
        }

        await agentResult.json().catch(() => []);

        state.isOpenCodeReady = true;
        state.lastOpenCodeError = null;
        return;
      } catch (error) {
        lastError = error;
      }

      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    if (lastError) {
      state.lastOpenCodeError = lastError.message || String(lastError);
      throw lastError;
    }

    const timeoutError = new Error('Timed out waiting for OpenCode to become ready');
    state.lastOpenCodeError = timeoutError.message;
    throw timeoutError;
  };

  const waitForAgentPresence = async (agentName, timeoutMs = 15000, intervalMs = 300) => {
    if (!state.openCodePort) {
      throw new Error('OpenCode port is not available');
    }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(buildOpenCodeUrl('/agent'), {
          method: 'GET',
          headers: { Accept: 'application/json', ...getOpenCodeAuthHeaders() },
        });

        if (response.ok) {
          const agents = await response.json();
          if (Array.isArray(agents) && agents.some((agent) => agent?.name === agentName)) {
            return;
          }
        }
      } catch {
      }

      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    throw new Error(`Agent "${agentName}" not available after OpenCode restart`);
  };

  const refreshOpenCodeAfterConfigChange = async (reason, options = {}) => {
    const { agentName } = options;

    console.log(`Refreshing OpenCode after ${reason}`);
    clearResolvedOpenCodeBinary();
    await applyOpencodeBinaryFromSettings();

    await restartOpenCode();

    try {
      await waitForOpenCodeReady();
      state.isOpenCodeReady = true;
      state.openCodeNotReadySince = 0;

      if (agentName) {
        await waitForAgentPresence(agentName);
      }

      state.isOpenCodeReady = true;
      state.openCodeNotReadySince = 0;
    } catch (error) {
      state.isOpenCodeReady = false;
      state.openCodeNotReadySince = Date.now();
      console.error(`Failed to refresh OpenCode after ${reason}:`, error.message);
      throw error;
    }
  };

  const bootstrapOpenCodeAtStartup = async () => {
    try {
      syncFromHmrState();
      if (await isOpenCodeProcessHealthy()) {
        console.log(`[HMR] Reusing existing OpenCode process on port ${state.openCodePort}`);
      } else if (env.ENV_SKIP_OPENCODE_START && env.ENV_EFFECTIVE_PORT) {
        const label = env.ENV_CONFIGURED_OPENCODE_HOST ? env.ENV_CONFIGURED_OPENCODE_HOST.origin : `http://localhost:${env.ENV_EFFECTIVE_PORT}`;
        console.log(`Using external OpenCode server at ${label} (skip-start mode)`);
        state.openCodeBaseUrl = env.ENV_CONFIGURED_OPENCODE_HOST?.origin ?? null;
        setOpenCodePort(env.ENV_EFFECTIVE_PORT);
        state.isOpenCodeReady = true;
        state.isExternalOpenCode = true;
        state.lastOpenCodeError = null;
        state.openCodeNotReadySince = 0;
        syncToHmrState();
      } else if (env.ENV_EFFECTIVE_PORT && await probeExternalOpenCode(env.ENV_EFFECTIVE_PORT, env.ENV_CONFIGURED_OPENCODE_HOST?.origin)) {
        const label = env.ENV_CONFIGURED_OPENCODE_HOST ? env.ENV_CONFIGURED_OPENCODE_HOST.origin : `http://localhost:${env.ENV_EFFECTIVE_PORT}`;
        console.log(`Auto-detected existing OpenCode server at ${label}`);
        state.openCodeBaseUrl = env.ENV_CONFIGURED_OPENCODE_HOST?.origin ?? null;
        setOpenCodePort(env.ENV_EFFECTIVE_PORT);
        state.isOpenCodeReady = true;
        state.isExternalOpenCode = true;
        state.lastOpenCodeError = null;
        state.openCodeNotReadySince = 0;
        syncToHmrState();
      } else if (!env.ENV_EFFECTIVE_PORT && await probeExternalOpenCode(4096)) {
        console.log('Auto-detected existing OpenCode server on default port 4096');
        setOpenCodePort(4096);
        state.isOpenCodeReady = true;
        state.isExternalOpenCode = true;
        state.lastOpenCodeError = null;
        state.openCodeNotReadySince = 0;
        syncToHmrState();
      } else {
        if (env.ENV_EFFECTIVE_PORT) {
          console.log(`Using OpenCode port from environment: ${env.ENV_EFFECTIVE_PORT}`);
          setOpenCodePort(env.ENV_EFFECTIVE_PORT);
        } else {
          state.openCodePort = null;
          syncToHmrState();
        }

        state.lastOpenCodeError = null;
        state.openCodeProcess = await startOpenCode();
        syncToHmrState();
      }
      await waitForOpenCodePort();
      try {
        await waitForOpenCodeReady();
      } catch (error) {
        console.error(`OpenCode readiness check failed: ${error.message}`);
      }
    } catch (error) {
      console.error(`Failed to start OpenCode: ${error.message}`);
      console.log('Continuing without OpenCode integration...');
      state.lastOpenCodeError = error.message;
    }
  };

  /**
   * Perform an immediate (one-shot) health check and restart OpenCode if it's
   * not healthy.  Callers on the SSE / WS proxy path use this to trigger
   * recovery without waiting for the next periodic interval (up to 15 s).
   */
  const triggerHealthCheck = async () => {
    if (!state.openCodeProcess || state.isShuttingDown || state.isRestartingOpenCode) return;

    try {
      const healthy = await isOpenCodeProcessHealthy();
      if (!healthy) {
        console.log('[lifecycle] immediate health check: OpenCode not healthy, restarting...');
        await restartOpenCode();
      }
    } catch (error) {
      console.error(`[lifecycle] immediate health check error: ${error.message}`);
    }
  };

  const startHealthMonitoring = (healthCheckIntervalMs) => {
    if (state.healthCheckInterval) {
      clearInterval(state.healthCheckInterval);
    }

    state.healthCheckInterval = setInterval(async () => {
      if (!state.openCodeProcess || state.isShuttingDown || state.isRestartingOpenCode) return;

      try {
        const healthy = await isOpenCodeProcessHealthy();
        if (!healthy) {
          console.log('OpenCode process not running, restarting...');
          await restartOpenCode();
        }
      } catch (error) {
        console.error(`Health check error: ${error.message}`);
      }
    }, healthCheckIntervalMs);
  };

  return {
    killProcessOnPort,
    startOpenCode,
    restartOpenCode,
    waitForOpenCodeReady,
    waitForAgentPresence,
    refreshOpenCodeAfterConfigChange,
    bootstrapOpenCodeAtStartup,
    startHealthMonitoring,
    triggerHealthCheck,
    waitForPortRelease,
  };
};
