import { useLanguage } from '@/hooks/useLanguage';
import React from 'react';
import QRCode from 'qrcode';
import {
  RiAddLine,
  RiArrowDownSLine,
  RiArrowRightSLine,
  RiCheckboxBlankCircleFill,
  RiCheckLine,
  RiDeleteBinLine,
  RiErrorWarningLine,
  RiExternalLinkLine,
  RiFileCopyLine,
  RiInformationLine,
  RiLoader4Line,
  RiRestartLine,
} from '@remixicon/react';
import { toast } from '@/components/ui';
import { ButtonSmall } from '@/components/ui/button-small';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { GridLoader } from '@/components/ui/grid-loader';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { updateDesktopSettings } from '@/lib/persistence';
import { cn } from '@/lib/utils';

type TunnelState =
  | 'checking'
  | 'not-available'
  | 'idle'
  | 'starting'
  | 'active'
  | 'stopping'
  | 'error';

type TtlOption = { value: string; label: string; ms: number | null };
type TunnelMode = 'quick' | 'named';

interface NamedTunnelPreset {
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
];

const NAMED_TUNNEL_DOC_URL = 'https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel/';

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
  mode?: TunnelMode;
  hasNamedTunnelToken?: boolean;
  namedTunnelHostname?: string | null;
  hasBootstrapToken?: boolean;
  bootstrapExpiresAt?: number | null;
  namedTunnelTokenPresetIds?: string[];
  activeTunnelMode?: TunnelMode | null;
  activeSessions?: TunnelSessionRecord[];
  localPort?: number;
  policy?: string;
  ttlConfig?: {
    bootstrapTtlMs?: number | null;
    sessionTtlMs?: number;
  };
}

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

