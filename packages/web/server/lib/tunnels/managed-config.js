import { randomUUID } from 'node:crypto';

export const createManagedTunnelConfigRuntime = (deps) => {
  const {
    fsPromises,
    path,
    normalizeManagedRemoteTunnelHostname,
    normalizeManagedRemoteTunnelPresets,
    constants,
    platform = process.platform,
    managedConfigDirectoryIsPrivate = false,
  } = deps;

  const {
    CLOUDFLARE_MANAGED_REMOTE_TUNNELS_FILE_PATH,
    CLOUDFLARE_LEGACY_NAMED_TUNNELS_FILE_PATH,
    CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION,
  } = constants;

  let persistManagedRemoteTunnelConfigLock = Promise.resolve();

  const sanitizeManagedRemoteTunnelConfigEntries = (value) => {
    if (!Array.isArray(value)) {
      return [];
    }

    const result = [];
    const seenIds = new Set();
    const seenHostnames = new Set();
    for (const entry of value) {
      if (!entry || typeof entry !== 'object') {
        continue;
      }

      const id = typeof entry.id === 'string' ? entry.id.trim() : '';
      const name = typeof entry.name === 'string' ? entry.name.trim() : '';
      const hostname = normalizeManagedRemoteTunnelHostname(entry.hostname);
      const token = typeof entry.token === 'string' ? entry.token.trim() : '';
      const updatedAt = Number.isFinite(entry.updatedAt) ? entry.updatedAt : Date.now();

      if (!id || !name || !hostname || !token) {
        continue;
      }
      if (seenIds.has(id) || seenHostnames.has(hostname)) {
        continue;
      }

      seenIds.add(id);
      seenHostnames.add(hostname);
      result.push({
        id,
        name,
        hostname,
        token,
        updatedAt,
        directE2eeEnabled: entry.directE2eeEnabled === true,
      });
    }

    return result;
  };

  const parseManagedRemoteTunnelConfig = (raw) => {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.tunnels)) {
      throw new TypeError('Managed remote tunnel config must be an object with a tunnels array');
    }
    return parsed;
  };

  const writeManagedRemoteTunnelConfigToDisk = async (data) => {
    const directory = path.dirname(CLOUDFLARE_MANAGED_REMOTE_TUNNELS_FILE_PATH);
    await fsPromises.mkdir(directory, { recursive: true, ...(managedConfigDirectoryIsPrivate ? { mode: 0o700 } : {}) });
    if (managedConfigDirectoryIsPrivate && platform !== 'win32') await fsPromises.chmod(directory, 0o700);
    const temporaryPath = `${CLOUDFLARE_MANAGED_REMOTE_TUNNELS_FILE_PATH}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fsPromises.writeFile(temporaryPath, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
      if (platform !== 'win32') await fsPromises.chmod(temporaryPath, 0o600);
      await fsPromises.rename(temporaryPath, CLOUDFLARE_MANAGED_REMOTE_TUNNELS_FILE_PATH);
      if (platform !== 'win32') await fsPromises.chmod(CLOUDFLARE_MANAGED_REMOTE_TUNNELS_FILE_PATH, 0o600);
    } catch (error) {
      await fsPromises.unlink(temporaryPath).catch(() => {});
      throw error;
    }
  };

  const migrateManagedRemoteTunnelConfigFromLegacyFile = async () => {
    try {
      const legacyRaw = await fsPromises.readFile(CLOUDFLARE_LEGACY_NAMED_TUNNELS_FILE_PATH, 'utf8');
      const parsed = parseManagedRemoteTunnelConfig(legacyRaw);
      const tunnels = sanitizeManagedRemoteTunnelConfigEntries(parsed.tunnels);
      const migrated = {
        version: CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION,
        tunnels,
      };
      await writeManagedRemoteTunnelConfigToDisk(migrated);
      return migrated;
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'ENOENT') {
        return { version: CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION, tunnels: [] };
      }
      throw error;
    }
  };

  const readManagedRemoteTunnelConfigFromDisk = async () => {
    try {
      const raw = await fsPromises.readFile(CLOUDFLARE_MANAGED_REMOTE_TUNNELS_FILE_PATH, 'utf8');
      const parsed = parseManagedRemoteTunnelConfig(raw);

      return {
        version: CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION,
        tunnels: sanitizeManagedRemoteTunnelConfigEntries(parsed.tunnels),
      };
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'ENOENT') {
        return migrateManagedRemoteTunnelConfigFromLegacyFile();
      }
      throw error;
    }
  };

  const updateManagedRemoteTunnelConfig = async (mutate) => {
    persistManagedRemoteTunnelConfigLock = persistManagedRemoteTunnelConfigLock.catch(() => {}).then(async () => {
      const current = await readManagedRemoteTunnelConfigFromDisk();
      const next = mutate({
        version: CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION,
        tunnels: sanitizeManagedRemoteTunnelConfigEntries(current.tunnels),
      });

      await writeManagedRemoteTunnelConfigToDisk({
        version: CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION,
        tunnels: sanitizeManagedRemoteTunnelConfigEntries(next?.tunnels),
      });
    });

    return persistManagedRemoteTunnelConfigLock;
  };

  const syncManagedRemoteTunnelConfigWithPresets = async (presets) => {
    const sanitizedPresets = normalizeManagedRemoteTunnelPresets(presets) || [];

    await updateManagedRemoteTunnelConfig((current) => {
      const byId = new Map(current.tunnels.map((entry) => [entry.id, entry]));
      const byHostname = new Map(current.tunnels.map((entry) => [entry.hostname, entry]));

      const nextTunnels = [];
      for (const preset of sanitizedPresets) {
        const existing = byId.get(preset.id) || byHostname.get(preset.hostname) || null;
        if (!existing) {
          continue;
        }

        nextTunnels.push({
          ...existing,
          id: preset.id,
          name: preset.name,
          hostname: preset.hostname,
        });
      }

      return {
        version: CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION,
        tunnels: nextTunnels,
      };
    });
  };

  const upsertManagedRemoteTunnelToken = async ({ id, name, hostname, token, directE2eeEnabled }) => {
    if (typeof id !== 'string' || typeof name !== 'string' || typeof hostname !== 'string' || typeof token !== 'string') {
      return;
    }
    const normalizedId = id.trim();
    const normalizedName = name.trim();
    const normalizedHostname = normalizeManagedRemoteTunnelHostname(hostname);
    const normalizedToken = token.trim();
    if (!normalizedId || !normalizedName || !normalizedHostname || !normalizedToken) {
      return;
    }

    await updateManagedRemoteTunnelConfig((current) => {
      const existing = current.tunnels.find((entry) => entry.id === normalizedId)
        || current.tunnels.find((entry) => entry.hostname === normalizedHostname)
        || null;
      const withoutConflicts = current.tunnels.filter((entry) => entry.id !== normalizedId && entry.hostname !== normalizedHostname);
      withoutConflicts.push({
        id: normalizedId,
        name: normalizedName,
        hostname: normalizedHostname,
        token: normalizedToken,
        updatedAt: Date.now(),
        directE2eeEnabled: typeof directE2eeEnabled === 'boolean'
          ? directE2eeEnabled
          : existing?.directE2eeEnabled === true,
      });

      return {
        version: CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION,
        tunnels: withoutConflicts,
      };
    });
  };

  const setManagedRemoteTunnelDirectE2eeEnabled = async ({ id, directE2eeEnabled }) => {
    const normalizedId = typeof id === 'string' ? id.trim() : '';
    if (!normalizedId || typeof directE2eeEnabled !== 'boolean') {
      return null;
    }

    let updatedProfile = null;
    await updateManagedRemoteTunnelConfig((current) => ({
      version: CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION,
      tunnels: current.tunnels.map((entry) => {
        if (entry.id !== normalizedId) {
          return entry;
        }
        updatedProfile = { ...entry, directE2eeEnabled };
        return updatedProfile;
      }),
    }));
    return updatedProfile;
  };

  const resolveManagedRemoteTunnelToken = async ({ presetId, hostname }) => {
    const normalizedPresetId = typeof presetId === 'string' ? presetId.trim() : '';
    const normalizedHostname = normalizeManagedRemoteTunnelHostname(hostname);
    const config = await readManagedRemoteTunnelConfigFromDisk();

    if (normalizedPresetId) {
      const byId = config.tunnels.find((entry) => entry.id === normalizedPresetId);
      if (byId?.token) {
        return byId.token;
      }
    }

    if (normalizedHostname) {
      const byHostname = config.tunnels.find((entry) => entry.hostname === normalizedHostname);
      if (byHostname?.token) {
        return byHostname.token;
      }
    }

    return '';
  };

  return {
    readManagedRemoteTunnelConfigFromDisk,
    syncManagedRemoteTunnelConfigWithPresets,
    upsertManagedRemoteTunnelToken,
    setManagedRemoteTunnelDirectE2eeEnabled,
    resolveManagedRemoteTunnelToken,
  };
};
