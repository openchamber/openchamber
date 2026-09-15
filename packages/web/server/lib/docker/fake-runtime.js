/**
 * In-memory Docker runtime for tests.
 *
 * Mirrors the `createDockerRuntime` contract so every lifecycle test runs
 * without touching a real daemon. Supports injectable failures and records a
 * call log for operation-count assertions (rollback tests rely on it).
 */

export const createFakeDockerRuntime = (options = {}) => {
  const { logger = console } = options;

  let containerSeq = 0;
  const containers = new Map();
  const existingImages = new Set(options.images ?? ['opencode-instance:local']);
  const callLog = [];
  const failureQueue = [];

  const record = (method, args) => callLog.push({ method, args, at: callLog.length });

  const checkFailure = async (method) => {
    const index = failureQueue.findIndex((entry) => entry.method === method || entry.method === '*');
    if (index === -1) return;
    const [entry] = failureQueue.splice(index, 1);
    if (!entry.filter || entry.filter({ method, callLog: [...callLog] })) {
      throw entry.error ?? new Error(`Injected failure in ${method}`);
    }
  };

  const fail = (state) => {
    const error = new Error(state.message ?? `Injected failure in ${state.method}`);
    error.code = state.code ?? 'FAKE_FAILURE';
    failureQueue.push({ method: state.method, filter: state.filter, error });
  };

  const runtime = {
    isAvailable: async () => {
      record('isAvailable', {});
      await checkFailure('isAvailable');
      return !options.unavailable;
    },

    imageExists: async (image) => {
      record('imageExists', { image });
      await checkFailure('imageExists');
      return existingImages.has(image);
    },

    createContainer: async ({ name, image, labels, env, binds, portBindings }) => {
      record('createContainer', { name, image, labels, env, binds, portBindings });
      await checkFailure('createContainer');
      if (!existingImages.has(image)) {
        const error = new Error(`image ${image} not found`);
        error.code = 'FAKE_IMAGE_MISSING';
        throw error;
      }
      for (const existing of containers.values()) {
        if (existing.name === name) {
          const error = new Error(`container name ${name} already in use`);
          error.code = 'FAKE_NAME_IN_USE';
          throw error;
        }
      }
      containerSeq += 1;
      const containerId = `fake-container-${containerSeq}`;
      containers.set(containerId, {
        id: containerId,
        name,
        image,
        labels: { ...(labels ?? {}) },
        env: { ...(env ?? {}) },
        binds: (binds ?? []).map((bind) => ({ ...bind })),
        portBindings: { ...(portBindings ?? {}) },
        state: 'created',
        logs: [`[${name}] fake boot log`, `[${name}] starting opencode serve`],
      });
      return containerId;
    },

    startContainer: async (containerId) => {
      record('startContainer', { containerId });
      await checkFailure('startContainer');
      const container = containers.get(containerId);
      if (!container) throw new Error(`no such container ${containerId}`);
      container.state = 'running';
      return true;
    },

    stopContainer: async (containerId) => {
      record('stopContainer', { containerId });
      await checkFailure('stopContainer');
      const container = containers.get(containerId);
      if (!container) throw new Error(`no such container ${containerId}`);
      container.state = 'stopped';
      return true;
    },

    removeContainer: async (containerId) => {
      record('removeContainer', { containerId });
      await checkFailure('removeContainer');
      const container = containers.get(containerId);
      if (!container) {
        // Idempotent removal: deleting an already-gone container is fine.
        return true;
      }
      containers.delete(containerId);
      return true;
    },

    inspectContainer: async (containerId) => {
      record('inspectContainer', { containerId });
      await checkFailure('inspectContainer');
      const container = containers.get(containerId);
      if (!container) return null;
      return {
        Id: container.id,
        Name: `/${container.name}`,
        State: { Running: container.state === 'running' },
        Config: { Image: container.image, Labels: container.labels },
        Mounts: container.binds.map((bind) => ({ Source: bind.host, Destination: bind.container, RW: bind.mode !== 'ro' })),
      };
    },

    listContainersByLabel: async (label) => {
      record('listContainersByLabel', { label });
      await checkFailure('listContainersByLabel');
      return [...containers.values()]
        .filter((container) => container.labels?.[label.split('=')[0]] === label.split('=')[1])
        .map((container) => container.id);
    },

    buildImage: async ({ imageName }) => {
      record('buildImage', { imageName });
      await checkFailure('buildImage');
      existingImages.add(imageName);
      return { imageName, output: 'fake build ok' };
    },

    pullImage: async ({ imageName }) => {
      record('pullImage', { imageName });
      await checkFailure('pullImage');
      existingImages.add(imageName);
      return { imageName, output: 'fake pull ok' };
    },

    containerLogs: async (containerId) => {
      record('containerLogs', { containerId });
      await checkFailure('containerLogs');
      const container = containers.get(containerId);
      if (!container) return '';
      return container.logs.join('\n');
    },

    // ---- Test-only surface -------------------------------------------------
    calls: {
      log: callLog,
      count: (method) => callLog.filter((entry) => entry.method === method).length,
      reset: () => { callLog.length = 0; },
    },
    containers,
    images: existingImages,
    addImage: (image) => existingImages.add(image),
    failNext: fail,
    _reset: () => {
      containers.clear();
      containerSeq = 0;
      callLog.length = 0;
      failureQueue.length = 0;
    },
  };

  return runtime;
};
