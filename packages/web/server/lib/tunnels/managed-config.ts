import type { createSettingsNormalizationRuntime } from '../settings/settings-normalization-runtime.js';

export interface ManagedRemoteTunnelPreset {
  id: string;
  name: string;
  hostname: string;
}

export interface ManagedRemoteTunnelEntry extends ManagedRemoteTunnelPreset {
  token: string;
  updatedAt: number;
}

export interface ManagedRemoteTunnelConfig {
  version: number;
  tunnels: ManagedRemoteTunnelEntry[];
}

export interface ManagedRemoteTunnelTokenInput {
  id: unknown;
  name: unknown;
  hostname: unknown;
  token: unknown;
}

export interface ManagedTunnelConfigDependencies<PresetInput> {
  fsPromises: Pick<typeof import('node:fs/promises'), 'mkdir' | 'writeFile' | 'readFile'>;
  path: Pick<typeof import('node:path'), 'dirname'>;
  normalizeManagedRemoteTunnelHostname: ReturnType<typeof createSettingsNormalizationRuntime>['normalizeManagedRemoteTunnelHostname'];
  normalizeManagedRemoteTunnelPresets: (value: PresetInput) => ManagedRemoteTunnelPreset[] | undefined;
  constants: {
    CLOUDFLARE_MANAGED_REMOTE_TUNNELS_FILE_PATH: string;
    CLOUDFLARE_LEGACY_NAMED_TUNNELS_FILE_PATH: string;
    CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION: number;
  };
}

const isText = (value: unknown): value is string => typeof value === 'string';
const isEntryObject = (value: unknown): value is {
  id?: unknown;
  name?: unknown;
  hostname?: unknown;
  token?: unknown;
  updatedAt?: unknown;
} => Boolean(value) && typeof value === 'object';
const isConfigObject = (value: unknown): value is { tunnels?: unknown } =>
  Boolean(value) && typeof value === 'object';
const hasErrorCode = (value: unknown): value is { code?: unknown } =>
  Boolean(value) && typeof value === 'object';
const isFiniteTimestamp = (value: unknown): value is number => Number.isFinite(value);

export const createManagedTunnelConfigRuntime = <PresetInput>(deps: ManagedTunnelConfigDependencies<PresetInput>) => {
  const {
    fsPromises,
    path,
    normalizeManagedRemoteTunnelHostname,
    normalizeManagedRemoteTunnelPresets,
    constants,
  } = deps;

  const {
    CLOUDFLARE_MANAGED_REMOTE_TUNNELS_FILE_PATH,
    CLOUDFLARE_LEGACY_NAMED_TUNNELS_FILE_PATH,
    CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION,
  } = constants;

  let persistManagedRemoteTunnelConfigLock = Promise.resolve();

  const sanitizeManagedRemoteTunnelConfigEntries = (value: unknown[]) => {
    const result: ManagedRemoteTunnelEntry[] = [];
    const seenIds = new Set();
    const seenHostnames = new Set();
    for (const entry of value) {
      if (!isEntryObject(entry)) {
        continue;
      }

      const id = isText(entry.id) ? entry.id.trim() : '';
      const name = isText(entry.name) ? entry.name.trim() : '';
      const hostname = normalizeManagedRemoteTunnelHostname(entry.hostname);
      const token = isText(entry.token) ? entry.token.trim() : '';
      const updatedAt = isFiniteTimestamp(entry.updatedAt) ? entry.updatedAt : Date.now();

      if (!id || !name || !hostname || !token) {
        continue;
      }
      if (seenIds.has(id) || seenHostnames.has(hostname)) {
        continue;
      }

      seenIds.add(id);
      seenHostnames.add(hostname);
      result.push({ id, name, hostname, token, updatedAt });
    }

    return result;
  };

  const parseManagedRemoteTunnelConfigEntries = (raw: string) => {
    const parsed: unknown = JSON.parse(raw);
    return isConfigObject(parsed) && Array.isArray(parsed.tunnels)
      ? sanitizeManagedRemoteTunnelConfigEntries(parsed.tunnels)
      : [];
  };

  const writeManagedRemoteTunnelConfigToDisk = async (data: ManagedRemoteTunnelConfig) => {
    await fsPromises.mkdir(path.dirname(CLOUDFLARE_MANAGED_REMOTE_TUNNELS_FILE_PATH), { recursive: true });
    await fsPromises.writeFile(CLOUDFLARE_MANAGED_REMOTE_TUNNELS_FILE_PATH, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
  };

  const migrateManagedRemoteTunnelConfigFromLegacyFile = async () => {
    try {
      const legacyRaw = await fsPromises.readFile(CLOUDFLARE_LEGACY_NAMED_TUNNELS_FILE_PATH, 'utf8');
      const tunnels = parseManagedRemoteTunnelConfigEntries(legacyRaw);
      const migrated = {
        version: CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION,
        tunnels,
      };
      await writeManagedRemoteTunnelConfigToDisk(migrated);
      return migrated;
    } catch (error) {
      if (hasErrorCode(error) && error.code === 'ENOENT') {
        return { version: CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION, tunnels: [] };
      }
      console.warn('Failed to migrate legacy named tunnel config file:', error);
      return { version: CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION, tunnels: [] };
    }
  };

  const readManagedRemoteTunnelConfigFromDisk = async () => {
    try {
      const raw = await fsPromises.readFile(CLOUDFLARE_MANAGED_REMOTE_TUNNELS_FILE_PATH, 'utf8');
      return {
        version: CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION,
        tunnels: parseManagedRemoteTunnelConfigEntries(raw),
      };
    } catch (error) {
      if (hasErrorCode(error) && error.code === 'ENOENT') {
        return migrateManagedRemoteTunnelConfigFromLegacyFile();
      }
      console.warn('Failed to read managed remote tunnel config file:', error);
      return { version: CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION, tunnels: [] };
    }
  };

  const updateManagedRemoteTunnelConfig = async (mutate: (current: ManagedRemoteTunnelConfig) => ManagedRemoteTunnelConfig) => {
    const result = persistManagedRemoteTunnelConfigLock.then(async () => {
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
    persistManagedRemoteTunnelConfigLock = result.catch(() => {});
    return result;
  };

  const syncManagedRemoteTunnelConfigWithPresets = async (presets: PresetInput) => {
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

  const upsertManagedRemoteTunnelToken = async ({ id, name, hostname, token }: ManagedRemoteTunnelTokenInput) => {
    if (!isText(id) || !isText(name) || !isText(hostname) || !isText(token)) {
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
      const withoutConflicts = current.tunnels.filter((entry) => entry.id !== normalizedId && entry.hostname !== normalizedHostname);
      withoutConflicts.push({
        id: normalizedId,
        name: normalizedName,
        hostname: normalizedHostname,
        token: normalizedToken,
        updatedAt: Date.now(),
      });

      return {
        version: CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION,
        tunnels: withoutConflicts,
      };
    });
  };

  const resolveManagedRemoteTunnelToken = async ({ presetId, hostname }: { presetId: string; hostname: string | undefined }) => {
    const normalizedPresetId = presetId.trim();
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
    resolveManagedRemoteTunnelToken,
  };
};
