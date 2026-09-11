/**
 * Docker CLI runtime for OpenChamber-managed OpenCode instance containers.
 *
 * Wraps the `docker` CLI instead of a socket client: no new dependency, no
 * direct socket handling, and every command is trivially mockable for tests.
 * All commands run argument-array based (never through a shell) with a hard
 * timeout, so Windows path quoting stays in `child_process`' hands and a hung
 * daemon can never wedge the server.
 *
 * The runtime only ever addresses containers OpenChamber created itself:
 * callers filter by the `openchamber.instance` label, and nothing in this
 * module accepts an unscoped "modify everything" call.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const OPENCHAMBER_INSTANCE_LABEL = 'openchamber.instance';

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;

const DEFAULT_EXEC_FILE = promisify(execFile);

const buildError = (message, { stderr, code } = {}) => {
  const error = new Error(message);
  error.code = code;
  error.stderr = typeof stderr === 'string' ? stderr.slice(-2000) : '';
  return error;
};

/**
 * Creates a Docker runtime bound to the `docker` CLI.
 *
 * @param {object} [options]
 * @param {string} [options.dockerPath] - docker binary to execute (default `docker` on PATH).
 * @param {number} [options.commandTimeoutMs] - per-command hard timeout.
 * @param {Function} [options.execFile] - promisified exec-file implementation (tests inject here).
 * @param {object} [options.logger] - warn-capable logger.
 */
