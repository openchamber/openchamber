import React from 'react';
import QRCode from 'qrcode';
import { toast } from '@/components/ui';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Icon } from "@/components/icon/Icon";
import { requestFileAccess, type DesktopSettings } from '@/lib/desktop';
import { loadDesktopSettings, updateDesktopSettings } from '@/lib/persistence';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { openExternalUrl } from '@/lib/url';
import { getRuntimeApiBaseUrl } from '@/lib/runtime-switch';
import { formatTimeForPreference } from '@/lib/timeFormat';
import { useUIStore, type TimeFormatPreference } from '@/stores/useUIStore';
import { useDurationTickerNow, useWaitingBlink } from '@/hooks/useDurationTicker';
import { SettingsChipGroup, SettingsFieldRow, SettingsSection, SettingsStackedField, SettingsGroupTitle, SETTINGS_FIELD_LABEL_CLASS, SETTINGS_CALLOUT_TITLE_CLASS, SETTINGS_DESCRIPTION_CLASS, SETTINGS_HELPER_CLASS, SETTINGS_SELECT_ROW_TRIGGER_CLASS } from '@/components/sections/shared/SettingsSection';
import { SettingsInfoHint } from '@/components/sections/shared/SettingsInfoHint';

type TunnelState =
  | 'checking'
  | 'not-available'
  | 'idle'
  | 'starting'
  | 'active'
  | 'stopping'
  | 'error';

type TtlOption = { value: string; label: string; ms: number | null };
type TunnelMode = 'quick' | 'managed-remote' | 'managed-local' | 'serve' | 'funnel';
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

const TUNNEL_MODE_OPTIONS: Array<{ value: TunnelMode; labelKey: string; tooltipKey: string }> = [
  {
    value: 'quick',
    labelKey: 'settings.openchamber.tunnel.option.mode.quick.label',
    tooltipKey: 'settings.openchamber.tunnel.option.mode.quick.tooltip',
  },
  {
    value: 'managed-remote',
    labelKey: 'settings.openchamber.tunnel.option.mode.managedRemote.label',
    tooltipKey: 'settings.openchamber.tunnel.option.mode.managedRemote.tooltip',
  },
  {
    value: 'managed-local',
    labelKey: 'settings.openchamber.tunnel.option.mode.managedLocal.label',
    tooltipKey: 'settings.openchamber.tunnel.option.mode.managedLocal.tooltip',
  },
  {
    value: 'serve',
    labelKey: 'settings.openchamber.tunnel.option.mode.serve.label',
    tooltipKey: 'settings.openchamber.tunnel.option.mode.serve.tooltip',
  },
  {
    value: 'funnel',
    labelKey: 'settings.openchamber.tunnel.option.mode.funnel.label',
    tooltipKey: 'settings.openchamber.tunnel.option.mode.funnel.tooltip',
  },
];

// Shown when the server's provider list is unavailable: Cloudflare's modes,
// the default provider.
const FALLBACK_TUNNEL_MODES: TunnelMode[] = ['quick', 'managed-remote', 'managed-local'];

const BADGE_TONE_CLASSES = {
  warning: {
    badge: 'border-[var(--status-warning-border)] bg-[var(--status-warning-background)] text-[var(--status-warning)]',
    dot: 'text-[var(--status-warning)]',
  },
  info: {
    badge: 'border-[var(--status-info-border)] bg-[var(--status-info-background)] text-[var(--status-info)]',
    dot: 'text-[var(--status-info)]',
  },
  success: {
    badge: 'border-[var(--status-success-border)] bg-[var(--status-success-background)] text-[var(--status-success)]',
    dot: 'text-[var(--status-success)]',
  },
};

const SESSION_BADGES = {
  quick: { labelKey: 'settings.openchamber.tunnel.badge.quick', tone: 'warning' },
  'managed-remote': { labelKey: 'settings.openchamber.tunnel.badge.remote', tone: 'info' },
  'managed-local': { labelKey: 'settings.openchamber.tunnel.badge.local', tone: 'success' },
  serve: { labelKey: 'settings.openchamber.tunnel.badge.serve', tone: 'success' },
  funnel: { labelKey: 'settings.openchamber.tunnel.badge.funnel', tone: 'warning' },
} as const satisfies Record<TunnelMode, { labelKey: string; tone: keyof typeof BADGE_TONE_CLASSES }>;

const isTunnelMode = (value: string): value is TunnelMode => TUNNEL_MODE_OPTIONS.some((option) => option.value === value);

const MANAGED_LOCAL_CONFIG_ALLOWED_EXTENSIONS = ['.yml', '.yaml', '.json'];
const MANAGED_LOCAL_CONFIG_EXTENSION_ERROR_KEY = 'settings.openchamber.tunnel.error.invalidConfigExtension';

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
  /** The server refuses every tunnel; sent only while none is active. */
  enterpriseMode?: boolean;
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
  /** Tailscale's page for turning on HTTPS or Funnel for the tailnet. */
  approvalUrl?: string;
}

interface TunnelProviderModeDescriptor {
  key: TunnelMode;
  label: string;
  httpsPorts?: number[];
}

interface TunnelProviderCapability {
  provider: string;
  modes?: TunnelProviderModeDescriptor[];
}

interface TunnelCheckResponse {
  available?: boolean;
  provider?: string | null;
  version?: string | null;
  dependency?: string | null;
  installCommand?: string | null;
  platform?: string | null;
}

interface TunnelDependencyInstallInfo {
  provider: string;
  dependency: string;
  installCommand: string;
}

const getProviderDependencyName = (provider: string): string => {
  if (provider === 'ngrok' || provider === 'tailscale') {
    return provider;
  }
  return 'cloudflared';
};

const getClientInstallPlatform = (): string => {
  if (typeof window !== 'undefined' && typeof window.__OPENCHAMBER_PLATFORM__ === 'string') {
    const platform = window.__OPENCHAMBER_PLATFORM__;
    if (platform === 'win32' || platform === 'darwin' || platform === 'linux') {
      return platform;
    }
  }

  const browserPlatform = typeof navigator !== 'undefined'
    ? `${navigator.platform || ''} ${navigator.userAgent || ''}`.toLowerCase()
    : '';
  if (browserPlatform.includes('win')) {
    return 'win32';
  }
  if (browserPlatform.includes('mac')) {
    return 'darwin';
  }
  return 'linux';
};