const sanitizePresets = (value: unknown): NamedTunnelPreset[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  const seenIds = new Set<string>();
  const seenHosts = new Set<string>();
  const result: NamedTunnelPreset[] = [];

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
  const { t } = useLanguage();
  const [state, setState] = React.useState<TunnelState>('checking');
  const [tunnelInfo, setTunnelInfo] = React.useState<TunnelInfo | null>(null);
  const [activeTunnelMode, setActiveTunnelMode] = React.useState<TunnelMode | null>(null);
  const [qrDataUrl, setQrDataUrl] = React.useState<string | null>(null);
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const [namedValidationError, setNamedValidationError] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);
  const [isSavingTtl, setIsSavingTtl] = React.useState(false);
  const [isSavingMode, setIsSavingMode] = React.useState(false);
  const [tunnelMode, setTunnelMode] = React.useState<TunnelMode>('quick');
  const [namedTunnelPresets, setNamedTunnelPresets] = React.useState<NamedTunnelPreset[]>([]);
  const [expandedNamedTunnels, setExpandedNamedTunnels] = React.useState<Record<string, boolean>>({});
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

  const selectedPreset = React.useMemo(
    () => namedTunnelPresets.find((preset) => preset.id === selectedPresetId) || namedTunnelPresets[0] || null,
    [namedTunnelPresets, selectedPresetId]
  );
  const renderedSessionRecords = React.useMemo(() => {
    return sessionRecords.map((record) => {
      const isExpired = record.expiresAt <= nowTs;
      const isActive = record.status === 'active' && !isExpired;
      const remainingTextForSession = isActive
        ? formatRemaining(record.expiresAt - nowTs)
        : '';
      const inactiveStatus = record.inactiveReason === 'expired' || isExpired
        ? 'expired'
        : (record.inactiveReason === 'tunnel-revoked' ? 'revoked' : 'inactive');

      const mode = record.mode === 'named' ? 'named' : 'quick';
      return {
        ...record,
        isActive,
        mode,
        remainingTextForSession,
        inactiveStatus,
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
    if (typeof window === 'undefined') {
      return;
    }

    type TauriShell = { shell?: { open?: (url: string) => Promise<unknown> } };
    const tauri = (window as unknown as { __TAURI__?: TauriShell }).__TAURI__;
    if (tauri?.shell?.open) {
      try {
        await tauri.shell.open(url);
        return;
      } catch {
        // fall through
      }
    }

    try {
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch {
      // ignore
    }
  }, []);

  const checkAvailabilityAndStatus = React.useCallback(async (signal: AbortSignal) => {
    try {
      const [checkRes, statusRes, settingsRes] = await Promise.all([
        fetch('/api/openchamber/tunnel/check', { signal }),
        fetch('/api/openchamber/tunnel/status', { signal }),
        fetch('/api/config/settings', { signal, headers: { Accept: 'application/json' } }),
      ]);

      const checkData = await checkRes.json();
      const statusData = (await statusRes.json()) as TunnelStatusResponse;
      const settingsData = settingsRes.ok ? await settingsRes.json() : {};

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

      const loadedMode: TunnelMode = statusData.mode === 'named'
        ? 'named'
        : settingsData?.tunnelMode === 'named'
          ? 'named'
          : 'quick';

      const loadedHostname = typeof statusData.namedTunnelHostname === 'string'
        ? statusData.namedTunnelHostname
        : typeof settingsData?.namedTunnelHostname === 'string'
          ? settingsData.namedTunnelHostname
          : '';

      const loadedPresets = sanitizePresets(settingsData?.namedTunnelPresets);
      const presets = loadedPresets.length > 0
        ? loadedPresets
        : (loadedHostname
          ? [{ id: 'legacy-default', name: t('tunnelSettings.defaultPresetName'), hostname: normalizePresetHostname(loadedHostname) }]
          : []);

      const requestedPresetId = typeof settingsData?.namedTunnelSelectedPresetId === 'string'
        ? settingsData.namedTunnelSelectedPresetId.trim()
        : '';

      const selectedId = (requestedPresetId && presets.some((preset) => preset.id === requestedPresetId))
        ? requestedPresetId
        : presets[0]?.id || '';

      setBootstrapTtlMs(loadedBootstrapTtl);
      setSessionTtlMs(loadedSessionTtl);
      setTunnelMode(loadedMode);
      setNamedTunnelPresets(presets);
      setSelectedPresetId(selectedId);
      setSessionRecords(Array.isArray(statusData.activeSessions) ? statusData.activeSessions : []);
      setActiveTunnelMode(statusData.activeTunnelMode || (statusData.active && statusData.mode ? statusData.mode : null));
      setSavedTokenPresetIds(new Set(Array.isArray(statusData.namedTunnelTokenPresetIds) ? statusData.namedTunnelTokenPresetIds : []));
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
        setErrorMessage(t('tunnelSettings.failedCheckTunnel'));
      }
    }
  }, [t]);

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
      setRemainingText(t('tunnelSettings.noExpiry'));
      return;
    }

    const updateRemaining = () => {
      const remaining = tunnelInfo.bootstrapExpiresAt ? tunnelInfo.bootstrapExpiresAt - Date.now() : 0;
      if (remaining <= 0) {
        setRemainingText(t('tunnelSettings.expired'));
      } else {
        setRemainingText(formatRemaining(remaining));
      }
    };

    updateRemaining();
    const timer = window.setInterval(updateRemaining, 1000);
    return () => window.clearInterval(timer);
  }, [t, tunnelInfo?.bootstrapExpiresAt]);

  React.useEffect(() => {
    const timer = window.setInterval(() => setNowTs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [t]);

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
        setSavedTokenPresetIds(new Set(Array.isArray(statusData.namedTunnelTokenPresetIds) ? statusData.namedTunnelTokenPresetIds : []));
        setLocalPort(typeof statusData.localPort === 'number' ? statusData.localPort : null);
      } catch {
        // ignore transient refresh failures
      }
    };

    const timer = window.setInterval(() => {
      void refreshSessions();
    }, 5000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [state]);

  const saveTunnelSettings = React.useCallback(async (payload: {
    tunnelMode?: TunnelMode;
    namedTunnelHostname?: string;
    namedTunnelPresets?: NamedTunnelPreset[];
    namedTunnelSelectedPresetId?: string;
    namedTunnelPresetTokens?: Record<string, string>;
    tunnelBootstrapTtlMs?: number | null;
    tunnelSessionTtlMs?: number;
  }) => {
    setIsSavingMode(true);
    try {
      await updateDesktopSettings(payload);
      if (Object.prototype.hasOwnProperty.call(payload, 'tunnelMode') && payload.tunnelMode) {
        setTunnelMode(payload.tunnelMode);
      }
      if (Object.prototype.hasOwnProperty.call(payload, 'namedTunnelPresets') && payload.namedTunnelPresets) {
        setNamedTunnelPresets(payload.namedTunnelPresets);
      }
      if (Object.prototype.hasOwnProperty.call(payload, 'namedTunnelSelectedPresetId')) {
        setSelectedPresetId(payload.namedTunnelSelectedPresetId || '');
      }
    } catch {
      toast.error(t('tunnelSettings.failedSaveTunnel'));
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
      toast.error(t('tunnelSettings.failedSaveTtl'));
    } finally {
      setIsSavingTtl(false);
    }
  }, [t]);

  const persistNamedTunnelToken = React.useCallback(async (payload: {
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
        namedTunnelPresetTokens: tokenMap,
      });
      setSavedTokenPresetIds((prev) => {
        const next = new Set(prev);
        next.add(payload.presetId);
        return next;
      });
    } catch {
      toast.error(t('tunnelSettings.failedSaveToken'));
    }
  }, [sessionTokensByPresetId, t]);

  const handleStart = React.useCallback(async () => {
    setState('starting');
    setErrorMessage(null);
    setNamedValidationError(null);

    try {
      let namedTunnelHostname = '';
      let namedTunnelToken = '';

      if (tunnelMode === 'named') {
        if (!selectedPreset) {
          setState('idle');
          setNamedValidationError(t('tunnelSettings.selectOrAddNamed'));
          toast.error(t('tunnelSettings.selectOrAddNamed'));
          return;
        }

        namedTunnelHostname = selectedPreset.hostname;
        namedTunnelToken = (sessionTokensByPresetId[selectedPreset.id] || '').trim();

        await saveTunnelSettings({
          tunnelMode: 'named',
          namedTunnelHostname,
          namedTunnelPresets,
          namedTunnelSelectedPresetId: selectedPreset.id,
        });
      }

      const res = await fetch('/api/openchamber/tunnel/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: tunnelMode,
          ...(tunnelMode === 'named' && selectedPreset ? {
            namedTunnelPresetId: selectedPreset.id,
            namedTunnelPresetName: selectedPreset.name,
          } : {}),
          ...(tunnelMode === 'named' && namedTunnelHostname ? { namedTunnelHostname } : {}),
          ...(tunnelMode === 'named' && namedTunnelToken ? { namedTunnelToken } : {}),
        }),
      });
      const data = await res.json();

      if (!res.ok || !data.ok) {
        if (tunnelMode === 'named' && typeof data.error === 'string' && data.error.includes('Named tunnel token is required')) {
          setState('idle');
          setNamedValidationError(t('tunnelSettings.tokenRequired'));
          toast.error(t('tunnelSettings.addTokenFirst'));
          return;
        }
        setState('error');
        const message = data.error || t('tunnelSettings.failedStartTunnel');
        setErrorMessage(message);
        toast.error(message);
        return;
      }

      setTunnelInfo({
        url: data.url,
        connectUrl: typeof data.connectUrl === 'string' ? data.connectUrl : null,
        bootstrapExpiresAt: typeof data.bootstrapExpiresAt === 'number' ? data.bootstrapExpiresAt : null,
      });
      setActiveTunnelMode(data.activeTunnelMode === 'named' || data.activeTunnelMode === 'quick'
        ? data.activeTunnelMode
        : (data.mode === 'named' || data.mode === 'quick' ? data.mode : tunnelMode));
      setSessionRecords(Array.isArray(data.activeSessions) ? data.activeSessions : []);
      if (Array.isArray(data.namedTunnelTokenPresetIds)) {
        setSavedTokenPresetIds(new Set(data.namedTunnelTokenPresetIds));
      }
      if (typeof data.localPort === 'number') {
        setLocalPort(data.localPort);
      }
      if (data.mode === 'named' || data.mode === 'quick') {
        setTunnelMode(data.mode);
      }
      setState('active');
      toast.success(t('tunnelSettings.tunnelReady'));
    } catch {
      setState('error');
      setErrorMessage(t('tunnelSettings.failedStartTunnel'));
      toast.error(t('tunnelSettings.failedStartTunnel'));
    }
  }, [
    namedTunnelPresets,
    saveTunnelSettings,
    selectedPreset,
    sessionTokensByPresetId,
    t,
    tunnelMode,
  ]);

  const handleStop = React.useCallback(async () => {
    setState('stopping');

    try {
      await fetch('/api/openchamber/tunnel/stop', { method: 'POST' });
      const statusRes = await fetch('/api/openchamber/tunnel/status');
      if (statusRes.ok) {
        const statusData = (await statusRes.json()) as TunnelStatusResponse;
        setSessionRecords(Array.isArray(statusData.activeSessions) ? statusData.activeSessions : []);
        setSavedTokenPresetIds(new Set(Array.isArray(statusData.namedTunnelTokenPresetIds) ? statusData.namedTunnelTokenPresetIds : []));
        setLocalPort(typeof statusData.localPort === 'number' ? statusData.localPort : null);
      }
      setTunnelInfo(null);
      setActiveTunnelMode(null);
      setQrDataUrl(null);
      setState('idle');
      toast.success(t('tunnelSettings.tunnelStopped'));
    } catch {
      setState('error');
      setErrorMessage(t('tunnelSettings.failedStopTunnel'));
      toast.error(t('tunnelSettings.failedStopTunnel'));
    }
  }, [t]);

  const handleCopyUrl = React.useCallback(async () => {
    if (!tunnelInfo?.connectUrl) {
      return;
    }

    try {
      await navigator.clipboard.writeText(tunnelInfo.connectUrl);
      setCopied(true);
      toast.success(t('tunnelSettings.connectCopied'));
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error(t('tunnelSettings.failedCopyUrl'));
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
    setNamedValidationError(null);
    setErrorMessage(null);
    if (state !== 'active' && state !== 'stopping' && state !== 'starting') {
      setState('idle');
    }

    const nextHostname = value === 'named' && selectedPreset ? selectedPreset.hostname : undefined;
    await saveTunnelSettings({
      tunnelMode: value,
      ...(nextHostname ? { namedTunnelHostname: nextHostname } : {}),
      namedTunnelPresets,
      namedTunnelSelectedPresetId: selectedPresetId || undefined,
    });
  }, [namedTunnelPresets, saveTunnelSettings, selectedPreset, selectedPresetId, state]);

  const persistSelectedPreset = React.useCallback(async (preset: NamedTunnelPreset, presets: NamedTunnelPreset[]) => {
    try {
      await updateDesktopSettings({
        namedTunnelSelectedPresetId: preset.id,
        namedTunnelHostname: preset.hostname,
        namedTunnelPresets: presets,
      });
    } catch {
      toast.error(t('tunnelSettings.failedSaveSelected'));
    }
  }, [t]);

  const handleSelectPreset = React.useCallback((presetId: string) => {
    const preset = namedTunnelPresets.find((entry) => entry.id === presetId);
    if (!preset) {
      return;
    }

    setSelectedPresetId(preset.id);
    setNamedValidationError(null);
    void persistSelectedPreset(preset, namedTunnelPresets);
  }, [namedTunnelPresets, persistSelectedPreset]);

  const handleSaveNewPreset = React.useCallback(async () => {
    const name = newPresetName.trim();
    const hostname = normalizePresetHostname(newPresetHostname);
    const token = newPresetToken.trim();

    if (!name) {
      toast.error(t('tunnelSettings.tunnelNameRequired'));
      return;
    }
    if (!hostname) {
      toast.error(t('tunnelSettings.hostnameRequired'));
      return;
    }
    if (!token) {
      toast.error(t('tunnelSettings.tokenRequiredField'));
      return;
    }

    if (namedTunnelPresets.some((preset) => preset.hostname === hostname)) {
      toast.error(t('tunnelSettings.hostnameExists'));
      return;
    }

    const nextPreset: NamedTunnelPreset = {
      id: createPresetId(),
      name,
      hostname,
    };
    const nextPresets = [...namedTunnelPresets, nextPreset];

    setNamedTunnelPresets(nextPresets);
    setSelectedPresetId(nextPreset.id);
    setExpandedNamedTunnels((prev) => ({ ...prev, [nextPreset.id]: true }));
    setSessionTokensByPresetId((prev) => ({ ...prev, [nextPreset.id]: token }));
    setNamedValidationError(null);
    setIsAddingPreset(false);
    setNewPresetName('');
    setNewPresetHostname('');
    setNewPresetToken('');

    await saveTunnelSettings({
      tunnelMode: 'named',
      namedTunnelHostname: nextPreset.hostname,
      namedTunnelPresets: nextPresets,
      namedTunnelSelectedPresetId: nextPreset.id,
      namedTunnelPresetTokens: {
        ...sessionTokensByPresetId,
        [nextPreset.id]: token,
      },
    });
    await persistNamedTunnelToken({
      presetId: nextPreset.id,
      presetName: nextPreset.name,
      hostname: nextPreset.hostname,
      token,
    });
    toast.success(t('tunnelSettings.namedTunnelSaved'));
  }, [namedTunnelPresets, newPresetHostname, newPresetName, newPresetToken, persistNamedTunnelToken, saveTunnelSettings, sessionTokensByPresetId, t]);

  const handleRemovePreset = React.useCallback(async (presetId: string) => {
    const preset = namedTunnelPresets.find((entry) => entry.id === presetId);
    if (!preset) {
      return;
    }

    const nextPresets = namedTunnelPresets.filter((entry) => entry.id !== preset.id);
    const fallbackSelectedId = nextPresets[0]?.id || '';
    const nextSelectedId = selectedPresetId === preset.id ? fallbackSelectedId : selectedPresetId;
    const nextSelectedPreset = nextPresets.find((entry) => entry.id === nextSelectedId) || null;
    const nextHostname = nextSelectedPreset?.hostname;
    const nextTokenMap = Object.fromEntries(
      Object.entries(sessionTokensByPresetId)
        .filter(([id, tokenValue]) => id !== preset.id && tokenValue.trim().length > 0)
    );

    setNamedTunnelPresets(nextPresets);
    setSelectedPresetId(nextSelectedId);
    setExpandedNamedTunnels((prev) => {
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
    setNamedValidationError(null);

    await saveTunnelSettings({
      namedTunnelPresets: nextPresets,
      namedTunnelSelectedPresetId: nextSelectedId || undefined,
      namedTunnelHostname: nextHostname,
      namedTunnelPresetTokens: nextTokenMap,
    });

    toast.success(t('tunnelSettings.namedTunnelRemoved'));
  }, [namedTunnelPresets, saveTunnelSettings, selectedPresetId, sessionTokensByPresetId, t]);

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
        <h3 className="typography-ui-header font-semibold text-foreground">{t('tunnelSettings.title')}</h3>
        <p className="typography-meta mt-0 text-muted-foreground/70">
          {t('tunnelSettings.description')}
        </p>
        <p className="typography-meta mt-0 text-muted-foreground/60">
          {t('tunnelSettings.secureEnforced')}
        </p>
        <p className="typography-meta mt-0 text-muted-foreground/60">
          {t('tunnelSettings.connectLinkExpiry')}
        </p>
      </div>

      {renderedSessionRecords.length > 0 && (
        <section className="space-y-2 px-2 pb-2 pt-0">
          <div className="rounded-lg border border-[var(--status-info-border)] bg-[var(--status-info-background)]/30 p-3">
            <div className="mb-2 flex items-center gap-2">
              <RiInformationLine className="size-4 text-[var(--status-info)]" />
              <p className="typography-ui-label text-foreground">{t('tunnelSettings.redeemedAccessLinks')}</p>
            </div>
            <div className="space-y-1">
              {renderedSessionRecords.map((record) => {
                const isQuick = record.mode === 'quick';
                const modeBadgeClass = isQuick
                  ? 'border-[var(--status-warning-border)] bg-[var(--status-warning-background)] text-[var(--status-warning)]'
                  : 'border-[var(--status-info-border)] bg-[var(--status-info-background)] text-[var(--status-info)]';
                const statusDotClass = record.isActive
                  ? (isQuick ? 'text-[var(--status-warning)]' : 'text-[var(--status-info)]')
                  : 'text-muted-foreground/50';

                return (
                  <div
                    key={record.sessionId}
                    className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded border border-[var(--surface-subtle)] bg-[var(--surface-elevated)] px-2 py-1.5"
                  >
                    <RiCheckboxBlankCircleFill className={cn('size-2.5 shrink-0', statusDotClass)} />
                    <span className={cn('typography-micro rounded border px-1.5 py-0.5 uppercase', modeBadgeClass)}>
                      {isQuick ? t('tunnelSettings.quickBadge') : t('tunnelSettings.namedBadge')}
                    </span>
                    <span className="typography-meta text-muted-foreground/80">
                      {t('tunnelSettings.redeemedAt', { time: formatAbsoluteTime(record.createdAt) })}
                    </span>
                    <span className="typography-meta text-foreground">
                      {record.isActive
                        ? t('tunnelSettings.expiresIn', { time: record.remainingTextForSession })
                        : (record.inactiveStatus === 'inactive'
                            ? t('tunnelSettings.inactive')
                            : t('tunnelSettings.inactiveWithReason', {
                                reason: record.inactiveStatus === 'expired'
                                  ? t('tunnelSettings.expired')
                                  : t('tunnelSettings.revoked'),
                              }))}
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
              <p className="typography-meta font-medium text-foreground">{t('tunnelSettings.cloudflaredNotFound')}</p>
              <p className="typography-meta text-muted-foreground/70">{t('tunnelSettings.installInstructions')}</p>
              <code className="typography-code block rounded bg-muted/50 px-2 py-1 text-xs text-foreground">
                brew install cloudflared
              </code>
            </div>
          </div>
        </section>
      )}

      {state !== 'not-available' && (
        <section className="space-y-4 px-2 pb-2 pt-0">
          <div className="space-y-1.5">
            <p className="typography-ui-label text-foreground">{t('tunnelSettings.tunnelType')}</p>
            <div className="flex flex-wrap items-center gap-1">
              <Tooltip delayDuration={700}>
                <TooltipTrigger asChild>
                  <ButtonSmall
                    variant="outline"
                    size="xs"
                    className={cn(
                      '!font-normal',
                      tunnelMode === 'quick'
                        ? 'border-[var(--status-warning-border)] bg-[var(--status-warning-background)] text-[var(--status-warning)] hover:text-[var(--status-warning)]'
                        : 'text-foreground'
                    )}
                    onClick={() => {
                      void handleModeChange('quick');
                    }}
                    disabled={isSavingMode || state === 'starting' || state === 'stopping'}
                  >
                    {t('tunnelSettings.quickMode')}
                  </ButtonSmall>
                </TooltipTrigger>
                <TooltipContent sideOffset={8} className="max-w-xs">
                  {t('tunnelSettings.quickTooltip')}
                </TooltipContent>
              </Tooltip>

              <Tooltip delayDuration={700}>
                <TooltipTrigger asChild>
                  <ButtonSmall
                    variant="outline"
                    size="xs"
                    className={cn(
                      '!font-normal',
                      tunnelMode === 'named'
                        ? 'border-[var(--status-info-border)] bg-[var(--status-info-background)] text-[var(--status-info)] hover:text-[var(--status-info)]'
                        : 'text-foreground'
                    )}
                    onClick={() => {
                      void handleModeChange('named');
                    }}
                    disabled={isSavingMode || state === 'starting' || state === 'stopping'}
                  >
                    {t('tunnelSettings.namedMode')}
                  </ButtonSmall>
                </TooltipTrigger>
                <TooltipContent sideOffset={8} className="max-w-xs">
                  {t('tunnelSettings.namedTooltip')}
                </TooltipContent>
              </Tooltip>
            </div>
          </div>

          <div className="mt-2 grid grid-cols-1 gap-2 py-1.5 md:grid-cols-[14rem_auto] md:gap-x-8 md:gap-y-2">
            <div className="flex min-w-0 items-center gap-2">
              <span className="typography-ui-label shrink-0 text-foreground">{t('tunnelSettings.connectLinkTtl')}</span>
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
              <span className="typography-ui-label shrink-0 text-foreground">{t('tunnelSettings.tunnelSessionTtl')}</span>
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
                    {t('tunnelSettings.quickTunnelWarning')}
                  </p>
                  <p className="typography-meta mt-1 text-[var(--status-warning)]">
                    {t('tunnelSettings.reliableAccess')}
                  </p>
                </div>
              </div>
            </div>
          )}

          {tunnelMode === 'named' && (
            <div className="space-y-2 rounded-lg border border-[var(--interactive-border)] bg-[var(--surface-elevated)] p-3">
              {typeof suggestedConnectorPort === 'number' && (
                <div className="rounded-md border border-[var(--status-info-border)] bg-[var(--status-info-background)]/35 px-2 py-1.5">
                  <p className="typography-meta text-[var(--status-info)]">
                    Cloudflare connector target: <code>http://localhost:{suggestedConnectorPort}</code>
                  </p>
                </div>
              )}

              <div className="mb-1 flex items-center justify-between gap-3">
                <p className="typography-ui-label text-foreground">{t('tunnelSettings.savedNamedTunnels')}</p>
                <ButtonSmall
                  variant="ghost"
                  size="xs"
                  className="!font-normal"
                  onClick={() => setIsAddingPreset((prev) => !prev)}
                  disabled={state === 'starting' || state === 'stopping' || isSavingMode}
                >
                  <RiAddLine className="h-3.5 w-3.5" />
                  {t('common.add')}
                </ButtonSmall>
              </div>

              {namedTunnelPresets.length > 0 ? (
                <div className="overflow-hidden rounded-md border border-[var(--surface-subtle)]">
                  {namedTunnelPresets.map((preset, index) => {
                    const rowToken = sessionTokensByPresetId[preset.id] || '';
                    const hasSavedToken = savedTokenPresetIds.has(preset.id);
                    const isOpen = expandedNamedTunnels[preset.id] ?? false;

                    return (
                      <div
                        key={preset.id}
                        className={cn(index < namedTunnelPresets.length - 1 && 'border-b border-[var(--surface-subtle)]')}
                      >
                        <Collapsible
                          open={isOpen}
                          onOpenChange={(open) => {
                            setExpandedNamedTunnels((prev) => ({ ...prev, [preset.id]: open }));
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

                            <ButtonSmall
                              variant="ghost"
                              size="xs"
                              className="h-7 w-7 p-0 text-muted-foreground hover:text-[var(--status-error)]"
                              aria-label={t('tunnelSettings.removeNamedTunnelAria', { name: preset.name })}
                              onClick={() => {
                                void handleRemovePreset(preset.id);
                              }}
                              disabled={state === 'starting' || state === 'stopping' || isSavingMode}
                            >
                              <RiDeleteBinLine className="h-3.5 w-3.5" />
                            </ButtonSmall>
                          </div>

                          <CollapsibleContent className="pt-1.5">
                            <div className="space-y-1 px-3 pb-2">
                              <p className="typography-meta text-muted-foreground/70">{t('tunnelSettings.hostname')} <code>{preset.hostname}</code></p>
                              <Input
                                type="password"
                                value={rowToken}
                                onChange={(event) => {
                                  const nextValue = event.target.value;
                                  setNamedValidationError(null);
                                  setSessionTokensByPresetId((prev) => ({ ...prev, [preset.id]: nextValue }));
                                }}
                                onBlur={(event) => {
                                  const tokenToSave = event.currentTarget.value.trim();
                                  if (!tokenToSave) {
                                    return;
                                  }
                                  void persistNamedTunnelToken({
                                    presetId: preset.id,
                                    presetName: preset.name,
                                    hostname: preset.hostname,
                                    token: tokenToSave,
                                  });
                                }}
                                placeholder={hasSavedToken ? t('tunnelSettings.savedTokenAvailable') : t('tunnelSettings.pasteToken')}
                                className="h-7"
                                disabled={state === 'starting' || state === 'stopping'}
                              />
                              <div className="flex items-center justify-end">
                                <ButtonSmall
                                  variant="ghost"
                                  size="xs"
                                  className="!font-normal"
                                  disabled={state === 'starting' || state === 'stopping' || rowToken.trim().length === 0}
                                  onClick={() => {
                                    void persistNamedTunnelToken({
                                      presetId: preset.id,
                                      presetName: preset.name,
                                      hostname: preset.hostname,
                                      token: rowToken,
                                    });
                                  }}
                                >
                                  {t('tunnelSettings.saveToken')}
                                </ButtonSmall>
                              </div>
                            </div>
                          </CollapsibleContent>
                        </Collapsible>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="typography-meta text-muted-foreground/70">{t('tunnelSettings.noNamedTunnels')}</p>
              )}

              {isAddingPreset && (
                <div className="space-y-2 rounded-md border border-[var(--surface-subtle)] p-2">
                  <Input
                    value={newPresetName}
                    onChange={(event) => setNewPresetName(event.target.value)}
                    placeholder={t('tunnelSettings.tunnelName')}
                    className="h-7"
                    disabled={isSavingMode || state === 'starting' || state === 'stopping'}
                  />
                  <Input
                    value={newPresetHostname}
                    onChange={(event) => setNewPresetHostname(event.target.value)}
                    placeholder={t('tunnelSettings.hostnameExample')}
                    className="h-7"
                    disabled={isSavingMode || state === 'starting' || state === 'stopping'}
                  />
                  <Input
                    type="password"
                    value={newPresetToken}
                    onChange={(event) => setNewPresetToken(event.target.value)}
                    placeholder={t('tunnelSettings.token')}
                    className="h-7"
                    disabled={isSavingMode || state === 'starting' || state === 'stopping'}
                  />
                  {typeof suggestedConnectorPort === 'number' && (
                    <p className="typography-meta text-muted-foreground/70">
                      {t('tunnelSettings.cloudflareConnector', { port: suggestedConnectorPort })}
                    </p>
                  )}
                  <div className="flex items-center gap-2">
                    <ButtonSmall
                      variant="ghost"
                      size="xs"
                      className="!font-normal"
                      onClick={() => {
                        void handleSaveNewPreset();
                      }}
                      disabled={isSavingMode || state === 'starting' || state === 'stopping'}
                    >
                      {t('common.save')}
                    </ButtonSmall>
                    <ButtonSmall
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
                      {t('common.cancel')}
                    </ButtonSmall>
                  </div>
                </div>
              )}

              <div className="flex items-center gap-1.5">
                <p className="typography-meta text-muted-foreground/80">{t('tunnelSettings.tokenInfo')}</p>
                <Tooltip delayDuration={700}>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      className="rounded p-0.5 text-muted-foreground/70 hover:text-foreground"
                      aria-label={t('tunnelSettings.tokenInfo')}
                    >
                      <RiInformationLine className="h-3.5 w-3.5" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent sideOffset={8} className="max-w-xs">
                    {t('tunnelSettings.tokenSavedLocation')}
                  </TooltipContent>
                </Tooltip>
              </div>

              {!selectedPreset && namedValidationError && (
                <p className="typography-meta text-[var(--status-error)]">{namedValidationError}</p>
              )}
            </div>
          )}

          {!isSelectedModeTunnelReady && (
            <div className="space-y-6">
              <div className="rounded-lg border border-[var(--status-info-border)] bg-[var(--status-info-background)] p-3">
                <div className="flex items-start gap-2">
                  <RiInformationLine className="mt-0.5 size-4 shrink-0 text-[var(--status-info)]" />
                  <div className="space-y-1">
                    {tunnelMode === 'named' && (
                      <>
                        <p className="typography-meta text-[var(--status-info)]">
                          {t('tunnelSettings.namedTunnelRequires')}
                        </p>
                        <button
                          type="button"
                          className="typography-meta inline-flex items-center gap-1 text-[var(--status-info)] underline underline-offset-2 hover:opacity-90"
                          onClick={() => {
                            void openExternal(NAMED_TUNNEL_DOC_URL);
                          }}
                        >
                          {t('tunnelSettings.namedTunnelDoc')}
                          <RiExternalLinkLine className="size-3.5" />
                        </button>
                      </>
                    )}
                    <p className="typography-meta text-[var(--status-info)]">
                      {t('tunnelSettings.startTunnelInfo', { mode: tunnelMode === 'named' ? t('tunnelSettings.namedMode') : t('tunnelSettings.quickMode') })}
                    </p>
                  </div>
                </div>
              </div>

              {tunnelMode === 'named' && (
                <div className="space-y-1.5">
                  <p className="typography-ui-label text-foreground">{t('tunnelSettings.namedTunnelToConnect')}</p>
                  <Select
                    value={selectedPresetId || (namedTunnelPresets[0]?.id ?? '')}
                    onValueChange={(presetId) => {
                      void handleSelectPreset(presetId);
                    }}
                    disabled={
                      isSavingMode
                      || state === 'starting'
                      || state === 'stopping'
                      || namedTunnelPresets.length <= 1
                    }
                  >
                    <SelectTrigger>
                      <SelectValue placeholder={t('tunnelSettings.selectSavedTunnel')} />
                    </SelectTrigger>
                    <SelectContent fitContent>
                      {namedTunnelPresets.map((preset) => (
                        <SelectItem key={preset.id} value={preset.id}>{preset.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              <ButtonSmall
                variant="outline"
                onClick={handleStart}
                disabled={state === 'starting' || isSavingMode || (tunnelMode === 'named' && !selectedPreset)}
                className={cn(primaryCtaClass, state === 'starting' && 'opacity-70')}
              >
                {state === 'starting'
                  ? <><RiLoader4Line className="size-3.5 animate-spin" /> {t('tunnelSettings.startingTunnel')}</>
                  : t('tunnelSettings.startTunnel')}
              </ButtonSmall>
            </div>
          )}

        </section>
      )}

      {isSelectedModeTunnelReady && tunnelInfo && (
        <section className="space-y-4 px-2 pb-2 pt-0">
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <div className="size-2 shrink-0 rounded-full bg-[var(--status-success)]" />
              <p className="typography-meta font-medium text-foreground">{t('tunnelSettings.tunnelReadyState')}</p>
            </div>

            <div>
              <p className="typography-meta mb-1 text-muted-foreground/70">{t('tunnelSettings.publicUrlLabel')}</p>
              <code className="typography-code block truncate rounded bg-muted/50 px-2 py-1 text-xs text-foreground">
                {tunnelInfo.url}
              </code>
            </div>

            {isConnectLinkLive && tunnelInfo.connectUrl && (
              <>
                <div>
                  <p className="typography-meta mb-1 text-muted-foreground/70">{t('tunnelSettings.connectLinkLabel')}</p>
                  <div className="flex items-center gap-2">
                    <code className="typography-code flex-1 truncate rounded bg-muted/50 px-2 py-1 text-xs text-foreground">
                      {tunnelInfo.connectUrl}
                    </code>
                    <ButtonSmall variant="ghost" onClick={handleCopyUrl} className="shrink-0 gap-1.5">
                      {copied
                        ? <RiCheckLine className="size-3.5 text-[var(--status-success)]" />
                        : <RiFileCopyLine className="size-3.5" />}
                      {copied ? t('tunnelSettings.copied') : t('common.copy')}
                    </ButtonSmall>
                  </div>
                  <p className="typography-meta mt-1 text-muted-foreground/70">
                    {t('tunnelSettings.expires')}: {tunnelInfo.bootstrapExpiresAt ? remainingText : t('tunnelSettings.noExpiry')}
                  </p>
                </div>

                <div className="flex flex-col items-center gap-2 rounded-lg border border-border/50 bg-[var(--surface-elevated)] p-4">
                  {qrDataUrl
                    ? <img src={qrDataUrl} alt={t('tunnelSettings.tunnelConnectQrAlt')} className="size-48" />
                    : <div className="size-48 rounded bg-muted/30" />}
                  <p className="typography-meta text-muted-foreground">{t('tunnelSettings.scanToConnect')}</p>
                </div>
              </>
            )}
          </div>

          <div className="pt-1">
            <div className="flex flex-wrap items-center gap-2">
              <ButtonSmall
                variant="outline"
                onClick={handleStart}
                disabled={state === 'stopping' || isSavingMode}
                className={primaryCtaClass}
              >
                <RiRestartLine className="size-3.5" />
                {t('tunnelSettings.newConnectLink')}
              </ButtonSmall>

              <ButtonSmall
                variant="ghost"
                onClick={handleStop}
                disabled={state === 'stopping' || isSavingMode}
                className="gap-2 text-[var(--status-error)]"
              >
                {state === 'stopping'
                  ? <><RiLoader4Line className="size-3.5 animate-spin" /> {t('tunnelSettings.stoppingTunnel')}</>
                  : t('tunnelSettings.stopTunnel')}
              </ButtonSmall>
            </div>
          </div>
        </section>
      )}

      {state === 'error' && errorMessage && (
        <section className="space-y-3 px-2 pb-2 pt-0">
          <p className="typography-meta text-[var(--status-error)]">{errorMessage}</p>
          <ButtonSmall variant="ghost" onClick={handleStart}>{t('common.retry')}</ButtonSmall>
        </section>
      )}
    </div>
  );
};