export const createDockerRuntime = (options = {}) => {
  const {
    dockerPath = process.env.OPENCHAMBER_DOCKER_PATH || 'docker',
    commandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
    execFileImpl = DEFAULT_EXEC_FILE,
    logger = console,
  } = options;

  const runDocker = async (args, { timeoutMs = commandTimeoutMs } = {}) => {
    try {
      const { stdout } = await execFileImpl(dockerPath, args, {
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      });
      return stdout;
    } catch (error) {
      if (error && error.killed) {
        throw buildError(`Docker command timed out after ${timeoutMs}ms: docker ${args.join(' ')}`, {
          stderr: error.stderr,
          code: 'DOCKER_TIMEOUT',
        });
      }
      if (error && error.code === 'ENOENT') {
        throw buildError('Docker CLI not found on PATH', { code: 'DOCKER_CLI_MISSING', stderr: '' });
      }
      throw buildError(`Docker command failed: docker ${args.join(' ')}`, {
        stderr: error?.stderr,
        code: error?.code,
      });
    }
  };

  const runDockerJson = async (args, options) => {
    const stdout = await runDocker(args, options);
    try {
      return JSON.parse(stdout);
    } catch {
      throw buildError(`Docker command returned unparseable output: docker ${args.join(' ')}`, {
        code: 'DOCKER_BAD_JSON',
        stderr: stdout,
      });
    }
  };

  return {
    /** Resolves only when the CLI exists AND the daemon answers. */
    async isAvailable() {
      try {
        await runDocker(['version', '--format', '{{.Server.Version}}'], { timeoutMs: 5000 });
        return true;
      } catch (error) {
        if (error?.code === 'DOCKER_TIMEOUT' || error?.code === 'DOCKER_CLI_MISSING') {
          logger.warn?.(`[docker-runtime] availability probe failed: ${error.message}`);
        }
        return false;
      }
    },

    async imageExists(image) {
      if (typeof image !== 'string' || !image.trim()) {
        throw buildError('Image reference is required', { code: 'DOCKER_INVALID_ARG' });
      }
      try {
        await runDocker(['image', 'inspect', image], { timeoutMs: 10_000 });
        return true;
      } catch (error) {
        if (error?.code === 'DOCKER_CLI_MISSING' || error?.code === 'DOCKER_TIMEOUT') {
          throw error;
        }
        return false;
      }
    },

    /**
     * Creates (but does not start) a container. `portBindings` maps container
     * ports to `{ hostIp, hostPort }`; `binds` are `{ host, container, mode }`.
     * Only the caller-provided mounts and loopback publishing are applied —
     * this module invents nothing.
     */
    async createContainer({ name, image, labels, env, binds, portBindings, commandTimeoutMs: timeoutMs }) {
      if (!name || !image) {
        throw buildError('Container name and image are required', { code: 'DOCKER_INVALID_ARG' });
      }
      const args = ['create', '--name', name, '--restart', 'no'];
      for (const [key, value] of Object.entries(labels ?? {})) {
        args.push('--label', `${key}=${value}`);
      }
      for (const [key, value] of Object.entries(env ?? {})) {
        args.push('--env', `${key}=${value}`);
      }
      for (const bind of binds ?? []) {
        args.push('--volume', `${bind.host}:${bind.container}${bind.mode ? `:${bind.mode}` : ''}`);
      }
      for (const [containerPort, binding] of Object.entries(portBindings ?? {})) {
        const hostIp = binding?.hostIp ?? '127.0.0.1';
        const [port, proto] = String(containerPort).split('/');
        const protoSuffix = proto && proto !== 'tcp' ? `/${proto}` : '';
        args.push('--publish', `${hostIp}:${binding.hostPort}:${port}${protoSuffix}`);
      }
      args.push(image);
      const stdout = await runDocker(args, { timeoutMs });
      const containerId = stdout.trim();
      if (!containerId) {
        throw buildError(`docker create returned no container id for ${name}`, { code: 'DOCKER_BAD_OUTPUT' });
      }
      return containerId;
    },

    async startContainer(containerId, { commandTimeoutMs: timeoutMs } = {}) {
      await runDocker(['start', containerId], { timeoutMs });
      return true;
    },

    async stopContainer(containerId, { timeoutSeconds = 10, commandTimeoutMs } = {}) {
      await runDocker(['stop', '--time', String(timeoutSeconds), containerId], {
        timeoutMs: commandTimeoutMs ?? 10_000 + timeoutSeconds * 1000,
      });
      return true;
    },

    async removeContainer(containerId, { force = false, commandTimeoutMs } = {}) {
      const args = ['rm'];
      if (force) args.push('--force');
      args.push(containerId);
      await runDocker(args, { timeoutMs: commandTimeoutMs ?? 15_000 });
      return true;
    },

    /** Full inspect payload or `null` when the container does not exist. */
    async inspectContainer(containerId) {
      try {
        const payload = await runDockerJson(['container', 'inspect', containerId], { timeoutMs: 10_000 });
        return Array.isArray(payload) ? payload[0] ?? null : null;
      } catch (error) {
        if (error?.code === 'DOCKER_CLI_MISSING' || error?.code === 'DOCKER_TIMEOUT') {
          throw error;
        }
        return null;
      }
    },

    /** IDs of every container (any state) carrying the given label. */
    async listContainersByLabel(label) {
      if (typeof label !== 'string' || !label) {
        throw buildError('Label filter is required', { code: 'DOCKER_INVALID_ARG' });
      }
      const stdout = await runDocker(
        ['ps', '-a', '--filter', `label=${label}`, '--format', '{{.ID}}'],
        { timeoutMs: 10_000 },
      );
      return stdout.split('\n').map((line) => line.trim()).filter(Boolean);
    },

    /**
     * Builds the shipped instance image. Only invoked from an explicit user
     * action (create-flow button or direct API call) — never automatically.
     */
    async buildImage({ imageName, dockerfilePath, contextPath }) {
      if (!imageName || !dockerfilePath || !contextPath) {
        throw buildError('imageName, dockerfilePath and contextPath are required', { code: 'DOCKER_INVALID_ARG' });
      }
      const stdout = await runDocker(
        ['build', '--file', dockerfilePath, '--tag', imageName, contextPath],
        { timeoutMs: 600_000 },
      );
      const lastLine = stdout.trim().split('\n').filter(Boolean).pop() ?? '';
      return { imageName, output: lastLine };
    },

    /**
     * Pulls an image reference from its registry. Explicit user action only —
     * the fast first-run path when a prebuilt image is published.
     */
    async pullImage({ imageName }) {
      if (!imageName) {
        throw buildError('imageName is required', { code: 'DOCKER_INVALID_ARG' });
      }
      const stdout = await runDocker(['pull', imageName], { timeoutMs: 600_000 });
      return { imageName, output: stdout.trim().split('\n').filter(Boolean).pop() ?? '' };
    },

    /**
     * Bounded stdout+stderr tail of a container's logs. Used to make
     * readiness/start failures diagnosable before rollback removes the
     * container.
     */
    async containerLogs(containerId, { tail = 200 } = {}) {
      if (!containerId) {
        throw buildError('containerId is required', { code: 'DOCKER_INVALID_ARG' });
      }
      try {
        const { stdout, stderr } = await execFileImpl(dockerPath, ['logs', '--tail', String(tail), containerId], {
          timeout: 15_000,
          windowsHide: true,
          maxBuffer: 2 * 1024 * 1024,
        });
        return `${stdout ?? ''}${stderr ?? ''}`.slice(-4000);
      } catch (error) {
        if (error && error.code === 'ENOENT') {
          throw buildError('Docker CLI not found on PATH', { code: 'DOCKER_CLI_MISSING' });
        }
        // A stopped/vanished container may still yield logs; surface failures
        // to the caller, which treats an empty tail as acceptable.
        throw buildError(`Docker logs failed for ${containerId}`, {
          code: error?.code,
          stderr: error?.stderr,
        });
      }
    },
  };
};