const getFallbackInstallCommand = (provider: string, platform = getClientInstallPlatform()): string => {
  if (provider === 'ngrok') {
    if (platform === 'win32') {
      return 'winget install ngrok -s msstore';
    }
    if (platform === 'darwin') {
      return 'brew install ngrok';
    }
    return 'https://ngrok.com/download';
  }

  if (provider === 'tailscale') {
    return 'https://tailscale.com/download';
  }

  if (platform === 'win32') {
    return 'winget install --id Cloudflare.cloudflared';
  }
  if (platform === 'darwin') {
    return 'brew install cloudflared';
  }
  return 'https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/';
};

const createTunnelDependencyInstallInfo = (provider: string, checkData?: TunnelCheckResponse): TunnelDependencyInstallInfo => {
  const responseProvider = typeof checkData?.provider === 'string' && checkData.provider.trim().length > 0
    ? checkData.provider.trim().toLowerCase()
    : provider;
  const dependency = typeof checkData?.dependency === 'string' && checkData.dependency.trim().length > 0
    ? checkData.dependency.trim()
    : getProviderDependencyName(responseProvider);
  const platform = typeof checkData?.platform === 'string' && checkData.platform.trim().length > 0
    ? checkData.platform.trim()
    : getClientInstallPlatform();
  const installCommand = typeof checkData?.installCommand === 'string' && checkData.installCommand.trim().length > 0
    ? checkData.installCommand.trim()
    : getFallbackInstallCommand(responseProvider, platform);

  return {
    provider: responseProvider,
    dependency,
    installCommand,
  };
};

const getProviderLabel = (provider: string): string => {
  if (provider === 'cloudflare') {
    return 'Cloudflare';
  }
  if (provider === 'ngrok') {
    return 'Ngrok';
  }
  if (provider === 'tailscale') {
    return 'Tailscale';
  }
  return provider;
};

const ProviderOptionLabel: React.FC<{ provider: string }> = ({ provider }) => {
  const label = getProviderLabel(provider);
  const isCloudflare = provider === 'cloudflare';
  const isNgrok = provider === 'ngrok';

  return (
    <span className="flex items-center gap-2">
      <Icon name="cloud" className={cn('size-4 shrink-0', isCloudflare || isNgrok ? 'text-[var(--status-warning)]' : 'text-muted-foreground')} />
      <span>{label}</span>
    </span>
  );
};

const httpsPortOfUrl = (url: string | undefined): number | null => {
  try {
    return url ? Number(new URL(url).port || 443) : null;
  } catch {
    return null;
  }
};

const toUiTunnelMode = (mode: string | null | undefined): TunnelMode => (mode && isTunnelMode(mode) ? mode : 'quick');

const ttlOptionValue = (options: TtlOption[], ttlMs: number | null, fallback: string) => {
  const matched = options.find((entry) => entry.ms === ttlMs);
  return matched?.value || fallback;
};

