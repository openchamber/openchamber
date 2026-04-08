const BACKEND_DESCRIPTORS = Object.freeze([
  {
    id: 'opencode',
    label: 'OpenCode',
    available: true,
    comingSoon: false,
    capabilities: {
      chat: true,
      sessions: true,
      models: true,
      agents: true,
      providers: true,
      commands: true,
      config: true,
      skills: true,
    },
  },
  {
    id: 'codex',
    label: 'Codex',
    available: false,
    comingSoon: true,
    capabilities: {
      chat: false,
      sessions: false,
      models: false,
      agents: false,
      providers: false,
      commands: false,
      config: false,
      skills: false,
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
      agents: false,
      providers: false,
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
      agents: false,
      providers: false,
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
      agents: false,
      providers: false,
      commands: false,
      config: false,
      skills: false,
    },
  },
]);

export const DEFAULT_BACKEND_ID = 'opencode';

export const createBackendRegistry = ({ readSettingsFromDiskMigrated } = {}) => {
  const descriptorById = new Map(BACKEND_DESCRIPTORS.map((descriptor) => [descriptor.id, descriptor]));

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
  };
};
