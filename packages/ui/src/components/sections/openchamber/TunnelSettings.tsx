import React from 'react';
import QRCode from 'qrcode';
import {
  RiAddLine,
  RiArrowDownSLine,
  RiArrowRightSLine,
  RiCheckboxBlankCircleFill,
  RiCheckLine,
  RiCloseLine,
  RiCloudLine,
  RiDeleteBinLine,
  RiErrorWarningLine,
  RiExternalLinkLine,
  RiFileCopyLine,
  RiFolderLine,
  RiInformationLine,
  RiLoader4Line,
  RiRestartLine,
} from '@remixicon/react';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { GridLoader } from '@/components/ui/grid-loader';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { requestFileAccess } from '@/lib/desktop';
import { updateDesktopSettings } from '@/lib/persistence';
import { cn } from '@/lib/utils';
import { openExternalUrl } from '@/lib/url';
import { m } from '@/lib/i18n/messages';

type TunnelState =
  | 'checking'
  | 'not-available'
  | 'idle'
  | 'starting'
  | 'active'
  | 'stopping'
  | 'error';

type TtlOption = { value: string; label: string; ms: number | null };
type TunnelMode = 'quick' | 'managed-remote' | 'managed-local';
type ApiTunnelMode = TunnelMode;

interface ManagedRemoteTunnelPreset {
  id: string;
  name: string;
  hostname: string;
}

const BOOTSTRAP_TTL_OPTIONS: TtlOption[] = [
  { value: '1800000', label: '30m', ms: 30 * 60 * 1000 },
  { value: '180000', label: '3m', ms: 3 * 60 * 1000 },
  { value: '7200000', label: '2h', ms: 2 * 60 * 60 * 1000 },
  { value: '28800000', label: '8h', ms: 8 * 60 * 60 * 1000 },
  { value: '86400000', label: '24h', ms: 24 * 60 * 60 * 1000 },
];

const SESSION_TTL_OPTIONS: TtlOption[] = [
  { value: '3600000', label: '1h', ms: 60 * 60 * 1000 },
  { value: '28800000', label: '8h', ms: 8 * 60 * 60 * 1000 },
  { value: '43200000', label: '12h', ms: 12 * 60 * 60 * 1000 },
  { value: '86400000', label: '24h', ms: 24 * 60 * 60 * 1000 },
  { value: '604800000', label: '1w', ms: 7 * 24 * 60 * 60 * 1000 },
  { value: '2592000000', label: '30d', ms: 30 * 24 * 60 * 60 * 1000 },
];

const MANAGED_REMOTE_TUNNEL_DOC_URL = 'https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel/';
const MANAGED_LOCAL_TUNNEL_DOC_URL = 'https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/configuration-file/';

const getTunnelModeOptions = (): Array<{ value: TunnelMode; label: string; tooltip: string }> => [
  { value: 'quick', label: m.tunnelModeQuick(), tooltip: m.tunnelModeQuickTooltip() },
  { value: 'managed-remote', label: m.tunnelModeManagedRemote(), tooltip: m.tunnelModeManagedRemoteTooltip() },
  { value: 'managed-local', label: m.tunnelModeManagedLocal(), tooltip: m.tunnelModeManagedLocalTooltip() },
];

const MANAGED_LOCAL_CONFIG_ALLOWED_EXTENSIONS = ['.yml', '.yaml', '.json'];

const hasAllowedManagedLocalConfigExtension = (filePath: string): boolean => {
  const normalized = filePath.trim().toLowerCase();
  return MANAGED_LOCAL_CONFIG_ALLOWED_EXTENSIONS.some((extension) => normalized.endsWith(extension));
};

interface TunnelInfo {
  url: string;
  connectUrl: string | null;
  bootstrapExpiresAt: number | null;
}

interface TunnelSessionRecord {
  sessionId: string;
  mode: TunnelMode | null;
  status: 'active' | 'inactive';
  inactiveReason?: string | null;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  publicUrl?: string | null;
}

interface TunnelStatusResponse {
  active: boolean;
  url: string | null;
  mode?: ApiTunnelMode;
  hasManagedRemoteTunnelToken?: boolean;
  managedRemoteTunnelHostname?: string | null;
  hasBootstrapToken?: boolean;
  bootstrapExpiresAt?: number | null;
  managedRemoteTunnelTokenPresetIds?: string[];
  managedRemoteTunnelPresets?: ManagedRemoteTunnelPreset[];
  activeTunnelMode?: ApiTunnelMode | null;
  providerMetadata?: {
    configPath?: string | null;
    resolvedHostname?: string | null;
  };
  activeSessions?: TunnelSessionRecord[];
  localPort?: number;
  policy?: string;
  ttlConfig?: {
    bootstrapTtlMs?: number | null;
    sessionTtlMs?: number;
  };
}

interface TunnelStartResponse {
  ok?: boolean;
  error?: string;
  url?: string;
  connectUrl?: string | null;
  bootstrapExpiresAt?: number | null;
  activeTunnelMode?: ApiTunnelMode | null;
  mode?: ApiTunnelMode;
  activeSessions?: TunnelSessionRecord[];
  managedRemoteTunnelTokenPresetIds?: string[];
  localPort?: number;
  replacedTunnel?: boolean;
  revokedBootstrapCount?: number;
  invalidatedSessionCount?: number;
}

interface TunnelProviderModeDescriptor {
  key: TunnelMode;
  label: string;
}

interface TunnelProviderCapability {
  provider: string;
  modes?: TunnelProviderModeDescriptor[];
}

const getProviderLabel = (provider: string): string => {
  if (provider === 'cloudflare') {
    return 'Cloudflare';
  }
  return provider;
};

const ProviderOptionLabel: React.FC<{ provider: string }> = ({ provider }) => {
  const label = getProviderLabel(provider);
  const isCloudflare = provider === 'cloudflare';

  return (
    <span className="flex items-center gap-2">
      <RiCloudLine className={cn('size-4 shrink-0', isCloudflare ? 'text-[var(--status-warning)]' : 'text-muted-foreground')} />
      <span>{label}</span>
    </span>
  );
};

const toUiTunnelMode = (mode: string | null | undefined): TunnelMode => {
  if (mode === 'quick') {
    return 'quick';
  }
  if (mode === 'managed-remote') {
    return 'managed-remote';
  }
  if (mode === 'managed-local') {
    return 'managed-local';
  }
  return 'quick';
};

const ttlOptionValue = (options: TtlOption[], ttlMs: number | null, fallback: string) => {
  const matched = options.find((entry) => entry.ms === ttlMs);
  return matched?.value || fallback;
};

const formatRemaining = (remainingMs: number): string => {
  const safeMs = Math.max(0, remainingMs);
  const totalSeconds = Math.floor(safeMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
};

const formatAbsoluteTime = (timestamp: number): string => {
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
};

const normalizePresetHostname = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }

  try {
    const parsed = trimmed.includes('://') ? new URL(trimmed) : new URL(`https://${trimmed}`);
    return parsed.hostname.trim().toLowerCase();
  } catch {
    return trimmed.toLowerCase();
  }
};

const sanitizePresets = (value: unknown): ManagedRemoteTunnelPreset[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  const seenIds = new Set<string>();
  const seenHosts = new Set<string>();
  const result: ManagedRemoteTunnelPreset[] = [];

  for (const entry of value) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const candidate = entry as Record<string, unknown>;
    const id = typeof candidate.id === 'string' ? candidate.id.trim() : '';
    const name = typeof candidate.name === 'string' ? candidate.name.trim() : '';
    const hostname = normalizePresetHostname(typeof candidate.hostname === 'string' ? candidate.hostname : '');
    if (!id || !name || !hostname) {
      continue;
    }
    if (seenIds.has(id) || seenHosts.has(hostname)) {
      continue;
    }
    seenIds.add(id);
    seenHosts.add(hostname);
    result.push({ id, name, hostname });
  }

  return result;
};

const createPresetId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
};

