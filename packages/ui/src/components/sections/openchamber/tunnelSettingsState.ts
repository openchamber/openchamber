export interface ManagedRemoteTunnelPreset {
  id: string;
  name: string;
  hostname: string;
  directE2eeEnabled?: boolean;
}

export interface TunnelStatusResponse {
  active: boolean;
  url: string | null;
  mode?: string;
  hasManagedRemoteTunnelToken?: boolean;
  managedRemoteTunnelHostname?: string | null;
  hasBootstrapToken?: boolean;
  bootstrapExpiresAt?: number | null;
  managedRemoteTunnelTokenPresetIds?: string[];
  managedRemoteTunnelPresets?: ManagedRemoteTunnelPreset[];
  activeTunnelMode?: string | null;
  providerMetadata?: {
    configPath?: string | null;
    resolvedHostname?: string | null;
  };
  activeSessions?: Array<{
    sessionId: string;
    mode: 'quick' | 'managed-local' | 'managed-remote' | null;
    status: 'active' | 'inactive';
    inactiveReason?: string | null;
    createdAt: number;
    lastSeenAt: number;
    expiresAt: number;
    publicUrl?: string | null;
  }>;
  localPort?: number;
  policy?: string;
  ttlConfig?: {
    bootstrapTtlMs?: number | null;
    sessionTtlMs?: number;
  };
  activeManagedRemoteProfileId?: string | null;
  directE2eeActiveSessions?: number;
  directE2eeConfigured?: boolean;
  directE2eeSupported?: boolean;
  directE2eeAvailable?: boolean;
}

const unsafeManagedPresetIds = new Set([
  'prototype',
  'constructor',
  '__defineGetter__',
  '__defineSetter__',
  'hasOwnProperty',
  '__lookupGetter__',
  '__lookupSetter__',
  'isPrototypeOf',
  'propertyIsEnumerable',
  'toString',
  'valueOf',
  '__proto__',
  'toLocaleString',
]);

const normalizeManagedRemotePresetHostname = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  try {
    const parsed = trimmed.includes('://') ? new URL(trimmed) : new URL(`https://${trimmed}`);
    return parsed.hostname.trim().toLowerCase();
  } catch {
    return '';
  }
};

export const sanitizeManagedRemoteTunnelPresets = (
  value: unknown,
  legacyHostname?: unknown,
): ManagedRemoteTunnelPreset[] => {
  const presets: ManagedRemoteTunnelPreset[] = [];
  const seenIds = new Set<string>();
  const seenHostnames = new Set<string>();

  if (Array.isArray(value)) {
    for (const entry of value) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const candidate = entry as Record<string, unknown>;
      const id = typeof candidate.id === 'string' ? candidate.id.trim() : '';
      const name = typeof candidate.name === 'string' ? candidate.name.trim() : '';
      const hostname = normalizeManagedRemotePresetHostname(candidate.hostname);
      if (!id || unsafeManagedPresetIds.has(id) || !name || !hostname || seenIds.has(id) || seenHostnames.has(hostname)) continue;
      seenIds.add(id);
      seenHostnames.add(hostname);
      presets.push({
        id,
        name,
        hostname,
        ...(typeof candidate.directE2eeEnabled === 'boolean'
          ? { directE2eeEnabled: candidate.directE2eeEnabled }
          : {}),
      });
    }
  }

  if (presets.length > 0) return presets;
  const hostname = normalizeManagedRemotePresetHostname(legacyHostname);
  if (!hostname || typeof legacyHostname !== 'string') return [];
  return [{ id: `legacy-${hostname}`, name: legacyHostname.trim(), hostname }];
};

export const reconcileSelectedPresetId = (
  currentId: string,
  presets: readonly ManagedRemoteTunnelPreset[],
): string => {
  if (currentId && presets.some((preset) => preset.id === currentId)) return currentId;
  return presets[0]?.id ?? '';
};

export async function toggleDirectE2ee(
  presetId: string,
  enabled: boolean,
  runtimeFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
): Promise<{ ok: boolean; profile?: ManagedRemoteTunnelPreset }> {
  try {
    const res = await runtimeFetch(`/api/openchamber/tunnel/managed-remote-profile/${encodeURIComponent(presetId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ directE2eeEnabled: enabled }),
    });
    if (!res.ok) return { ok: false };
    const data: unknown = await res.json();
    if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false };
    const response = data as Record<string, unknown>;
    if (response.ok !== true || !response.profile || typeof response.profile !== 'object' || Array.isArray(response.profile)) {
      return { ok: false };
    }
    const profile = response.profile as Record<string, unknown>;
    if (typeof profile.id !== 'string'
      || profile.id !== presetId
      || typeof profile.name !== 'string'
      || typeof profile.hostname !== 'string'
      || typeof profile.directE2eeEnabled !== 'boolean') {
      return { ok: false };
    }
    const sanitized = sanitizeManagedRemoteTunnelPresets([profile]);
    if (sanitized.length !== 1
      || sanitized[0]?.id !== presetId
      || sanitized[0]?.directE2eeEnabled !== enabled) {
      return { ok: false };
    }
    return { ok: true, profile: sanitized[0] };
  } catch {
    return { ok: false };
  }
}