const ttlOptionLabel = (options: TtlOption[], ttlMs: number | null, fallback: string) => {
  const value = ttlOptionValue(options, ttlMs, fallback);
  return options.find((entry) => entry.value === value)?.label || value;
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

const formatAbsoluteTime = (timestamp: number, timeFormatPreference: TimeFormatPreference): string => {
  return formatTimeForPreference(timestamp, timeFormatPreference, { hour: '2-digit', precision: 'second' });
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
  const { t } = useI18n();
  const timeFormatPreference = useUIStore((state) => state.timeFormatPreference);
  const tUnsafe = React.useCallback((key: string) => t(key as Parameters<typeof t>[0]), [t]);
  const [state, setState] = React.useState<TunnelState>('checking');
  const checkingBlink = useWaitingBlink(state === 'checking');
  const [enterpriseLocked, setEnterpriseLocked] = React.useState(false);
  const [tunnelInfo, setTunnelInfo] = React.useState<TunnelInfo | null>(null);
  const [activeTunnelMode, setActiveTunnelMode] = React.useState<TunnelMode | null>(null);
  const [qrDataUrl, setQrDataUrl] = React.useState<string | null>(null);
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const [managedRemoteValidationError, setManagedRemoteValidationError] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);
  const [isSavingTtl, setIsSavingTtl] = React.useState(false);
  const [isSavingMode, setIsSavingMode] = React.useState(false);
  const [tunnelProvider, setTunnelProvider] = React.useState<string>('cloudflare');
  const [dependencyInstallInfo, setDependencyInstallInfo] = React.useState<TunnelDependencyInstallInfo>(() => createTunnelDependencyInstallInfo('cloudflare'));
  const [providerCapabilities, setProviderCapabilities] = React.useState<TunnelProviderCapability[]>([]);
  const [tunnelMode, setTunnelMode] = React.useState<TunnelMode>('quick');
  const [httpsPort, setHttpsPort] = React.useState<number | null>(null);
  const [approvalUrl, setApprovalUrl] = React.useState<string | null>(null);
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
  const [sessionRecords, setSessionRecords] = React.useState<TunnelSessionRecord[]>([]);
  // Counts expiries down once a second, on the shared 1 s tick, while there
  // is one to count.
  const nowTs = useDurationTickerNow(Boolean(tunnelInfo?.bootstrapExpiresAt) || sessionRecords.length > 0);
  const [localPort, setLocalPort] = React.useState<number | null>(null);
  const managedLocalConfigExtensionError = t(MANAGED_LOCAL_CONFIG_EXTENSION_ERROR_KEY);
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
        : (record.inactiveReason === 'expired' || isExpired ? 'expired' : 'inactive');
      const inactiveLabel = remainingTextForSession === 'expired'
        ? t('settings.openchamber.tunnel.state.expired')
        : (record.inactiveReason === 'tunnel-revoked'
          ? t('settings.openchamber.tunnel.state.revoked')
          : t('settings.openchamber.tunnel.state.inactive'));

      const mode = toUiTunnelMode(record.mode);
      return {
        ...record,
        isActive,
        mode,
        remainingTextForSession,
        inactiveLabel,
      };
    });
  }, [nowTs, sessionRecords, t]);
  const bootstrapRemainingText = tunnelInfo?.bootstrapExpiresAt && tunnelInfo.bootstrapExpiresAt > nowTs
    ? formatRemaining(tunnelInfo.bootstrapExpiresAt - nowTs)
    : t('settings.openchamber.tunnel.state.expired');
  const isConnectLinkLive = React.useMemo(() => {
    if (!tunnelInfo?.connectUrl) {
      return false;
    }
    if (tunnelInfo.bootstrapExpiresAt === null) {
      return true;
    }
    return tunnelInfo.bootstrapExpiresAt > nowTs;
  }, [nowTs, tunnelInfo?.bootstrapExpiresAt, tunnelInfo?.connectUrl]);
  const suggestedConnectorPort = React.useMemo(() => {
    if (typeof localPort === 'number' && Number.isFinite(localPort) && localPort > 0) {
      return localPort;
    }
    if (typeof window === 'undefined') {
      return null;
    }
    const runtimeApiBaseUrl = getRuntimeApiBaseUrl();
    const portSource = runtimeApiBaseUrl || window.location.href;
    let parsed = 0;
    try {
      parsed = Number(new URL(portSource).port);
    } catch {
      parsed = Number(window.location.port);
    }
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
    return null;
  }, [localPort]);
  const selectedProviderCapability = React.useMemo(() => {
    return providerCapabilities.find((capability) => capability.provider === tunnelProvider) ?? null;
  }, [providerCapabilities, tunnelProvider]);
  const tunnelModeOptions = React.useMemo(() => {
    const supportedModes = new Set<TunnelMode>(
      selectedProviderCapability?.modes
        ?.map((mode) => mode.key)
        .filter(isTunnelMode)
    );
    const visibleModes = supportedModes.size > 0 ? supportedModes : new Set(FALLBACK_TUNNEL_MODES);
    return TUNNEL_MODE_OPTIONS.filter((option) => visibleModes.has(option.value));
  }, [selectedProviderCapability]);
  const httpsPortOptions = selectedProviderCapability?.modes?.find((mode) => mode.key === tunnelMode)?.httpsPorts ?? null;
  const selectedHttpsPort = httpsPortOptions
    ? (httpsPort !== null && httpsPortOptions.includes(httpsPort) ? httpsPort : httpsPortOptions[0])
    : null;
  // The running tunnel's address carries its port, so a port picked since it
  // started counts as a different tunnel, the same as a different mode.
  const runningTunnelMatchesSelection = Boolean(tunnelInfo)
    && activeTunnelMode === tunnelMode
    && (selectedHttpsPort === null || httpsPortOfUrl(tunnelInfo?.url) === selectedHttpsPort);
  const isSelectedModeTunnelReady = (state === 'active' || state === 'stopping') && runningTunnelMatchesSelection;
  const willReplaceActiveTunnel = state === 'active' && Boolean(tunnelInfo) && Boolean(activeTunnelMode) && !runningTunnelMatchesSelection;
  const providerSupportsManagedModes = React.useMemo(
    () => tunnelModeOptions.some((option) => option.value === 'managed-remote' || option.value === 'managed-local'),
    [tunnelModeOptions],
  );
  const displayedDependencyInstallInfo = React.useMemo(() => {
    if (dependencyInstallInfo.provider === tunnelProvider) {
      return dependencyInstallInfo;
    }
    return createTunnelDependencyInstallInfo(tunnelProvider);
  }, [dependencyInstallInfo, tunnelProvider]);
  const openExternal = React.useCallback(async (url: string) => {
    await openExternalUrl(url);
  }, []);

  const applyDependencyCheck = React.useCallback((checkData: TunnelCheckResponse, fallbackProvider: string): boolean => {
    setDependencyInstallInfo(createTunnelDependencyInstallInfo(fallbackProvider, checkData));
    return checkData.available === true;
  }, []);

  const refreshTunnelDependencyCheck = React.useCallback(async (provider: string, signal?: AbortSignal): Promise<boolean | null> => {
    try {
      const checkRes = await runtimeFetch('/api/openchamber/tunnel/check', {
        query: { provider },
        ...(signal ? { signal } : {}),
      });
      if (!checkRes.ok) {
        return null;
      }
      const checkData = (await checkRes.json()) as TunnelCheckResponse;
      if (signal?.aborted) {
        return null;
      }
      const available = applyDependencyCheck(checkData, provider);
      setState((current) => {
        if (current === 'checking' || current === 'starting' || current === 'active' || current === 'stopping') {
          return current;
        }
        return available ? 'idle' : 'not-available';
      });
      return available;
    } catch {
      return null;
    }
  }, [applyDependencyCheck]);

  const checkAvailabilityAndStatus = React.useCallback(async (signal: AbortSignal) => {
    try {
      const [checkRes, statusRes, loadedSettings, providersRes] = await Promise.all([
        runtimeFetch('/api/openchamber/tunnel/check', { signal }),
        runtimeFetch('/api/openchamber/tunnel/status', { signal }),
        loadDesktopSettings(),
        runtimeFetch('/api/openchamber/tunnel/providers', { signal }),
      ]);

      const checkData = (await checkRes.json()) as TunnelCheckResponse;
      const statusData = (await statusRes.json()) as TunnelStatusResponse;
      const settingsData: DesktopSettings = loadedSettings ?? {};
      const providersData = providersRes.ok ? await providersRes.json() : {};

      const loadedBootstrapTtl = statusData.ttlConfig?.bootstrapTtlMs
        ?? (settingsData.tunnelBootstrapTtlMs === undefined ? 30 * 60 * 1000 : settingsData.tunnelBootstrapTtlMs);
      const loadedSessionTtl = typeof statusData.ttlConfig?.sessionTtlMs === 'number'
        ? statusData.ttlConfig.sessionTtlMs
        : settingsData.tunnelSessionTtlMs ?? 8 * 60 * 60 * 1000;

      const loadedMode: TunnelMode = toUiTunnelMode(statusData.mode ?? settingsData.tunnelMode);
      const loadedProvider = settingsData.tunnelProvider ?? 'cloudflare';
      const loadedManagedLocalConfigPath = settingsData.managedLocalTunnelConfigPath ?? null;
      const dependencyAvailable = applyDependencyCheck(checkData, loadedProvider);

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

      setEnterpriseLocked(statusData.enterpriseMode === true);
      setBootstrapTtlMs(loadedBootstrapTtl);
      setSessionTtlMs(loadedSessionTtl);
      setTunnelProvider(loadedProvider);
      setProviderCapabilities(Array.isArray(providersData?.providers) ? providersData.providers : []);
      setTunnelMode(loadedMode);
      setHttpsPort(settingsData.tunnelHttpsPort ?? null);
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

      setState(dependencyAvailable ? 'idle' : 'not-available');
    } catch {
      if (!signal.aborted) {
        setState('error');
        setErrorMessage(t('settings.openchamber.tunnel.toast.checkAvailabilityFailed'));
      }
    }
  }, [applyDependencyCheck, t]);

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
    if (state === 'starting' || state === 'stopping' || state === 'checking') {
      return;
    }

    let cancelled = false;
    const refreshSessions = async () => {
      try {
        const statusRes = await runtimeFetch('/api/openchamber/tunnel/status');
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
    tunnelHttpsPort?: number;
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
      if (payload.tunnelHttpsPort !== undefined) {
        setHttpsPort(payload.tunnelHttpsPort);
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
      toast.error(t('settings.openchamber.tunnel.toast.saveSettingsFailed'));
    } finally {
      setIsSavingMode(false);
    }
  }, [t]);

  const saveTtlSettings = React.useCallback(async (nextBootstrapTtlMs: number | null, nextSessionTtlMs: number) => {
    setIsSavingTtl(true);
    try {
      await updateDesktopSettings({
        tunnelBootstrapTtlMs: nextBootstrapTtlMs,
        tunnelSessionTtlMs: nextSessionTtlMs,
      });
    } catch {
      toast.error(t('settings.openchamber.tunnel.toast.saveTtlFailed'));
    } finally {
      setIsSavingTtl(false);
    }
  }, [t]);

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
      toast.error(t('settings.openchamber.tunnel.toast.saveTokenFailed'));
    }
  }, [sessionTokensByPresetId, t]);

  const handleProviderChange = React.useCallback(async (provider: string) => {
    setManagedRemoteValidationError(null);
    setErrorMessage(null);
    const capability = providerCapabilities.find((entry) => entry.provider === provider);
    const defaultMode = capability?.modes?.some((mode) => mode.key === tunnelMode)
      ? tunnelMode
      : toUiTunnelMode(capability?.modes?.[0]?.key);
    await saveTunnelSettings({ tunnelProvider: provider, tunnelMode: defaultMode });
    void refreshTunnelDependencyCheck(provider);
  }, [providerCapabilities, refreshTunnelDependencyCheck, saveTunnelSettings, tunnelMode]);

  const handleBrowseManagedLocalConfig = React.useCallback(async () => {
    const result = await requestFileAccess({
      filters: [{ name: 'Config', extensions: ['yml', 'yaml', 'json'] }],
    });

    if (result.success && typeof result.path === 'string' && result.path.trim().length > 0) {
      const nextPath = result.path.trim();
      if (!hasAllowedManagedLocalConfigExtension(nextPath)) {
        toast.error(managedLocalConfigExtensionError);
        return;
      }
      setManagedLocalConfigPath(nextPath);
      await saveTunnelSettings({ managedLocalTunnelConfigPath: nextPath });
      return;
    }

    managedLocalConfigFileInputRef.current?.click();
  }, [managedLocalConfigExtensionError, saveTunnelSettings]);

  const handleManagedLocalConfigInputChange = React.useCallback((value: string) => {
    const trimmed = value.trim();
    setManagedLocalConfigPath(trimmed.length > 0 ? trimmed : null);
  }, []);

  const handleManagedLocalConfigInputBlur = React.useCallback(async () => {
    if (managedLocalConfigPath && !hasAllowedManagedLocalConfigExtension(managedLocalConfigPath)) {
      toast.error(managedLocalConfigExtensionError);
      return;
    }
    await saveTunnelSettings({ managedLocalTunnelConfigPath: managedLocalConfigPath });
  }, [managedLocalConfigExtensionError, managedLocalConfigPath, saveTunnelSettings]);

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
      toast.error(managedLocalConfigExtensionError);
      return;
    }

    setManagedLocalConfigPath(fallbackPath);
    await saveTunnelSettings({ managedLocalTunnelConfigPath: fallbackPath });
    event.target.value = '';
  }, [managedLocalConfigExtensionError, saveTunnelSettings]);

  const handleStart = React.useCallback(async () => {
    setErrorMessage(null);
    setApprovalUrl(null);
    setManagedRemoteValidationError(null);

    if (tunnelMode === 'managed-local' && managedLocalConfigPath && !hasAllowedManagedLocalConfigExtension(managedLocalConfigPath)) {
      setErrorMessage(managedLocalConfigExtensionError);
      toast.error(managedLocalConfigExtensionError);
      return;
    }

    setState('starting');

    try {
      let managedRemoteTunnelHostname = '';
      let managedRemoteTunnelToken = '';

      if (tunnelMode === 'managed-remote') {
        if (!selectedPreset) {
          setState('idle');
          setManagedRemoteValidationError(t('settings.openchamber.tunnel.toast.selectOrAddManagedRemoteFirst'));
          toast.error(t('settings.openchamber.tunnel.toast.selectOrAddManagedRemoteFirst'));
          return;
        }

        managedRemoteTunnelHostname = selectedPreset.hostname;
        managedRemoteTunnelToken = (sessionTokensByPresetId[selectedPreset.id] || '').trim();

        await saveTunnelSettings({
          tunnelMode: 'managed-remote',
          managedRemoteTunnelPresets,
        });
      }

      const res = await runtimeFetch('/api/openchamber/tunnel/start', {
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
          httpsPort: selectedHttpsPort ?? undefined,
        }),
      });
      const data = (await res.json()) as TunnelStartResponse;

      if (!res.ok || !data.ok) {
        if (tunnelMode === 'managed-remote' && typeof data.error === 'string' && data.error.includes('Managed remote tunnel token is required')) {
          setState('idle');
          setManagedRemoteValidationError(t('settings.openchamber.tunnel.toast.managedRemoteTokenRequiredBeforeStarting'));
          toast.error(t('settings.openchamber.tunnel.toast.addManagedRemoteTokenBeforeStarting'));
          return;
        }
        setState('error');
        setErrorMessage(data.error || t('settings.openchamber.tunnel.toast.startFailed'));
        setApprovalUrl(data.approvalUrl ?? null);
        toast.error(data.error || t('settings.openchamber.tunnel.toast.startFailed'));
        return;
      }

      const startedUrl = typeof data.url === 'string' ? data.url : '';
      if (!startedUrl) {
        setState('error');
        setErrorMessage(t('settings.openchamber.tunnel.toast.startedButNoPublicUrl'));
        toast.error(t('settings.openchamber.tunnel.toast.startedButNoPublicUrl'));
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
        if (revokedBootstrapCount === 1 && invalidatedSessionCount === 1) {
          toast.warning(t('settings.openchamber.tunnel.toast.replacedTunnelSingleSingle'));
        } else if (revokedBootstrapCount === 1) {
          toast.warning(t('settings.openchamber.tunnel.toast.replacedTunnelSingleManySessions', { invalidatedSessionCount }));
        } else if (invalidatedSessionCount === 1) {
          toast.warning(t('settings.openchamber.tunnel.toast.replacedTunnelManyLinksSingleSession', { revokedBootstrapCount }));
        } else {
          toast.warning(t('settings.openchamber.tunnel.toast.replacedTunnelManyMany', { revokedBootstrapCount, invalidatedSessionCount }));
        }
      } else {
        toast.success(t('settings.openchamber.tunnel.toast.linkReady'));
      }
    } catch {
      setState('error');
      setErrorMessage(t('settings.openchamber.tunnel.toast.startFailed'));
      toast.error(t('settings.openchamber.tunnel.toast.startFailed'));
    }
  }, [
    managedLocalConfigExtensionError,
    managedRemoteTunnelPresets,
    saveTunnelSettings,
    selectedPreset,
    sessionTokensByPresetId,
    t,
    tunnelProvider,
    tunnelMode,
    managedLocalConfigPath,
    selectedHttpsPort,
  ]);

  const handleStop = React.useCallback(async () => {
    setState('stopping');

    try {
      await runtimeFetch('/api/openchamber/tunnel/stop', { method: 'POST' });
      const statusRes = await runtimeFetch('/api/openchamber/tunnel/status');
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
      toast.success(t('settings.openchamber.tunnel.toast.stopped'));
    } catch {
      setState('error');
      setErrorMessage(t('settings.openchamber.tunnel.toast.stopFailed'));
      toast.error(t('settings.openchamber.tunnel.toast.stopFailed'));
    }
  }, [t]);

  const handleCopyUrl = React.useCallback(async () => {
    if (!tunnelInfo?.connectUrl) {
      return;
    }

    try {
      await navigator.clipboard.writeText(tunnelInfo.connectUrl);
      setCopied(true);
      toast.success(t('settings.openchamber.tunnel.toast.connectLinkCopied'));
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error(t('settings.openchamber.tunnel.toast.copyUrlFailed'));
    }
  }, [t, tunnelInfo?.connectUrl]);

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
      toast.error(t('settings.openchamber.tunnel.toast.saveSelectedManagedRemoteFailed'));
    }
  }, [t]);

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
      toast.error(t('settings.openchamber.tunnel.toast.tunnelNameRequired'));
      return;
    }
    if (!hostname) {
      toast.error(t('settings.openchamber.tunnel.toast.managedRemoteHostnameRequired'));
      return;
    }
    if (!token) {
      toast.error(t('settings.openchamber.tunnel.toast.managedRemoteTokenRequired'));
      return;
    }

    if (managedRemoteTunnelPresets.some((preset) => preset.hostname === hostname)) {
      toast.error(t('settings.openchamber.tunnel.toast.hostnameAlreadyExists'));
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
    toast.success(t('settings.openchamber.tunnel.toast.managedRemoteSaved'));
  }, [managedRemoteTunnelPresets, newPresetHostname, newPresetName, newPresetToken, persistManagedRemoteTunnelToken, saveTunnelSettings, sessionTokensByPresetId, t]);

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

    toast.success(t('settings.openchamber.tunnel.toast.managedRemoteRemoved'));
  }, [managedRemoteTunnelPresets, saveTunnelSettings, selectedPresetId, sessionTokensByPresetId, t]);

  if (state === 'checking') {
    return (
      <div className="flex items-center justify-center py-12">
        <span className={cn('h-1.5 w-1.5 rounded-full bg-current', checkingBlink)} aria-label={t('settings.openchamber.tunnel.state.loading')} />
      </div>
    );
  }

  if (enterpriseLocked) {
    return (
      <SettingsSection title={t('settings.openchamber.tunnel.title')} divider={false}>
        <p className={SETTINGS_DESCRIPTION_CLASS}>{t('settings.openchamber.tunnel.enterpriseMode')}</p>
      </SettingsSection>
    );
  }

  const controlsBusy = isSavingMode || state === 'starting' || state === 'stopping';
  const modeLabel = tUnsafe(TUNNEL_MODE_OPTIONS.find((option) => option.value === tunnelMode)?.labelKey ?? 'settings.openchamber.tunnel.option.mode.quick.label');

  return (
    <>
      {/* What the tunnel is: who carries it and which kind. The kind's caveat
          and its setup sit right under the choice they depend on. */}
      <SettingsSection
        title={t('settings.layout.tunnel.section.setup')}
        info={(
          <div className="space-y-1">
            <p>{t('settings.openchamber.tunnel.description')}</p>
            <p>{t('settings.openchamber.tunnel.note.serverSideEnforced')}</p>
            <p>{t('settings.openchamber.tunnel.note.connectLinksOneTime')}</p>
          </div>
        )}
        divider={false}
        contentClassName="space-y-4"
      >
        {state === 'not-available' && (
          <div className="flex items-start gap-2 rounded-lg bg-[var(--status-warning)]/10 p-3">
            <Icon name="error-warning" className="mt-0.5 size-4 shrink-0 text-[var(--status-warning)]" />
            <div className="min-w-0 space-y-1">
              <p className={SETTINGS_CALLOUT_TITLE_CLASS}>
                {t('settings.openchamber.tunnel.notAvailable.dependencyNotFound', { dependency: displayedDependencyInstallInfo.dependency })}
              </p>
              <p className="typography-meta text-muted-foreground">{t('settings.openchamber.tunnel.notAvailable.installHint')}</p>
              <code className="typography-code block rounded bg-muted/50 px-2 py-1 text-xs text-foreground">
                {displayedDependencyInstallInfo.installCommand}
              </code>
            </div>
          </div>
        )}

        <div>
          <SettingsFieldRow label={t('settings.openchamber.tunnel.field.provider')} settingsItem="tunnel.provider">
            <Select
              value={tunnelProvider}
              onValueChange={(value) => {
                void handleProviderChange(value);
              }}
              disabled={controlsBusy}
            >
              <SelectTrigger className={SETTINGS_SELECT_ROW_TRIGGER_CLASS}>
                <SelectValue placeholder={t('settings.openchamber.tunnel.field.providerPlaceholder')}>
                  {getProviderLabel(tunnelProvider)}
                </SelectValue>
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
                <SelectItem value="__more-soon" disabled>{t('settings.openchamber.tunnel.option.moreProvidersSoon')}</SelectItem>
              </SelectContent>
            </Select>
          </SettingsFieldRow>

          <SettingsFieldRow label={t('settings.openchamber.tunnel.field.tunnelType')} settingsItem="tunnel.type">
            <SettingsChipGroup
              value={tunnelMode}
              aria-label={t('settings.openchamber.tunnel.field.tunnelType')}
              onChange={(mode) => {
                void handleModeChange(mode);
              }}
              options={tunnelModeOptions.map((option) => ({
                value: option.value,
                label: tUnsafe(option.labelKey),
                tooltip: tUnsafe(option.tooltipKey),
                disabled: controlsBusy,
              }))}
            />
          </SettingsFieldRow>

          {httpsPortOptions && selectedHttpsPort !== null && (
            <SettingsFieldRow
              label={t('settings.openchamber.tunnel.field.httpsPort')}
              info={t('settings.openchamber.tunnel.field.httpsPortInfo')}
            >
              <Select
                value={String(selectedHttpsPort)}
                onValueChange={(value) => {
                  void saveTunnelSettings({ tunnelHttpsPort: Number(value) });
                }}
                disabled={controlsBusy}
              >
                <SelectTrigger className={SETTINGS_SELECT_ROW_TRIGGER_CLASS}>
                  <SelectValue>{selectedHttpsPort}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {httpsPortOptions.map((port) => (
                    <SelectItem key={port} value={String(port)}>{port}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </SettingsFieldRow>
          )}
        </div>

        {tunnelMode === 'funnel' && (
          <div className="flex items-start gap-2 rounded-lg bg-[var(--status-warning)]/10 p-3">
            <Icon name="error-warning" className="mt-0.5 size-4 shrink-0 text-[var(--status-warning)]" />
            <p className="typography-meta text-[var(--status-warning)]">
              {t('settings.openchamber.tunnel.warning.funnelPublic')}
            </p>
          </div>
        )}

        {tunnelMode === 'quick' && (
          <div className="flex items-start gap-2 rounded-lg bg-[var(--status-warning)]/10 p-3">
            <Icon name="error-warning" className="mt-0.5 size-4 shrink-0 text-[var(--status-warning)]" />
            <div className="space-y-1">
              <p className="typography-meta text-[var(--status-warning)]">
                {t('settings.openchamber.tunnel.option.mode.quick.tooltip')}
              </p>
              {providerSupportsManagedModes && (
                <p className="typography-meta text-[var(--status-warning)]">
                  {t('settings.openchamber.tunnel.warning.quickModeReliability')}
                </p>
              )}
            </div>
          </div>
        )}

        {tunnelMode === 'managed-remote' && (
          <p className={SETTINGS_HELPER_CLASS}>
            {t('settings.openchamber.tunnel.note.managedRemoteRequiresDomain')}
            {' '}
            <button
              type="button"
              className="inline-flex items-center gap-1 text-[var(--primary-text)] underline-offset-4 hover:underline"
              onClick={() => {
                void openExternal(MANAGED_REMOTE_TUNNEL_DOC_URL);
              }}
            >
              {t('settings.openchamber.tunnel.actions.openManagedRemoteDocs')}
              <Icon name="external-link" className="size-3.5" />
            </button>
          </p>
        )}

        {tunnelMode === 'managed-local' && (
          <p className={SETTINGS_HELPER_CLASS}>
            {t('settings.openchamber.tunnel.note.managedLocalUsesConfig')}
            {' '}
            <button
              type="button"
              className="inline-flex items-center gap-1 text-[var(--primary-text)] underline-offset-4 hover:underline"
              onClick={() => {
                void openExternal(MANAGED_LOCAL_TUNNEL_DOC_URL);
              }}
            >
              {t('settings.openchamber.tunnel.actions.openManagedLocalDocs')}
              <Icon name="external-link" className="size-3.5" />
            </button>
          </p>
        )}

        {tunnelMode === 'managed-remote' && (
          <div data-settings-item="tunnel.managed-remote" className="oc-tile space-y-2 rounded-lg p-3">
            {typeof suggestedConnectorPort === 'number' && (
              <div className="rounded-md bg-[var(--status-info-background)]/60 px-2 py-1.5">
                <p className="typography-meta text-[var(--status-info)]">
                  {t('settings.openchamber.tunnel.note.cloudflareConnectorTarget')} <code>http://localhost:{suggestedConnectorPort}</code>
                </p>
              </div>
            )}

            <div className="mb-1 flex items-center justify-between gap-3">
              <SettingsGroupTitle>{t('settings.openchamber.tunnel.section.savedManagedRemoteTunnels')}</SettingsGroupTitle>
              <Button
                variant="ghost"
                size="xs"
                className="!font-normal"
                onClick={() => setIsAddingPreset((prev) => !prev)}
                disabled={state === 'starting' || state === 'stopping' || isSavingMode}
              >
                <Icon name="add" className="h-3.5 w-3.5" />
                {t('settings.common.actions.create')}
              </Button>
            </div>

            {managedRemoteTunnelPresets.length > 0 ? (
              <div className="oc-tile-inset overflow-hidden rounded-md">
                {managedRemoteTunnelPresets.map((preset, index) => {
                  const rowToken = sessionTokensByPresetId[preset.id] || '';
                  const hasSavedToken = savedTokenPresetIds.has(preset.id);
                  const isOpen = expandedManagedRemoteTunnels[preset.id] ?? false;

                  return (
                    <div
                      key={preset.id}
                      className={cn(index < managedRemoteTunnelPresets.length - 1 && 'border-b border-[var(--interactive-border)]')}
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
                            className="group flex-1 justify-start gap-2 rounded-md px-0 py-1 pe-1 text-start hover:bg-[var(--interactive-hover)]"
                            disabled={state === 'starting' || state === 'stopping' || isSavingMode}
                          >
                            {isOpen
                              ? <Icon name="arrow-down-s" className="h-4 w-4 text-muted-foreground" />
                              : <Icon name="arrow-right-s" className="h-4 w-4 text-muted-foreground" />}
                            <span className="typography-ui-label min-w-0 flex-1 truncate text-foreground">{preset.name}</span>
                          </CollapsibleTrigger>

                          <Button
                            variant="ghost"
                            size="xs"
                            className="h-7 w-7 p-0 text-muted-foreground hover:text-[var(--status-error)]"
                            aria-label={t('settings.openchamber.tunnel.actions.removePresetAria', { name: preset.name })}
                            onClick={() => {
                              void handleRemovePreset(preset.id);
                            }}
                            disabled={state === 'starting' || state === 'stopping' || isSavingMode}
                          >
                            <Icon name="delete-bin" className="h-3.5 w-3.5" />
                          </Button>
                        </div>

                        <CollapsibleContent className="pt-1.5">
                          <div className="space-y-1 px-3 pb-2">
                            <p className="typography-meta text-muted-foreground/70">{t('settings.openchamber.tunnel.field.hostnameLabel')} <code>{preset.hostname}</code></p>
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
                              placeholder={hasSavedToken ? t('settings.openchamber.tunnel.field.savedTokenAvailablePlaceholder') : t('settings.openchamber.tunnel.field.pasteTokenPlaceholder')}
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
                                {t('settings.openchamber.tunnel.actions.saveToken')}
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
              <p className="typography-meta text-muted-foreground/70">{t('settings.openchamber.tunnel.empty.noManagedRemoteTunnels')}</p>
            )}

            {isAddingPreset && (
              <div className="oc-tile-inset space-y-2 rounded-md p-2">
                <Input
                  value={newPresetName}
                  onChange={(event) => setNewPresetName(event.target.value)}
                  placeholder={t('settings.openchamber.tunnel.field.newPresetNamePlaceholder')}
                  className="h-7"
                  disabled={isSavingMode || state === 'starting' || state === 'stopping'}
                />
                <Input
                  value={newPresetHostname}
                  onChange={(event) => setNewPresetHostname(event.target.value)}
                  placeholder={t('settings.openchamber.tunnel.field.newPresetHostnamePlaceholder')}
                  className="h-7"
                  disabled={isSavingMode || state === 'starting' || state === 'stopping'}
                />
                <Input
                  type="password"
                  value={newPresetToken}
                  onChange={(event) => setNewPresetToken(event.target.value)}
                  placeholder={t('settings.openchamber.tunnel.field.newPresetTokenPlaceholder')}
                  className="h-7"
                  disabled={isSavingMode || state === 'starting' || state === 'stopping'}
                />
                {typeof suggestedConnectorPort === 'number' && (
                  <p className="typography-meta text-muted-foreground/70">
                    {t('settings.openchamber.tunnel.note.cloudflareConnectorTargetUse')} <code>http://localhost:{suggestedConnectorPort}</code>.
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
                    {t('settings.common.actions.saveChanges')}
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
                    {t('settings.common.actions.cancel')}
                  </Button>
                </div>
              </div>
            )}

            <div className="flex items-center gap-1.5">
              <p className="typography-meta text-muted-foreground/80">{t('settings.openchamber.tunnel.note.tokensSavedPerTunnel')}</p>
              <SettingsInfoHint>
                {t('settings.openchamber.tunnel.tooltip.tokensSavedPath')}
              </SettingsInfoHint>
            </div>

            {!selectedPreset && managedRemoteValidationError && (
              <p className="typography-meta text-[var(--status-error)]">{managedRemoteValidationError}</p>
            )}
          </div>
        )}

        {tunnelMode === 'managed-local' && (
          <div data-settings-item="tunnel.managed-local-config" className="oc-tile space-y-2 rounded-lg p-3">
            <div className="space-y-1.5">
              <p className={SETTINGS_FIELD_LABEL_CLASS}>{t('settings.openchamber.tunnel.field.configurationFile')}</p>
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
                  placeholder={t('settings.openchamber.tunnel.field.configurationFilePlaceholder')}
                  className="h-7"
                  disabled={state === 'starting' || state === 'stopping' || isSavingMode}
                />
                <Button
                  variant="outline"
                  size="xs"
                  className="h-7 w-7 p-0"
                  aria-label={t('settings.openchamber.tunnel.actions.browseConfigFileAria')}
                  onClick={() => {
                    void handleBrowseManagedLocalConfig();
                  }}
                  disabled={state === 'starting' || state === 'stopping' || isSavingMode}
                >
                  <Icon name="folder" className="size-3.5" />
                </Button>
                {managedLocalConfigPath && (
                  <Button
                    variant="ghost"
                    size="xs"
                    className="h-7 w-7 p-0"
                    aria-label={t('settings.openchamber.tunnel.actions.clearConfigFileAria')}
                    onClick={() => {
                      void handleManagedLocalConfigClear();
                    }}
                    disabled={state === 'starting' || state === 'stopping' || isSavingMode}
                  >
                    <Icon name="close" className="size-3.5" />
                  </Button>
                )}
              </div>
              <p className="typography-meta text-muted-foreground/70">
                {managedLocalConfigPath
                  ? t('settings.openchamber.tunnel.note.customConfigUsed')
                  : t('settings.openchamber.tunnel.note.defaultConfigUsed')}
              </p>
              {isManagedLocalConfigPathInvalid && (
                <p className="typography-meta text-[var(--status-error)]">{managedLocalConfigExtensionError}</p>
              )}
            </div>
          </div>
        )}

      </SettingsSection>

      {/* Starting the tunnel, and once it runs: where to reach it. */}
      <SettingsSection
        title={t('settings.layout.tunnel.section.connection')}
        settingsItem="tunnel.start"
        contentClassName="space-y-4"
      >
        {!isSelectedModeTunnelReady && (
          <>
            <p className={SETTINGS_HELPER_CLASS}>
              {t('settings.openchamber.tunnel.note.startModeAndGenerateLink', { mode: modeLabel })}
            </p>

            {tunnelMode === 'managed-remote' && (
              <SettingsFieldRow label={t('settings.openchamber.tunnel.field.managedRemoteTunnelToConnect')}>
                <Select
                  value={selectedPresetId || (managedRemoteTunnelPresets[0]?.id ?? '')}
                  onValueChange={(presetId) => {
                    void handleSelectPreset(presetId);
                  }}
                  disabled={controlsBusy || managedRemoteTunnelPresets.length <= 1}
                >
                  <SelectTrigger className={SETTINGS_SELECT_ROW_TRIGGER_CLASS}>
                    <SelectValue placeholder={t('settings.openchamber.tunnel.field.selectSavedTunnelPlaceholder')}>
                      {selectedPreset?.name}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent fitContent>
                    {managedRemoteTunnelPresets.map((preset) => (
                      <SelectItem key={preset.id} value={preset.id}>{preset.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </SettingsFieldRow>
            )}

            {willReplaceActiveTunnel && (
              <div className="flex items-start gap-2 rounded-lg bg-[var(--status-warning-background)] p-3">
                <Icon name="error-warning" className="mt-0.5 size-4 shrink-0 text-[var(--status-warning)]" />
                <p className="typography-meta text-[var(--status-warning)]">
                  {t('settings.openchamber.tunnel.warning.replacesActiveTunnel')}
                </p>
              </div>
            )}

            <Button
              size="sm"
              onClick={handleStart}
              disabled={
                state === 'starting'
                || isSavingMode
                || (tunnelMode === 'managed-remote' && !selectedPreset)
                || (tunnelMode === 'managed-local' && isManagedLocalConfigPathInvalid)
              }
            >
              {state === 'starting'
                ? <><Icon name="loader-4" className="size-3.5 animate-spin" /> {t('settings.openchamber.tunnel.actions.startingTunnel')}</>
                : t('settings.openchamber.tunnel.actions.startTunnel')}
            </Button>
          </>
        )}

        {isSelectedModeTunnelReady && tunnelInfo && (
          <>
            <div className="flex items-center gap-2">
              <div className="size-2 shrink-0 rounded-full bg-[var(--status-success)]" />
              <p className="typography-ui-label font-medium text-foreground">{t('settings.openchamber.tunnel.state.tunnelReady')}</p>
            </div>

            <SettingsStackedField
              label={t(activeTunnelMode === 'serve'
                ? 'settings.openchamber.tunnel.field.tailnetUrlHint'
                : 'settings.openchamber.tunnel.field.publicUrlHint')}
              controlClassName="max-w-none"
            >
              <code className="typography-code block min-w-0 truncate rounded-md oc-tile-inset px-2 py-1.5 text-xs text-foreground" title={tunnelInfo.url}>
                {tunnelInfo.url}
              </code>
            </SettingsStackedField>

            {isConnectLinkLive && tunnelInfo.connectUrl && (
              <div className="flex flex-col gap-4 @xl:flex-row @xl:items-start">
                <SettingsStackedField
                  label={t('settings.openchamber.tunnel.field.connectLink')}
                  description={`${t('settings.openchamber.tunnel.field.expires')}: ${tunnelInfo.bootstrapExpiresAt ? bootstrapRemainingText : t('settings.openchamber.tunnel.state.never')}`}
                  descriptionPlacement="after"
                  className="min-w-0 flex-1"
                  controlClassName="max-w-none"
                >
                  <code className="typography-code block min-w-0 flex-1 truncate rounded-md oc-tile-inset px-2 py-1.5 text-xs text-foreground" title={tunnelInfo.connectUrl}>
                    {tunnelInfo.connectUrl}
                  </code>
                  <Button size="sm" variant="ghost" onClick={handleCopyUrl} className="shrink-0 gap-1.5">
                    {copied
                      ? <Icon name="check" className="size-3.5 text-[var(--status-success)]" />
                      : <Icon name="file-copy" className="size-3.5" />}
                    {copied ? t('settings.openchamber.tunnel.actions.copied') : t('settings.common.actions.copyAll')}
                  </Button>
                </SettingsStackedField>

                <div className="flex shrink-0 flex-col items-center gap-2 oc-tile rounded-lg p-3">
                  {qrDataUrl
                    ? <img src={qrDataUrl} alt={t('settings.openchamber.tunnel.field.connectQrAlt')} className="size-40" />
                    : <div className="size-40 rounded bg-muted/30" />}
                  <p className="typography-micro text-muted-foreground">{t('settings.openchamber.tunnel.note.scanQrToConnect')}</p>
                </div>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                onClick={handleStart}
                disabled={state === 'stopping' || isSavingMode || (tunnelMode === 'managed-local' && isManagedLocalConfigPathInvalid)}
              >
                <Icon name="restart" className="size-3.5" />
                {t('settings.openchamber.tunnel.actions.newConnectLink')}
              </Button>

              <Button
                size="sm"
                variant="ghost"
                onClick={handleStop}
                disabled={state === 'stopping' || isSavingMode}
                className="text-[var(--status-error)]"
              >
                {state === 'stopping'
                  ? <><Icon name="loader-4" className="size-3.5 animate-spin" /> {t('settings.openchamber.tunnel.actions.stopping')}</>
                  : t('settings.openchamber.tunnel.actions.stopTunnel')}
              </Button>
            </div>
          </>
        )}

        {state === 'error' && errorMessage && (
          <div className="flex flex-wrap items-center gap-2">
            <p className="typography-meta text-[var(--status-error)]">{errorMessage}</p>
            {approvalUrl && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  void openExternal(approvalUrl);
                }}
              >
                {t('settings.openchamber.tunnel.actions.openTailscaleApproval')}
                <Icon name="external-link" className="size-3.5" />
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={handleStart}>{t('settings.openchamber.tunnel.actions.retry')}</Button>
          </div>
        )}
      </SettingsSection>

      {/* How long a connect link and a device's access last. */}
      <SettingsSection title={t('settings.layout.tunnel.section.lifetime')} settingsItem="tunnel.ttl">
        <SettingsFieldRow label={t('settings.openchamber.tunnel.field.connectLinkTtl')}>
          <Select
            value={ttlOptionValue(BOOTSTRAP_TTL_OPTIONS, bootstrapTtlMs, '1800000')}
            onValueChange={(value) => {
              void handleBootstrapTtlChange(value);
            }}
            disabled={isSavingTtl || controlsBusy}
          >
            <SelectTrigger className={SETTINGS_SELECT_ROW_TRIGGER_CLASS}>
              <SelectValue className="truncate">
                {ttlOptionLabel(BOOTSTRAP_TTL_OPTIONS, bootstrapTtlMs, '1800000')}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {BOOTSTRAP_TTL_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsFieldRow>
        <SettingsFieldRow label={t('settings.openchamber.tunnel.field.tunnelSessionTtl')}>
          <Select
            value={ttlOptionValue(SESSION_TTL_OPTIONS, sessionTtlMs, '28800000')}
            onValueChange={(value) => {
              void handleSessionTtlChange(value);
            }}
            disabled={isSavingTtl || controlsBusy}
          >
            <SelectTrigger className={SETTINGS_SELECT_ROW_TRIGGER_CLASS}>
              <SelectValue className="truncate">
                {ttlOptionLabel(SESSION_TTL_OPTIONS, sessionTtlMs, '28800000')}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {SESSION_TTL_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsFieldRow>
      </SettingsSection>

      {renderedSessionRecords.length > 0 && (
        <SettingsSection title={t('settings.openchamber.tunnel.section.redeemedAccessLinks')} contentClassName="space-y-1">
          {renderedSessionRecords.map((record) => {
            const badge = SESSION_BADGES[record.mode];
            const modeBadgeClass = BADGE_TONE_CLASSES[badge.tone].badge;
            const statusDotClass = record.isActive ? BADGE_TONE_CLASSES[badge.tone].dot : 'text-muted-foreground/50';
            const modeLabel = t(badge.labelKey);

            return (
              <div
                key={record.sessionId}
                className="flex flex-wrap items-center gap-x-2 gap-y-1 oc-tile rounded-md px-3 py-2"
              >
                <Icon name="checkbox-blank-circle-fill" className={cn('size-2.5 shrink-0', statusDotClass)} />
                <span className={cn('rounded-full px-2 py-0.5 text-[0.625rem] font-medium', modeBadgeClass)}>
                  {modeLabel}
                </span>
                <span className="typography-meta text-muted-foreground">
                  {t('settings.openchamber.tunnel.session.redeemedAt', { time: formatAbsoluteTime(record.createdAt, timeFormatPreference) })}
                </span>
                <span className="typography-meta text-foreground">
                  {record.isActive
                    ? t('settings.openchamber.tunnel.session.expiresIn', { remaining: record.remainingTextForSession })
                    : (record.inactiveLabel === t('settings.openchamber.tunnel.state.inactive')
                      ? t('settings.openchamber.tunnel.state.inactive')
                      : t('settings.openchamber.tunnel.session.inactiveWithReason', { reason: record.inactiveLabel }))}
                </span>
              </div>
            );
          })}
        </SettingsSection>
      )}
    </>
  );
};