export const TunnelSettings: React.FC = () => {
  const [state, setState] = React.useState<TunnelState>('checking');
  const [tunnelInfo, setTunnelInfo] = React.useState<TunnelInfo | null>(null);
  const [activeTunnelMode, setActiveTunnelMode] = React.useState<TunnelMode | null>(null);
  const [qrDataUrl, setQrDataUrl] = React.useState<string | null>(null);
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const [managedRemoteValidationError, setManagedRemoteValidationError] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);
  const [isSavingTtl, setIsSavingTtl] = React.useState(false);
  const [isSavingMode, setIsSavingMode] = React.useState(false);
  const [tunnelProvider, setTunnelProvider] = React.useState<string>('cloudflare');
  const [providerCapabilities, setProviderCapabilities] = React.useState<TunnelProviderCapability[]>([]);
  const [tunnelMode, setTunnelMode] = React.useState<TunnelMode>('quick');
  const [managedLocalConfigPath, setManagedLocalConfigPath] = React.useState<string | null>(null);
  const [managedRemoteTunnelPresets, setManagedRemoteTunnelPresets] = React.useState<ManagedRemoteTunnelPreset[]>([]);
  const [expandedManagedRemoteTunnels, setExpandedManagedRemoteTunnels] = React.useState<Record<string, boolean>>({});
  const [selectedPresetId, setSelectedPresetId] = React.useState<string>('');
  const [sessionTokensByPresetId, setSessionTokensByPresetId] = React.useState<Record<string, string>>({});
  const [savedTokenPresetIds, setSavedTokenPresetIds] = React.useState<Set<string>>(new Set());
  const [isAddingPreset, setIsAddingPreset] = React.useState(false);
  const [newPresetName, setNewPresetName] = React.useState('');
  const [newPresetHostname, setNewPresetHostname] = React.useState('');
  const [newPresetToken, setNewPresetToken] = React.useState('');
  const [bootstrapTtlMs, setBootstrapTtlMs] = React.useState<number | null>(30 * 60 * 1000);
  const [sessionTtlMs, setSessionTtlMs] = React.useState<number>(8 * 60 * 60 * 1000);
  const [remainingText, setRemainingText] = React.useState<string>('');
  const [sessionRecords, setSessionRecords] = React.useState<TunnelSessionRecord[]>([]);
  const [nowTs, setNowTs] = React.useState<number>(() => Date.now());
  const [localPort, setLocalPort] = React.useState<number | null>(null);
  const managedLocalConfigFileInputRef = React.useRef<HTMLInputElement>(null);
  const isManagedLocalConfigPathInvalid = React.useMemo(() => {
    if (!managedLocalConfigPath) {
      return false;
    }
    return !hasAllowedManagedLocalConfigExtension(managedLocalConfigPath);
  }, [managedLocalConfigPath]);

  const selectedPreset = React.useMemo(
    () => managedRemoteTunnelPresets.find((preset) => preset.id === selectedPresetId) || managedRemoteTunnelPresets[0] || null,
    [managedRemoteTunnelPresets, selectedPresetId]
  );
  const renderedSessionRecords = React.useMemo(() => {
    return sessionRecords.map((record) => {
      const isExpired = record.expiresAt <= nowTs;
      const isActive = record.status === 'active' && !isExpired;
      const remainingTextForSession = isActive
        ? formatRemaining(record.expiresAt - nowTs)
        : (record.inactiveReason === 'expired' || isExpired ? m.tunnelExpired() : m.tunnelInactive());
      const inactiveLabel = remainingTextForSession === m.tunnelExpired()
        ? m.tunnelExpired()
        : (record.inactiveReason === 'tunnel-revoked' ? m.tunnelRevoked() : m.tunnelInactive());

      const mode = toUiTunnelMode(record.mode);
      return {
        ...record,
        isActive,
        mode,
        remainingTextForSession,
        inactiveLabel,
      };
    });
  }, [nowTs, sessionRecords]);
  const isConnectLinkLive = React.useMemo(() => {
    if (!tunnelInfo?.connectUrl) {
      return false;
    }
    if (tunnelInfo.bootstrapExpiresAt === null) {
      return true;
    }
    return tunnelInfo.bootstrapExpiresAt > nowTs;
  }, [nowTs, tunnelInfo?.bootstrapExpiresAt, tunnelInfo?.connectUrl]);
  const isSelectedModeTunnelReady = React.useMemo(() => {
    if (!tunnelInfo) {
      return false;
    }
    if (state !== 'active' && state !== 'stopping') {
      return false;
    }
    return activeTunnelMode === tunnelMode;
  }, [activeTunnelMode, state, tunnelInfo, tunnelMode]);
  const willReplaceActiveTunnel = React.useMemo(() => {
    if (!tunnelInfo || state !== 'active') {
      return false;
    }
    if (!activeTunnelMode) {
      return false;
    }
    return activeTunnelMode !== tunnelMode;
  }, [activeTunnelMode, state, tunnelInfo, tunnelMode]);
  const suggestedConnectorPort = React.useMemo(() => {
    if (typeof localPort === 'number' && Number.isFinite(localPort) && localPort > 0) {
      return localPort;
    }
    if (typeof window === 'undefined') {
      return null;
    }
    const parsed = Number(window.location.port);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
    return null;
  }, [localPort]);
  const openExternal = React.useCallback(async (url: string) => {
    await openExternalUrl(url);
  }, []);

  const checkAvailabilityAndStatus = React.useCallback(async (signal: AbortSignal) => {
    try {
      const [checkRes, statusRes, settingsRes, providersRes] = await Promise.all([
        fetch('/api/openchamber/tunnel/check', { signal }),
        fetch('/api/openchamber/tunnel/status', { signal }),
        fetch('/api/config/settings', { signal, headers: { Accept: 'application/json' } }),
        fetch('/api/openchamber/tunnel/providers', { signal }),
      ]);

      const checkData = await checkRes.json();
      const statusData = (await statusRes.json()) as TunnelStatusResponse;
      const settingsData = settingsRes.ok ? await settingsRes.json() : {};
      const providersData = providersRes.ok ? await providersRes.json() : {};

      const loadedBootstrapTtl = statusData.ttlConfig?.bootstrapTtlMs
        ?? (settingsData?.tunnelBootstrapTtlMs === null
          ? null
          : typeof settingsData?.tunnelBootstrapTtlMs === 'number'
            ? settingsData.tunnelBootstrapTtlMs
            : 30 * 60 * 1000);
      const loadedSessionTtl = typeof statusData.ttlConfig?.sessionTtlMs === 'number'
        ? statusData.ttlConfig.sessionTtlMs
        : typeof settingsData?.tunnelSessionTtlMs === 'number'
          ? settingsData.tunnelSessionTtlMs
          : 8 * 60 * 60 * 1000;

      const loadedMode: TunnelMode = toUiTunnelMode(statusData.mode ?? settingsData?.tunnelMode);
      const loadedProvider = typeof settingsData?.tunnelProvider === 'string' && settingsData.tunnelProvider.trim().length > 0
        ? settingsData.tunnelProvider.trim().toLowerCase()
        : 'cloudflare';
      const loadedManagedLocalConfigPath = typeof settingsData?.managedLocalTunnelConfigPath === 'string'
        ? settingsData.managedLocalTunnelConfigPath.trim() || null
        : null;

      const loadedPresetsFromStatus = sanitizePresets(statusData?.managedRemoteTunnelPresets);
      const loadedHostname = typeof statusData.managedRemoteTunnelHostname === 'string'
        ? statusData.managedRemoteTunnelHostname
        : '';
      const presets = loadedPresetsFromStatus.length > 0
        ? loadedPresetsFromStatus
        : (loadedHostname
          ? [{
            id: `legacy-${normalizePresetHostname(loadedHostname)}`,
            name: loadedHostname,
            hostname: normalizePresetHostname(loadedHostname),
          }]
          : []);

      const selectedId = presets[0]?.id || '';

      setBootstrapTtlMs(loadedBootstrapTtl);
      setSessionTtlMs(loadedSessionTtl);
      setTunnelProvider(loadedProvider);
      setProviderCapabilities(Array.isArray(providersData?.providers) ? providersData.providers : []);
      setTunnelMode(loadedMode);
      setManagedLocalConfigPath(loadedManagedLocalConfigPath);
      setManagedRemoteTunnelPresets(presets);
      setSelectedPresetId(selectedId);
      setSessionRecords(Array.isArray(statusData.activeSessions) ? statusData.activeSessions : []);
      setActiveTunnelMode(
        statusData.activeTunnelMode
          ? toUiTunnelMode(statusData.activeTunnelMode)
          : (statusData.active && statusData.mode ? toUiTunnelMode(statusData.mode) : null)
      );
      setSavedTokenPresetIds(new Set(Array.isArray(statusData.managedRemoteTunnelTokenPresetIds) ? statusData.managedRemoteTunnelTokenPresetIds : []));
      setLocalPort(typeof statusData.localPort === 'number' ? statusData.localPort : null);

      if (statusData.active && statusData.url) {
        setTunnelInfo({
          url: statusData.url,
          connectUrl: null,
          bootstrapExpiresAt: typeof statusData.bootstrapExpiresAt === 'number' ? statusData.bootstrapExpiresAt : null,
        });
        setState('active');
        return;
      }

      setState(checkData.available ? 'idle' : 'not-available');
    } catch {
      if (!signal.aborted) {
        setState('error');
        setErrorMessage(m.tunnelToastAvailabilityFailed());
      }
    }
  }, []);

  React.useEffect(() => {
    const controller = new AbortController();
    void checkAvailabilityAndStatus(controller.signal);
    return () => controller.abort();
  }, [checkAvailabilityAndStatus]);

  React.useEffect(() => {
    if (!tunnelInfo?.connectUrl) {
      setQrDataUrl(null);
      return;
    }

    let cancelled = false;
    QRCode.toDataURL(tunnelInfo.connectUrl, {
      width: 256,
      margin: 2,
      color: { dark: '#000000', light: '#ffffff' },
    }).then((dataUrl) => {
      if (!cancelled) {
        setQrDataUrl(dataUrl);
      }
    }).catch(() => {
      if (!cancelled) {
        setQrDataUrl(null);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [tunnelInfo?.connectUrl]);

  React.useEffect(() => {
    if (!tunnelInfo?.bootstrapExpiresAt) {
      setRemainingText(m.tunnelNoExpiry());
      return;
    }

    let rafId: number | null = null;
    let lastTime = Date.now();
    
    const updateRemaining = () => {
      const remaining = tunnelInfo.bootstrapExpiresAt ? tunnelInfo.bootstrapExpiresAt - Date.now() : 0;
      if (remaining <= 0) {
        setRemainingText(m.tunnelExpired());
      } else {
        setRemainingText(formatRemaining(remaining));
      }
    };

    const tick = () => {
      const now = Date.now();
      // Update only once per second
      if (now - lastTime >= 1_000) {
        updateRemaining();
        lastTime = now;
      }
      rafId = requestAnimationFrame(tick);
    };

    updateRemaining();
    
    // Only run when visible
    if (typeof document === 'undefined' || document.visibilityState === 'visible') {
      rafId = requestAnimationFrame(tick);
    }
    
    const onVisibility = () => {
      if (document.visibilityState === 'visible' && rafId === null) {
        rafId = requestAnimationFrame(tick);
      } else if (document.visibilityState !== 'visible' && rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
    };
    
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
      }
    };
  }, [tunnelInfo?.bootstrapExpiresAt]);

  React.useEffect(() => {
    // Use requestAnimationFrame for smoother updates without setInterval overhead
    let rafId: number | null = null;
    let lastTime = Date.now();
    
    const tick = () => {
      const now = Date.now();
      // Update only once per second
      if (now - lastTime >= 1_000) {
        setNowTs(now);
        lastTime = now;
      }
      rafId = requestAnimationFrame(tick);
    };
    
    // Only run when visible
    if (typeof document === 'undefined' || document.visibilityState === 'visible') {
      rafId = requestAnimationFrame(tick);
    }
    
    const onVisibility = () => {
      if (document.visibilityState === 'visible' && rafId === null) {
        rafId = requestAnimationFrame(tick);
      } else if (document.visibilityState !== 'visible' && rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
    };
    
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
      }
    };
  }, []);

  React.useEffect(() => {
    if (state === 'starting' || state === 'stopping' || state === 'checking') {
      return;
    }

    let cancelled = false;
    const refreshSessions = async () => {
      try {
        const statusRes = await fetch('/api/openchamber/tunnel/status');
        if (!statusRes.ok || cancelled) {
          return;
        }
        const statusData = (await statusRes.json()) as TunnelStatusResponse;
        if (cancelled) {
          return;
        }
        setSessionRecords(Array.isArray(statusData.activeSessions) ? statusData.activeSessions : []);
        setSavedTokenPresetIds(new Set(Array.isArray(statusData.managedRemoteTunnelTokenPresetIds) ? statusData.managedRemoteTunnelTokenPresetIds : []));
        setLocalPort(typeof statusData.localPort === 'number' ? statusData.localPort : null);
      } catch {
        // ignore transient refresh failures
      }
    };

    const timer = window.setInterval(() => {
      // Skip polling when tab is hidden
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
        return;
      }
      void refreshSessions();
    }, 5000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [state]);

  const saveTunnelSettings = React.useCallback(async (payload: {
    tunnelProvider?: string;
    tunnelMode?: TunnelMode;
    managedLocalTunnelConfigPath?: string | null;
    managedRemoteTunnelPresets?: ManagedRemoteTunnelPreset[];
    managedRemoteTunnelPresetTokens?: Record<string, string>;
    tunnelBootstrapTtlMs?: number | null;
    tunnelSessionTtlMs?: number;
  }) => {
    setIsSavingMode(true);
    try {
      await updateDesktopSettings(payload);
      if (Object.prototype.hasOwnProperty.call(payload, 'tunnelMode') && payload.tunnelMode) {
        setTunnelMode(payload.tunnelMode);
      }
      if (Object.prototype.hasOwnProperty.call(payload, 'tunnelProvider') && typeof payload.tunnelProvider === 'string') {
        setTunnelProvider(payload.tunnelProvider);
      }
      if (Object.prototype.hasOwnProperty.call(payload, 'managedLocalTunnelConfigPath')) {
        setManagedLocalConfigPath(payload.managedLocalTunnelConfigPath ?? null);
      }
      if (Object.prototype.hasOwnProperty.call(payload, 'managedRemoteTunnelPresets') && payload.managedRemoteTunnelPresets) {
        setManagedRemoteTunnelPresets(payload.managedRemoteTunnelPresets);
      }
    } catch {
      toast.error(m.tunnelToastSaveFailed());
    } finally {
      setIsSavingMode(false);
    }
  }, []);

  const saveTtlSettings = React.useCallback(async (nextBootstrapTtlMs: number | null, nextSessionTtlMs: number) => {
    setIsSavingTtl(true);
    try {
      await updateDesktopSettings({
        tunnelBootstrapTtlMs: nextBootstrapTtlMs,
        tunnelSessionTtlMs: nextSessionTtlMs,
      });
    } catch {
      toast.error(m.tunnelToastTtlSaveFailed());
    } finally {
      setIsSavingTtl(false);
    }
  }, []);

  const persistManagedRemoteTunnelToken = React.useCallback(async (payload: {
    presetId: string;
    presetName: string;
    hostname: string;
    token: string;
  }) => {
    const token = payload.token.trim();
    if (!token) {
      return;
    }

    try {
      const tokenMap = {
        ...sessionTokensByPresetId,
        [payload.presetId]: token,
      };
      await updateDesktopSettings({
        managedRemoteTunnelPresetTokens: tokenMap,
      });
      setSavedTokenPresetIds((prev) => {
        const next = new Set(prev);
        next.add(payload.presetId);
        return next;
      });
    } catch {
      toast.error(m.tunnelToastTokenSaveFailed());
    }
  }, [sessionTokensByPresetId]);

  const handleProviderChange = React.useCallback(async (provider: string) => {
    setManagedRemoteValidationError(null);
    setErrorMessage(null);
    await saveTunnelSettings({ tunnelProvider: provider });
  }, [saveTunnelSettings]);

  const handleBrowseManagedLocalConfig = React.useCallback(async () => {
    const result = await requestFileAccess({
      filters: [{ name: 'Config', extensions: ['yml', 'yaml', 'json'] }],
    });

    if (result.success && typeof result.path === 'string' && result.path.trim().length > 0) {
      const nextPath = result.path.trim();
      if (!hasAllowedManagedLocalConfigExtension(nextPath)) {
        toast.error(m.tunnelConfigExtensionError());
        return;
      }
      setManagedLocalConfigPath(nextPath);
      await saveTunnelSettings({ managedLocalTunnelConfigPath: nextPath });
      return;
    }

    managedLocalConfigFileInputRef.current?.click();
  }, [saveTunnelSettings]);

  const handleManagedLocalConfigInputChange = React.useCallback((value: string) => {
    const trimmed = value.trim();
    setManagedLocalConfigPath(trimmed.length > 0 ? trimmed : null);
  }, []);

  const handleManagedLocalConfigInputBlur = React.useCallback(async () => {
    if (managedLocalConfigPath && !hasAllowedManagedLocalConfigExtension(managedLocalConfigPath)) {
      toast.error(m.tunnelConfigExtensionError());
      return;
    }
    await saveTunnelSettings({ managedLocalTunnelConfigPath: managedLocalConfigPath });
  }, [managedLocalConfigPath, saveTunnelSettings]);

  const handleManagedLocalConfigClear = React.useCallback(async () => {
    setManagedLocalConfigPath(null);
    await saveTunnelSettings({ managedLocalTunnelConfigPath: null });
  }, [saveTunnelSettings]);

  const handleManagedLocalConfigFileSelected = React.useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const selected = event.target.files?.[0];
    if (!selected) {
      return;
    }

    const fallbackPath = selected.name.trim();
    if (fallbackPath.length === 0) {
      return;
    }
    if (!hasAllowedManagedLocalConfigExtension(fallbackPath)) {
      toast.error(m.tunnelConfigExtensionError());
      return;
    }

    setManagedLocalConfigPath(fallbackPath);
    await saveTunnelSettings({ managedLocalTunnelConfigPath: fallbackPath });
    event.target.value = '';
  }, [saveTunnelSettings]);

  const handleStart = React.useCallback(async () => {
    setErrorMessage(null);
    setManagedRemoteValidationError(null);

    if (tunnelMode === 'managed-local' && managedLocalConfigPath && !hasAllowedManagedLocalConfigExtension(managedLocalConfigPath)) {
      setErrorMessage(m.tunnelConfigExtensionError());
      toast.error(m.tunnelConfigExtensionError());
      return;
    }

    setState('starting');

    try {
      let managedRemoteTunnelHostname = '';
      let managedRemoteTunnelToken = '';

      if (tunnelMode === 'managed-remote') {
        if (!selectedPreset) {
          setState('idle');
           setManagedRemoteValidationError(m.tunnelToastSelectTunnelFirst());
          toast.error(m.tunnelToastSelectTunnelFirst());
          return;
        }

        managedRemoteTunnelHostname = selectedPreset.hostname;
        managedRemoteTunnelToken = (sessionTokensByPresetId[selectedPreset.id] || '').trim();

        await saveTunnelSettings({
          tunnelMode: 'managed-remote',
          managedRemoteTunnelPresets,
        });
      }

      const res = await fetch('/api/openchamber/tunnel/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: tunnelProvider,
          mode: tunnelMode,
          ...(tunnelMode === 'managed-remote' && selectedPreset ? {
            managedRemoteTunnelPresetId: selectedPreset.id,
            managedRemoteTunnelPresetName: selectedPreset.name,
          } : {}),
          ...(tunnelMode === 'managed-remote' && managedRemoteTunnelHostname ? { managedRemoteTunnelHostname } : {}),
          ...(tunnelMode === 'managed-remote' && managedRemoteTunnelToken ? { managedRemoteTunnelToken } : {}),
          ...(tunnelMode === 'managed-local' && managedLocalConfigPath ? { configPath: managedLocalConfigPath } : {}),
        }),
      });
      const data = (await res.json()) as TunnelStartResponse;

      if (!res.ok || !data.ok) {
        if (tunnelMode === 'managed-remote' && typeof data.error === 'string' && data.error.includes('Managed remote tunnel token is required')) {
          setState('idle');
          setManagedRemoteValidationError(m.tunnelToastTokenRequiredBeforeStart());
          toast.error(m.tunnelToastTokenRequiredBeforeStart());
          return;
        }
        setState('error');
        setErrorMessage(data.error || m.tunnelToastStartFailed());
        toast.error(data.error || m.tunnelToastStartFailed());
        return;
      }

      const startedUrl = typeof data.url === 'string' ? data.url : '';
      if (!startedUrl) {
        setState('error');
        setErrorMessage(m.tunnelToastNoPublicUrl());
        toast.error(m.tunnelToastNoPublicUrl());
        return;
      }

      setTunnelInfo({
        url: startedUrl,
        connectUrl: typeof data.connectUrl === 'string' ? data.connectUrl : null,
        bootstrapExpiresAt: typeof data.bootstrapExpiresAt === 'number' ? data.bootstrapExpiresAt : null,
      });
      setActiveTunnelMode(
        data.activeTunnelMode
          ? toUiTunnelMode(data.activeTunnelMode)
          : (data.mode ? toUiTunnelMode(data.mode) : tunnelMode)
      );
      setSessionRecords(Array.isArray(data.activeSessions) ? data.activeSessions : []);
      if (Array.isArray(data.managedRemoteTunnelTokenPresetIds)) {
        setSavedTokenPresetIds(new Set(data.managedRemoteTunnelTokenPresetIds));
      }
      if (typeof data.localPort === 'number') {
        setLocalPort(data.localPort);
      }
      if (typeof data.mode === 'string') {
        setTunnelMode(toUiTunnelMode(data.mode));
      }
      setState('active');
      if (data.replacedTunnel) {
        const revokedBootstrapCount = typeof data.revokedBootstrapCount === 'number' ? data.revokedBootstrapCount : 0;
        const invalidatedSessionCount = typeof data.invalidatedSessionCount === 'number' ? data.invalidatedSessionCount : 0;
        toast.warning(m.tunnelToastReplaced({ links: revokedBootstrapCount, sessions: invalidatedSessionCount }));
      } else {
        toast.success(m.tunnelToastLinkReady());
      }
    } catch {
      setState('error');
      setErrorMessage(m.tunnelToastStartFailed());
      toast.error(m.tunnelToastStartFailed());
    }
  }, [
    managedRemoteTunnelPresets,
    saveTunnelSettings,
    selectedPreset,
    sessionTokensByPresetId,
    tunnelProvider,
    tunnelMode,
    managedLocalConfigPath,
  ]);

  const handleStop = React.useCallback(async () => {
    setState('stopping');

    try {
      await fetch('/api/openchamber/tunnel/stop', { method: 'POST' });
      const statusRes = await fetch('/api/openchamber/tunnel/status');
      if (statusRes.ok) {
        const statusData = (await statusRes.json()) as TunnelStatusResponse;
        setSessionRecords(Array.isArray(statusData.activeSessions) ? statusData.activeSessions : []);
        setSavedTokenPresetIds(new Set(Array.isArray(statusData.managedRemoteTunnelTokenPresetIds) ? statusData.managedRemoteTunnelTokenPresetIds : []));
        setLocalPort(typeof statusData.localPort === 'number' ? statusData.localPort : null);
      }
      setTunnelInfo(null);
      setActiveTunnelMode(null);
      setQrDataUrl(null);
      setState('idle');
      toast.success(m.tunnelToastStopped());
    } catch {
      setState('error');
      setErrorMessage(m.tunnelToastStopFailed());
      toast.error(m.tunnelToastStopFailed());
    }
  }, []);

  const handleCopyUrl = React.useCallback(async () => {
    if (!tunnelInfo?.connectUrl) {
      return;
    }

    try {
      await navigator.clipboard.writeText(tunnelInfo.connectUrl);
      setCopied(true);
        toast.success(m.tunnelToastConnectLinkCopied());
      setTimeout(() => setCopied(false), 2000);
    } catch {
        toast.error(m.tunnelToastCopyFailed());
    }
  }, [tunnelInfo?.connectUrl]);

  const handleBootstrapTtlChange = React.useCallback(async (value: string) => {
    const option = BOOTSTRAP_TTL_OPTIONS.find((entry) => entry.value === value);
    if (!option) {
      return;
    }
    setBootstrapTtlMs(option.ms);
    await saveTtlSettings(option.ms, sessionTtlMs);
  }, [saveTtlSettings, sessionTtlMs]);

  const handleSessionTtlChange = React.useCallback(async (value: string) => {
    const option = SESSION_TTL_OPTIONS.find((entry) => entry.value === value);
    if (!option || option.ms === null) {
      return;
    }
    setSessionTtlMs(option.ms);
    await saveTtlSettings(bootstrapTtlMs, option.ms);
  }, [bootstrapTtlMs, saveTtlSettings]);

  const handleModeChange = React.useCallback(async (value: TunnelMode) => {
    setManagedRemoteValidationError(null);
    setErrorMessage(null);
    if (state !== 'active' && state !== 'stopping' && state !== 'starting') {
      setState('idle');
    }

    await saveTunnelSettings({
      tunnelMode: value,
      managedRemoteTunnelPresets,
    });
  }, [managedRemoteTunnelPresets, saveTunnelSettings, state]);

  const persistSelectedPreset = React.useCallback(async (preset: ManagedRemoteTunnelPreset, presets: ManagedRemoteTunnelPreset[]) => {
    try {
      await updateDesktopSettings({
        managedRemoteTunnelPresets: presets,
      });
    } catch {
      toast.error(m.tunnelToastSaveSelectedFailed());
    }
  }, []);

  const handleSelectPreset = React.useCallback((presetId: string) => {
    const preset = managedRemoteTunnelPresets.find((entry) => entry.id === presetId);
    if (!preset) {
      return;
    }

    setSelectedPresetId(preset.id);
    setManagedRemoteValidationError(null);
    void persistSelectedPreset(preset, managedRemoteTunnelPresets);
  }, [managedRemoteTunnelPresets, persistSelectedPreset]);

  const handleSaveNewPreset = React.useCallback(async () => {
    const name = newPresetName.trim();
    const hostname = normalizePresetHostname(newPresetHostname);
    const token = newPresetToken.trim();

    if (!name) {
      toast.error(m.tunnelToastNameRequired());
      return;
    }
    if (!hostname) {
      toast.error(m.tunnelToastHostnameRequired());
      return;
    }
    if (!token) {
      toast.error(m.tunnelToastTokenRequired());
      return;
    }

    if (managedRemoteTunnelPresets.some((preset) => preset.hostname === hostname)) {
      toast.error(m.tunnelToastHostnameExists());
      return;
    }

    const nextPreset: ManagedRemoteTunnelPreset = {
      id: createPresetId(),
      name,
      hostname,
    };
    const nextPresets = [...managedRemoteTunnelPresets, nextPreset];

    setManagedRemoteTunnelPresets(nextPresets);
    setSelectedPresetId(nextPreset.id);
    setExpandedManagedRemoteTunnels((prev) => ({ ...prev, [nextPreset.id]: true }));
    setSessionTokensByPresetId((prev) => ({ ...prev, [nextPreset.id]: token }));
    setManagedRemoteValidationError(null);
    setIsAddingPreset(false);
    setNewPresetName('');
    setNewPresetHostname('');
    setNewPresetToken('');

    await saveTunnelSettings({
      tunnelMode: 'managed-remote',
      managedRemoteTunnelPresets: nextPresets,
      managedRemoteTunnelPresetTokens: {
        ...sessionTokensByPresetId,
        [nextPreset.id]: token,
      },
    });
    await persistManagedRemoteTunnelToken({
      presetId: nextPreset.id,
      presetName: nextPreset.name,
      hostname: nextPreset.hostname,
      token,
    });
    toast.success(m.tunnelToastSaved());
  }, [managedRemoteTunnelPresets, newPresetHostname, newPresetName, newPresetToken, persistManagedRemoteTunnelToken, saveTunnelSettings, sessionTokensByPresetId]);

  const handleRemovePreset = React.useCallback(async (presetId: string) => {
    const preset = managedRemoteTunnelPresets.find((entry) => entry.id === presetId);
    if (!preset) {
      return;
    }

    const nextPresets = managedRemoteTunnelPresets.filter((entry) => entry.id !== preset.id);
    const fallbackSelectedId = nextPresets[0]?.id || '';
    const nextSelectedId = selectedPresetId === preset.id ? fallbackSelectedId : selectedPresetId;
    const nextTokenMap = Object.fromEntries(
      Object.entries(sessionTokensByPresetId)
        .filter(([id, tokenValue]) => id !== preset.id && tokenValue.trim().length > 0)
    );

    setManagedRemoteTunnelPresets(nextPresets);
    setSelectedPresetId(nextSelectedId);
    setExpandedManagedRemoteTunnels((prev) => {
      const next = { ...prev };
      delete next[preset.id];
      return next;
    });
    setSessionTokensByPresetId((prev) => {
      const next = { ...prev };
      delete next[preset.id];
      return next;
    });
    setSavedTokenPresetIds((prev) => {
      const next = new Set(prev);
      next.delete(preset.id);
      return next;
    });
    setManagedRemoteValidationError(null);

    await saveTunnelSettings({
      managedRemoteTunnelPresets: nextPresets,
      managedRemoteTunnelPresetTokens: nextTokenMap,
    });

    toast.success(m.tunnelToastRemoved());
  }, [managedRemoteTunnelPresets, saveTunnelSettings, selectedPresetId, sessionTokensByPresetId]);

  const primaryCtaClass = 'gap-2 border-[var(--primary-base)] bg-[var(--primary-base)] text-[var(--primary-foreground)] hover:bg-[var(--primary-hover)] hover:text-[var(--primary-foreground)]';

  if (state === 'checking') {
    return (
      <div className="flex items-center justify-center py-12">
        <GridLoader size="sm" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="typography-ui-header font-semibold text-foreground">{m.tunnelTitle()}</h3>
        <p className="typography-meta mt-0 text-muted-foreground/70">
          {m.tunnelDescription()}
        </p>
        <p className="typography-meta mt-0 text-muted-foreground/60">
          {m.tunnelServerEnforced()}
        </p>
        <p className="typography-meta mt-0 text-muted-foreground/60">
          {m.tunnelConnectLinkPolicy()}
        </p>
      </div>

      {renderedSessionRecords.length > 0 && (
        <section className="space-y-2 px-2 pb-2 pt-0">
          <div className="rounded-lg border border-[var(--status-info-border)] bg-[var(--status-info-background)]/30 p-3">
            <div className="mb-2 flex items-center gap-2">
              <RiInformationLine className="size-4 text-[var(--status-info)]" />
              <p className="typography-ui-label text-foreground">{m.tunnelRedeemedLinks()}</p>
            </div>
            <div className="space-y-1">
              {renderedSessionRecords.map((record) => {
                const isQuick = record.mode === 'quick';
                const isManagedRemote = record.mode === 'managed-remote';
                const modeBadgeClass = isQuick
                  ? 'border-[var(--status-warning-border)] bg-[var(--status-warning-background)] text-[var(--status-warning)]'
                  : isManagedRemote
                    ? 'border-[var(--status-info-border)] bg-[var(--status-info-background)] text-[var(--status-info)]'
                    : 'border-[var(--status-success-border)] bg-[var(--status-success-background)] text-[var(--status-success)]';
                const statusDotClass = record.isActive
                  ? (isQuick ? 'text-[var(--status-warning)]' : isManagedRemote ? 'text-[var(--status-info)]' : 'text-[var(--status-success)]')
                  : 'text-muted-foreground/50';
                const modeLabel = isQuick ? m.tunnelModeBadgeQuick() : isManagedRemote ? m.tunnelModeBadgeRemote() : m.tunnelModeBadgeLocal();

                return (
                  <div
                    key={record.sessionId}
                    className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded border border-[var(--surface-subtle)] bg-[var(--surface-elevated)] px-2 py-1.5"
                  >
                    <RiCheckboxBlankCircleFill className={cn('size-2.5 shrink-0', statusDotClass)} />
                    <span className={cn('typography-micro rounded border px-1.5 py-0.5 uppercase', modeBadgeClass)}>
                      {modeLabel}
                    </span>
                    <span className="typography-meta text-muted-foreground/80">
                      {m.tunnelRedeemed({ time: formatAbsoluteTime(record.createdAt) })}
                    </span>
                    <span className="typography-meta text-foreground">
                      {record.isActive
                        ? m.tunnelExpiresIn({ time: record.remainingTextForSession })
                        : (record.inactiveLabel === m.tunnelInactive() ? m.tunnelInactive() : `${m.tunnelInactive()} (${record.inactiveLabel})`)}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </section>
      )}

      {state === 'not-available' && (
        <section className="space-y-2 px-2 pb-2 pt-0">
          <div className="flex items-start gap-2 rounded-lg border border-[var(--status-warning)]/30 bg-[var(--status-warning)]/5 p-3">
            <RiErrorWarningLine className="mt-0.5 size-4 shrink-0 text-[var(--status-warning)]" />
            <div className="space-y-1">
                <p className="typography-meta font-medium text-foreground">{m.tunnelCloudflaredNotFound()}</p>
                <p className="typography-meta text-muted-foreground/70">{m.tunnelInstallHint()}</p>
              <code className="typography-code block rounded bg-muted/50 px-2 py-1 text-xs text-foreground">
                brew install cloudflared
              </code>
            </div>
          </div>
        </section>
      )}

      {state !== 'not-available' && (
        <section className="space-y-4 px-2 pb-2 pt-0">
          <div className="space-y-3">
            <div className="space-y-1.5">
              <p className="typography-ui-label text-foreground">{m.tunnelProvider()}</p>
              <Select
                value={tunnelProvider}
                onValueChange={(value) => {
                  void handleProviderChange(value);
                }}
                disabled={isSavingMode || state === 'starting' || state === 'stopping'}
              >
                <SelectTrigger className="max-w-[16rem]">
                  <SelectValue placeholder={m.tunnelSelectProvider()} />
                </SelectTrigger>
                <SelectContent>
                  {providerCapabilities.length > 0
                    ? providerCapabilities.map((capability) => (
                      <SelectItem key={capability.provider} value={capability.provider}>
                        <ProviderOptionLabel provider={capability.provider} />
                      </SelectItem>
                    ))
                    : (
                      <SelectItem value="cloudflare">
                        <ProviderOptionLabel provider="cloudflare" />
                      </SelectItem>
                    )}
                  <SelectItem value="__more-soon" disabled>{m.tunnelMoreProvidersSoon()}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <p className="typography-ui-label text-foreground">{m.tunnelType()}</p>
              <div className="flex flex-wrap items-center gap-1">
                {getTunnelModeOptions().map((option) => (
                  <Tooltip key={option.value} delayDuration={700}>
                    <TooltipTrigger asChild>
                      <Button
                        variant="outline"
                        size="xs"
                        className={cn(
                          '!font-normal',
                          tunnelMode === option.value
                            ? 'border-[var(--primary-base)] text-[var(--primary-base)] bg-[var(--primary-base)]/10 hover:text-[var(--primary-base)]'
                            : 'text-foreground'
                        )}
                        onClick={() => {
                          void handleModeChange(option.value);
                        }}
                        disabled={isSavingMode || state === 'starting' || state === 'stopping'}
                      >
                        {option.label}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent sideOffset={8} className="max-w-xs">
                      {option.tooltip}
                    </TooltipContent>
                  </Tooltip>
                ))}
              </div>
            </div>
          </div>

          <div className="mt-2 grid grid-cols-1 gap-2 py-1.5 md:grid-cols-[14rem_auto] md:gap-x-8 md:gap-y-2">
            <div className="flex min-w-0 items-center gap-2">
              <span className="typography-ui-label shrink-0 text-foreground">{m.tunnelConnectLinkTtl()}</span>
              <Select
                value={ttlOptionValue(BOOTSTRAP_TTL_OPTIONS, bootstrapTtlMs, '1800000')}
                onValueChange={(value) => {
                  void handleBootstrapTtlChange(value);
                }}
                disabled={isSavingTtl || isSavingMode || state === 'starting' || state === 'stopping'}
              >
                <SelectTrigger className="max-w-[11rem] min-w-0">
                  <SelectValue className="truncate" />
                </SelectTrigger>
                <SelectContent>
                  {BOOTSTRAP_TTL_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex min-w-0 items-center gap-2">
              <span className="typography-ui-label shrink-0 text-foreground">{m.tunnelSessionTtl()}</span>
              <Select
                value={ttlOptionValue(SESSION_TTL_OPTIONS, sessionTtlMs, '28800000')}
                onValueChange={(value) => {
                  void handleSessionTtlChange(value);
                }}
                disabled={isSavingTtl || isSavingMode || state === 'starting' || state === 'stopping'}
              >
                <SelectTrigger className="max-w-[11rem] min-w-0">
                  <SelectValue className="truncate" />
                </SelectTrigger>
                <SelectContent>
                  {SESSION_TTL_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {tunnelMode === 'quick' && (
            <div className="rounded-lg border border-[var(--status-warning)]/35 bg-[var(--status-warning)]/10 p-3">
              <div className="flex items-start gap-2">
                <RiErrorWarningLine className="mt-0.5 size-4 shrink-0 text-[var(--status-warning)]" />
                <div>
                    <p className="typography-meta text-[var(--status-warning)]">
                      {m.tunnelQuickWarning()}
                    </p>
                    <p className="typography-meta mt-1 text-[var(--status-warning)]">
                      {m.tunnelQuickAlternative()}
                    </p>
                </div>
              </div>
            </div>
          )}

          {tunnelMode === 'managed-remote' && (
            <div className="space-y-2 rounded-lg border border-[var(--interactive-border)] bg-[var(--surface-elevated)] p-3">
              {typeof suggestedConnectorPort === 'number' && (
                <div className="rounded-md border border-[var(--status-info-border)] bg-[var(--status-info-background)]/35 px-2 py-1.5">
                  <p className="typography-meta text-[var(--status-info)]">
                    {m.tunnelConnectorTarget({ url: `http://localhost:${suggestedConnectorPort}` })}
                  </p>
                </div>
              )}

              <div className="mb-1 flex items-center justify-between gap-3">
                <p className="typography-ui-label text-foreground">{m.tunnelSavedTunnels()}</p>
                <Button
                  variant="ghost"
                  size="xs"
                  className="!font-normal"
                  onClick={() => setIsAddingPreset((prev) => !prev)}
                  disabled={state === 'starting' || state === 'stopping' || isSavingMode}
                >
                  <RiAddLine className="h-3.5 w-3.5" />
                  Add
                </Button>
              </div>

              {managedRemoteTunnelPresets.length > 0 ? (
                <div className="overflow-hidden rounded-md border border-[var(--surface-subtle)]">
                  {managedRemoteTunnelPresets.map((preset, index) => {
                    const rowToken = sessionTokensByPresetId[preset.id] || '';
                    const hasSavedToken = savedTokenPresetIds.has(preset.id);
                    const isOpen = expandedManagedRemoteTunnels[preset.id] ?? false;

                    return (
                      <div
                        key={preset.id}
                        className={cn(index < managedRemoteTunnelPresets.length - 1 && 'border-b border-[var(--surface-subtle)]')}
                      >
                        <Collapsible
                          open={isOpen}
                          onOpenChange={(open) => {
                            setExpandedManagedRemoteTunnels((prev) => ({ ...prev, [preset.id]: open }));
                            if (open) {
                              void handleSelectPreset(preset.id);
                            }
                          }}
                          className="py-1.5"
                        >
                          <div className="flex items-start gap-2 px-3">
                            <CollapsibleTrigger
                              type="button"
                              className="group flex-1 justify-start gap-2 rounded-md px-0 py-1 pr-1 text-left hover:bg-[var(--interactive-hover)]"
                              disabled={state === 'starting' || state === 'stopping' || isSavingMode}
                            >
                              {isOpen
                                ? <RiArrowDownSLine className="h-4 w-4 text-muted-foreground" />
                                : <RiArrowRightSLine className="h-4 w-4 text-muted-foreground" />}
                              <span className="typography-ui-label min-w-0 flex-1 truncate text-foreground">{preset.name}</span>
                            </CollapsibleTrigger>

                            <Button
                              variant="ghost"
                              size="xs"
                              className="h-7 w-7 p-0 text-muted-foreground hover:text-[var(--status-error)]"
                              aria-label={`Remove ${preset.name}`}
                              onClick={() => {
                                void handleRemovePreset(preset.id);
                              }}
                              disabled={state === 'starting' || state === 'stopping' || isSavingMode}
                            >
                              <RiDeleteBinLine className="h-3.5 w-3.5" />
                            </Button>
                          </div>

                          <CollapsibleContent className="pt-1.5">
                            <div className="space-y-1 px-3 pb-2">
                              <p className="typography-meta text-muted-foreground/70">Hostname: <code>{preset.hostname}</code></p>
                              <Input
                                type="password"
                                value={rowToken}
                                onChange={(event) => {
                                  const nextValue = event.target.value;
                                  setManagedRemoteValidationError(null);
                                  setSessionTokensByPresetId((prev) => ({ ...prev, [preset.id]: nextValue }));
                                }}
                                onBlur={(event) => {
                                  const tokenToSave = event.currentTarget.value.trim();
                                  if (!tokenToSave) {
                                    return;
                                  }
                                  void persistManagedRemoteTunnelToken({
                                    presetId: preset.id,
                                    presetName: preset.name,
                                    hostname: preset.hostname,
                                    token: tokenToSave,
                                  });
                                }}
                                placeholder={hasSavedToken ? m.tunnelTokenSavedOptional() : m.tunnelPasteToken()}
                                className="h-7"
                                disabled={state === 'starting' || state === 'stopping'}
                              />
                              <div className="flex items-center justify-end">
                                <Button
                                  variant="ghost"
                                  size="xs"
                                  className="!font-normal"
                                  disabled={state === 'starting' || state === 'stopping' || rowToken.trim().length === 0}
                                  onClick={() => {
                                    void persistManagedRemoteTunnelToken({
                                      presetId: preset.id,
                                      presetName: preset.name,
                                      hostname: preset.hostname,
                                      token: rowToken,
                                    });
                                  }}
                                >
                                  {m.tunnelSaveToken()}
                                </Button>
                              </div>
                            </div>
                          </CollapsibleContent>
                        </Collapsible>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="typography-meta text-muted-foreground/70">{m.tunnelNoSavedTunnels()}</p>
              )}

              {isAddingPreset && (
                <div className="space-y-2 rounded-md border border-[var(--surface-subtle)] p-2">
                  <Input
                    value={newPresetName}
                    onChange={(event) => setNewPresetName(event.target.value)}
                    placeholder={m.tunnelNamePlaceholder()}
                    className="h-7"
                    disabled={isSavingMode || state === 'starting' || state === 'stopping'}
                  />
                  <Input
                    value={newPresetHostname}
                    onChange={(event) => setNewPresetHostname(event.target.value)}
                    placeholder={m.tunnelHostnamePlaceholder()}
                    className="h-7"
                    disabled={isSavingMode || state === 'starting' || state === 'stopping'}
                  />
                  <Input
                    type="password"
                    value={newPresetToken}
                    onChange={(event) => setNewPresetToken(event.target.value)}
                    placeholder={m.tunnelTokenPlaceholder()}
                    className="h-7"
                    disabled={isSavingMode || state === 'starting' || state === 'stopping'}
                  />
                  {typeof suggestedConnectorPort === 'number' && (
                    <p className="typography-meta text-muted-foreground/70">
                      {m.tunnelConnectorHint({ url: `http://localhost:${suggestedConnectorPort}` })}
                    </p>
                  )}
                  <div className="flex items-center gap-2">
                    <Button
                      variant="ghost"
                      size="xs"
                      className="!font-normal"
                      onClick={() => {
                        void handleSaveNewPreset();
                      }}
                      disabled={isSavingMode || state === 'starting' || state === 'stopping'}
                    >
                      {m.commonSave()}
                    </Button>
                    <Button
                      variant="ghost"
                      size="xs"
                      className="!font-normal"
                      onClick={() => {
                        setIsAddingPreset(false);
                        setNewPresetName('');
                        setNewPresetHostname('');
                        setNewPresetToken('');
                      }}
                      disabled={isSavingMode || state === 'starting' || state === 'stopping'}
                    >
                      {m.commonCancel()}
                    </Button>
                  </div>
                </div>
              )}

              <div className="flex items-center gap-1.5">
                <p className="typography-meta text-muted-foreground/80">{m.tunnelTokensSavedHint()}</p>
                <Tooltip delayDuration={700}>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      className="rounded p-0.5 text-muted-foreground/70 hover:text-foreground"
                      aria-label={m.tunnelManagedRemoteTokenInfo()}
                    >
                      <RiInformationLine className="h-3.5 w-3.5" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent sideOffset={8} className="max-w-xs">
                    {m.tunnelTokensLocationHint()}
                  </TooltipContent>
                </Tooltip>
              </div>

              {!selectedPreset && managedRemoteValidationError && (
                <p className="typography-meta text-[var(--status-error)]">{managedRemoteValidationError}</p>
              )}
            </div>
          )}

          {tunnelMode === 'managed-local' && (
            <div className="space-y-2 rounded-lg border border-[var(--interactive-border)] bg-[var(--surface-elevated)] p-3">
              <div className="space-y-1.5">
                <p className="typography-ui-label text-foreground">{m.tunnelConfigFile()}</p>
                <input
                  ref={managedLocalConfigFileInputRef}
                  type="file"
                  accept=".yml,.yaml,.json"
                  className="hidden"
                  onChange={(event) => {
                    void handleManagedLocalConfigFileSelected(event);
                  }}
                />
                <div className="flex items-center gap-2">
                  <Input
                    value={managedLocalConfigPath || ''}
                    onChange={(event) => {
                      handleManagedLocalConfigInputChange(event.target.value);
                    }}
                    onBlur={() => {
                      void handleManagedLocalConfigInputBlur();
                    }}
                    placeholder={m.tunnelConfigDefault()}
                    className="h-7"
                    disabled={state === 'starting' || state === 'stopping' || isSavingMode}
                  />
                  <Button
                    variant="outline"
                    size="xs"
                    className="h-7 w-7 p-0"
                    aria-label={m.tunnelBrowseConfig()}
                    onClick={() => {
                      void handleBrowseManagedLocalConfig();
                    }}
                    disabled={state === 'starting' || state === 'stopping' || isSavingMode}
                  >
                    <RiFolderLine className="size-3.5" />
                  </Button>
                  {managedLocalConfigPath && (
                    <Button
                      variant="ghost"
                      size="xs"
                      className="h-7 w-7 p-0"
                      aria-label={m.tunnelClearConfig()}
                      onClick={() => {
                        void handleManagedLocalConfigClear();
                      }}
                      disabled={state === 'starting' || state === 'stopping' || isSavingMode}
                    >
                      <RiCloseLine className="size-3.5" />
                    </Button>
                  )}
                </div>
                <p className="typography-meta text-muted-foreground/70">
                  {managedLocalConfigPath
                    ? m.tunnelConfigCustom()
                    : m.tunnelConfigEmpty()}
                </p>
                {isManagedLocalConfigPathInvalid && (
                  <p className="typography-meta text-[var(--status-error)]">{m.tunnelConfigExtensionError()}</p>
                )}
              </div>
            </div>
          )}

          {!isSelectedModeTunnelReady && (
            <div className="space-y-6">
              <div className="rounded-lg border border-[var(--status-info-border)] bg-[var(--status-info-background)] p-3">
                <div className="flex items-start gap-2">
                  <RiInformationLine className="mt-0.5 size-4 shrink-0 text-[var(--status-info)]" />
                  <div className="space-y-1">
                    {tunnelMode === 'managed-remote' && (
                      <>
                        <p className="typography-meta text-[var(--status-info)]">
                          {m.tunnelManagedRemoteRequiresDomain()}
                        </p>
                        <button
                          type="button"
                          className="typography-meta inline-flex items-center gap-1 text-[var(--status-info)] underline underline-offset-2 hover:opacity-90"
                          onClick={() => {
                            void openExternal(MANAGED_REMOTE_TUNNEL_DOC_URL);
                          }}
                        >
                          {m.tunnelManagedRemoteDocs()}
                          <RiExternalLinkLine className="size-3.5" />
                        </button>
                      </>
                    )}
                    {tunnelMode === 'managed-local' && (
                      <>
                        <p className="typography-meta text-[var(--status-info)]">
                          Managed local tunnels use your local cloudflared configuration file.
                        </p>
                        <button
                          type="button"
                          className="typography-meta inline-flex items-center gap-1 text-[var(--status-info)] underline underline-offset-2 hover:opacity-90"
                          onClick={() => {
                            void openExternal(MANAGED_LOCAL_TUNNEL_DOC_URL);
                          }}
                        >
                          {m.tunnelManagedLocalDocs()}
                          <RiExternalLinkLine className="size-3.5" />
                        </button>
                      </>
                    )}
                    <p className="typography-meta text-[var(--status-info)]">
                      {m.tunnelStartHint({ mode: tunnelMode })}
                    </p>
                  </div>
                </div>
              </div>

              {tunnelMode === 'managed-remote' && (
                <div className="space-y-1.5">
                  <p className="typography-ui-label text-foreground">{m.tunnelSelectSaved()}</p>
                  <Select
                    value={selectedPresetId || (managedRemoteTunnelPresets[0]?.id ?? '')}
                    onValueChange={(presetId) => {
                      void handleSelectPreset(presetId);
                    }}
                    disabled={
                      isSavingMode
                      || state === 'starting'
                      || state === 'stopping'
                      || managedRemoteTunnelPresets.length <= 1
                    }
                  >
                    <SelectTrigger>
                      <SelectValue placeholder={m.tunnelSelectSavedPlaceholder()} />
                    </SelectTrigger>
                    <SelectContent fitContent>
                      {managedRemoteTunnelPresets.map((preset) => (
                        <SelectItem key={preset.id} value={preset.id}>{preset.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              {willReplaceActiveTunnel && (
                <div className="rounded-lg border border-[var(--status-warning-border)] bg-[var(--status-warning-background)] p-3">
                  <div className="flex items-start gap-2">
                    <RiErrorWarningLine className="mt-0.5 size-4 shrink-0 text-[var(--status-warning)]" />
                    <p className="typography-meta text-[var(--status-warning)]">
                      {m.tunnelReplaceWarning()}
                    </p>
                  </div>
                </div>
              )}

              <Button size="sm"
                variant="outline"
                onClick={handleStart}
                disabled={
                  state === 'starting'
                  || isSavingMode
                  || (tunnelMode === 'managed-remote' && !selectedPreset)
                  || (tunnelMode === 'managed-local' && isManagedLocalConfigPathInvalid)
                }
                className={cn(primaryCtaClass, state === 'starting' && 'opacity-70')}
              >
                {state === 'starting'
                  ? <><RiLoader4Line className="size-3.5 animate-spin" /> {m.tunnelStarting()}</>
                  : m.tunnelStart()}
              </Button>
            </div>
          )}

        </section>
      )}

      {isSelectedModeTunnelReady && tunnelInfo && (
        <section className="space-y-4 px-2 pb-2 pt-0">
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <div className="size-2 shrink-0 rounded-full bg-[var(--status-success)]" />
              <p className="typography-meta font-medium text-foreground">{m.tunnelReady()}</p>
            </div>

            <div>
              <p className="typography-meta mb-1 text-muted-foreground/70">{m.tunnelPublicUrlHint()}</p>
              <code className="typography-code block truncate rounded bg-muted/50 px-2 py-1 text-xs text-foreground">
                {tunnelInfo.url}
              </code>
            </div>

            {isConnectLinkLive && tunnelInfo.connectUrl && (
              <>
                <div>
                  <p className="typography-meta mb-1 text-muted-foreground/70">{m.tunnelConnectLink()}</p>
                  <div className="flex items-center gap-2">
                    <code className="typography-code flex-1 truncate rounded bg-muted/50 px-2 py-1 text-xs text-foreground">
                      {tunnelInfo.connectUrl}
                    </code>
                    <Button size="sm" variant="ghost" onClick={handleCopyUrl} className="shrink-0 gap-1.5">
                      {copied
                        ? <RiCheckLine className="size-3.5 text-[var(--status-success)]" />
                        : <RiFileCopyLine className="size-3.5" />}
                      {copied ? m.commonCopied() : m.commonCopy()}
                    </Button>
                  </div>
                  <p className="typography-meta mt-1 text-muted-foreground/70">
                    {m.tunnelExpires()}: {tunnelInfo.bootstrapExpiresAt ? remainingText : m.tunnelNever()}
                  </p>
                </div>

                <div className="flex flex-col items-center gap-2 rounded-lg border border-border/50 bg-[var(--surface-elevated)] p-4">
                  {qrDataUrl
                    ? <img src={qrDataUrl} alt={m.tunnelConnectQrAlt()} className="size-48" />
                    : <div className="size-48 rounded bg-muted/30" />}
                  <p className="typography-meta text-muted-foreground">{m.tunnelScanQr()}</p>
                </div>
              </>
            )}
          </div>

          <div className="pt-1">
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm"
                variant="outline"
                onClick={handleStart}
                disabled={state === 'stopping' || isSavingMode || (tunnelMode === 'managed-local' && isManagedLocalConfigPathInvalid)}
                className={primaryCtaClass}
              >
                <RiRestartLine className="size-3.5" />
                {m.tunnelNewLink()}
              </Button>

              <Button size="sm"
                variant="ghost"
                onClick={handleStop}
                disabled={state === 'stopping' || isSavingMode}
                className="gap-2 text-[var(--status-error)]"
              >
                {state === 'stopping'
                  ? <><RiLoader4Line className="size-3.5 animate-spin" /> {m.tunnelStopping()}</>
                  : m.tunnelStop()}
              </Button>
            </div>
          </div>
        </section>
      )}

      {state === 'error' && errorMessage && (
        <section className="space-y-3 px-2 pb-2 pt-0">
          <p className="typography-meta text-[var(--status-error)]">{errorMessage}</p>
          <Button size="sm" variant="ghost" onClick={handleStart}>{m.tunnelRetry()}</Button>
        </section>
      )}
    </div>
  );
};
