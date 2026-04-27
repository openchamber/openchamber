export const BACKEND_DESCRIPTORS = Object.freeze([
  {
    id: 'opencode',
    label: 'OpenCode',
    available: true,
    comingSoon: false,
    capabilities: {
      chat: true,
      sessions: true,
      models: true,
      shell: true,
      agents: true,
      providers: true,
      auth: true,
      commands: true,
      config: true,
      skills: true,
    },
  },
  {
    id: 'codex',
    label: 'Codex',
    available: true,
    comingSoon: false,
    capabilities: {
      chat: true,
      sessions: true,
      models: true,
      shell: false,
      agents: false,
      providers: false,
      auth: false,
      commands: true,
      config: true,
      skills: true,
    },
  },
  {
    id: 'claude',
    label: 'Claude',
    available: false,
    comingSoon: true,
    capabilities: {
      chat: false,
      sessions: false,
      models: false,
      shell: false,
      agents: false,
      providers: false,
      auth: false,
      commands: false,
      config: false,
      skills: false,
    },
  },
  {
    id: 'gemini',
    label: 'Gemini',
    available: false,
    comingSoon: true,
    capabilities: {
      chat: false,
      sessions: false,
      models: false,
      shell: false,
      agents: false,
      providers: false,
      auth: false,
      commands: false,
      config: false,
      skills: false,
    },
  },
  {
    id: 'cursor',
    label: 'Cursor',
    available: false,
    comingSoon: true,
    capabilities: {
      chat: false,
      sessions: false,
      models: false,
      shell: false,
      agents: false,
      providers: false,
      auth: false,
      commands: false,
      config: false,
      skills: false,
    },
  },
]);

export const DEFAULT_BACKEND_ID = 'opencode';

export const createBackendRegistry = ({ readSettingsFromDiskMigrated } = {}) => {
  const descriptorById = new Map(BACKEND_DESCRIPTORS.map((descriptor) => [descriptor.id, descriptor]));
  const runtimeById = new Map();
  const availabilityById = new Map();

  const listBackends = () => BACKEND_DESCRIPTORS.map((descriptor) => ({
    ...descriptor,
    capabilities: { ...descriptor.capabilities },
  }));

  const getBackend = (backendId) => {
    if (typeof backendId !== 'string' || backendId.trim().length === 0) {
      return descriptorById.get(DEFAULT_BACKEND_ID) || null;
    }
    return descriptorById.get(backendId.trim()) || null;
  };

  const registerRuntime = (backendId, runtime) => {
    if (!descriptorById.has(backendId)) {
      console.warn(`[BackendRegistry] Cannot register runtime for unknown backend "${backendId}"`);
      return;
    }
    runtimeById.set(backendId, runtime);
  };

  const getRuntime = (backendId) => {
    if (typeof backendId !== 'string' || backendId.trim().length === 0) {
      return null;
    }
    return runtimeById.get(backendId.trim()) || null;
  };

  const setBackendAvailability = (backendId, isAvailable) => {
    availabilityById.set(backendId, Boolean(isAvailable));
  };

  const isBackendAvailable = (backendId) => {
    return availabilityById.get(backendId) ?? false;
  };

  const getDefaultBackendId = async () => {
    try {
      const settings = await readSettingsFromDiskMigrated?.();
      const configured = typeof settings?.defaultBackend === 'string' ? settings.defaultBackend.trim() : '';
      const descriptor = configured ? descriptorById.get(configured) : null;
      if (descriptor) {
        return descriptor.id;
      }
    } catch {
    }

    // Fall back to the first backend with confirmed runtime availability,
    // preferring the descriptor order (opencode first for backward compat).
    for (const descriptor of BACKEND_DESCRIPTORS) {
      if (descriptor.available && availabilityById.get(descriptor.id)) {
        return descriptor.id;
      }
    }

    // No runtime availability confirmed yet (early startup); use compile-time default.
    return DEFAULT_BACKEND_ID;
  };

  const isBackendSelectable = (backendId) => {
    const descriptor = getBackend(backendId);
    return Boolean(descriptor?.available);
  };

  return {
    listBackends,
    getBackend,
    getDefaultBackendId,
    isBackendSelectable,
    registerRuntime,
    getRuntime,
    setBackendAvailability,
    isBackendAvailable,
  };
};
