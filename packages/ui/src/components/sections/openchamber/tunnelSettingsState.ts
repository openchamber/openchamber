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
    const data = await res.json();
    if (!data || !data.ok || !data.profile) {
      return { ok: false };
    }
    return {
      ok: true,
      profile: {
        id: String(data.profile.id),
        name: String(data.profile.name),
        hostname: String(data.profile.hostname),
        directE2eeEnabled: Boolean(data.profile.directE2eeEnabled)
      }
    };
  } catch {
    return { ok: false };
  }
}
