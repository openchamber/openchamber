import React from 'react';
import QRCode from 'qrcode';
import {
  RiAddLine,
  RiCheckboxBlankCircleFill,
  RiCheckLine,
  RiErrorWarningLine,
  RiFileCopyLine,
  RiInformationLine,
  RiLoader4Line,
  RiRestartLine,
} from '@remixicon/react';
import { toast } from '@/components/ui';
import { ButtonSmall } from '@/components/ui/button-small';
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
  { value: '180000', label: '3 minutes (recommended)', ms: 3 * 60 * 1000 },
  { value: '1800000', label: '30 minutes', ms: 30 * 60 * 1000 },
  { value: '7200000', label: '2 hours', ms: 2 * 60 * 60 * 1000 },
  { value: '28800000', label: '8 hours', ms: 8 * 60 * 60 * 1000 },
  { value: '86400000', label: '24 hours', ms: 24 * 60 * 60 * 1000 },
  { value: 'never', label: 'Never expires (risky)', ms: null },
];

const SESSION_TTL_OPTIONS: TtlOption[] = [
  { value: '3600000', label: '1 hour', ms: 60 * 60 * 1000 },
  { value: '28800000', label: '8 hours (workday)', ms: 8 * 60 * 60 * 1000 },
  { value: '43200000', label: '12 hours', ms: 12 * 60 * 60 * 1000 },
  { value: '86400000', label: '24 hours', ms: 24 * 60 * 60 * 1000 },
];

const QUICK_TUNNEL_TOOLTIP = 'Quick Tunnel is best effort and Cloudflare does not guarantee uptime. For more reliable long-lived access, switch to Named Tunnel mode.';
const NAMED_TUNNEL_TOOLTIP = 'Named Tunnel mode uses your Cloudflare account and custom hostname for more reliable remote access.';

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
  activeTunnelMode?: TunnelMode | null;
  activeSessions?: TunnelSessionRecord[];
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
  const [selectedPresetId, setSelectedPresetId] = React.useState<string>('');
  const [sessionTokensByPresetId, setSessionTokensByPresetId] = React.useState<Record<string, string>>({});
  const [isAddingPreset, setIsAddingPreset] = React.useState(false);
  const [newPresetName, setNewPresetName] = React.useState('');
  const [newPresetHostname, setNewPresetHostname] = React.useState('');
  const [bootstrapTtlMs, setBootstrapTtlMs] = React.useState<number | null>(3 * 60 * 1000);
  const [sessionTtlMs, setSessionTtlMs] = React.useState<number>(8 * 60 * 60 * 1000);
  const [remainingText, setRemainingText] = React.useState<string>('');
  const [sessionRecords, setSessionRecords] = React.useState<TunnelSessionRecord[]>([]);
  const [nowTs, setNowTs] = React.useState<number>(() => Date.now());

  const selectedPreset = React.useMemo(
    () => namedTunnelPresets.find((preset) => preset.id === selectedPresetId) || null,
    [namedTunnelPresets, selectedPresetId]
  );
  const selectedPresetToken = selectedPreset ? (sessionTokensByPresetId[selectedPreset.id] || '') : '';
  const renderedSessionRecords = React.useMemo(() => {
    return sessionRecords.map((record) => {
      const isExpired = record.expiresAt <= nowTs;
      const isActive = record.status === 'active' && !isExpired;
      const remainingTextForSession = isActive
        ? formatRemaining(record.expiresAt - nowTs)
        : (record.inactiveReason === 'expired' || isExpired ? 'expired' : 'inactive');
      const inactiveLabel = remainingTextForSession === 'expired'
        ? 'Expired'
        : (record.inactiveReason === 'tunnel-revoked' ? 'Revoked' : 'Inactive');

      const mode = record.mode === 'named' ? 'named' : 'quick';
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
            : 3 * 60 * 1000);
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
          ? [{ id: 'legacy-default', name: 'Default', hostname: normalizePresetHostname(loadedHostname) }]
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
        setErrorMessage('Failed to check tunnel availability');
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
      setRemainingText('No expiry');
      return;
    }

    const updateRemaining = () => {
      const remaining = tunnelInfo.bootstrapExpiresAt ? tunnelInfo.bootstrapExpiresAt - Date.now() : 0;
      if (remaining <= 0) {
        setRemainingText('Expired');
      } else {
        setRemainingText(formatRemaining(remaining));
      }
    };

    updateRemaining();
    const timer = window.setInterval(updateRemaining, 1000);
    return () => window.clearInterval(timer);
  }, [tunnelInfo?.bootstrapExpiresAt]);

  React.useEffect(() => {
    const timer = window.setInterval(() => setNowTs(Date.now()), 1000);
    return () => window.clearInterval(timer);
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
      toast.error('Failed to save tunnel settings');
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
      toast.error('Failed to save tunnel TTL settings');
    } finally {
      setIsSavingTtl(false);
    }
  }, []);

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
          setNamedValidationError('Select or add a named tunnel first');
          toast.error('Select or add a named tunnel first');
          return;
        }

        namedTunnelHostname = selectedPreset.hostname;
        namedTunnelToken = (sessionTokensByPresetId[selectedPreset.id] || '').trim();

        if (!namedTunnelToken) {
          setState('idle');
          setNamedValidationError('Named tunnel token is required before starting');
          toast.error('Add a named tunnel token before starting');
          return;
        }

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
          ...(tunnelMode === 'named' && namedTunnelHostname ? { namedTunnelHostname } : {}),
          ...(tunnelMode === 'named' && namedTunnelToken ? { namedTunnelToken } : {}),
        }),
      });
      const data = await res.json();

      if (!res.ok || !data.ok) {
        if (tunnelMode === 'named' && typeof data.error === 'string' && data.error.includes('Named tunnel token is required')) {
          setState('idle');
          setNamedValidationError('Named tunnel token is required before starting');
          toast.error('Add a named tunnel token before starting');
          return;
        }
        setState('error');
        setErrorMessage(data.error || 'Failed to start tunnel');
        toast.error(data.error || 'Failed to start tunnel');
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
      if (data.mode === 'named' || data.mode === 'quick') {
        setTunnelMode(data.mode);
      }
      setState('active');
      toast.success('Tunnel link ready');
    } catch {
      setState('error');
      setErrorMessage('Failed to start tunnel');
      toast.error('Failed to start tunnel');
    }
  }, [
    namedTunnelPresets,
    saveTunnelSettings,
    selectedPreset,
    sessionTokensByPresetId,
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
      }
      setTunnelInfo(null);
      setActiveTunnelMode(null);
      setQrDataUrl(null);
      setState('idle');
      toast.success('Tunnel stopped');
    } catch {
      setState('error');
      setErrorMessage('Failed to stop tunnel');
      toast.error('Failed to stop tunnel');
    }
  }, []);

  const handleCopyUrl = React.useCallback(async () => {
    if (!tunnelInfo?.connectUrl) {
      return;
    }

    try {
      await navigator.clipboard.writeText(tunnelInfo.connectUrl);
      setCopied(true);
      toast.success('Connect link copied');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('Failed to copy URL');
    }
  }, [tunnelInfo?.connectUrl]);

  const handleBootstrapTtlChange = React.useCallback(async (value: string) => {
    const option = BOOTSTRAP_TTL_OPTIONS.find((entry) => entry.value === value);
    if (!option) {
      return;
    }
    if (option.ms === null) {
      const confirmed = window.confirm('Never-expiring connect links are less secure. Continue?');
      if (!confirmed) {
        return;
      }
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

  const handleSelectPreset = React.useCallback(async (presetId: string) => {
    const preset = namedTunnelPresets.find((entry) => entry.id === presetId);
    if (!preset) {
      return;
    }

    setSelectedPresetId(preset.id);
    setNamedValidationError(null);
    await saveTunnelSettings({
      namedTunnelSelectedPresetId: preset.id,
      namedTunnelHostname: preset.hostname,
      namedTunnelPresets,
    });
  }, [namedTunnelPresets, saveTunnelSettings]);

  const handleSaveNewPreset = React.useCallback(async () => {
    const name = newPresetName.trim();
    const hostname = normalizePresetHostname(newPresetHostname);

    if (!name) {
      toast.error('Tunnel name is required');
      return;
    }
    if (!hostname) {
      toast.error('Named tunnel hostname is required');
      return;
    }

    if (namedTunnelPresets.some((preset) => preset.hostname === hostname)) {
      toast.error('This hostname already exists');
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
    setNamedValidationError(null);
    setIsAddingPreset(false);
    setNewPresetName('');
    setNewPresetHostname('');

    await saveTunnelSettings({
      tunnelMode: 'named',
      namedTunnelHostname: nextPreset.hostname,
      namedTunnelPresets: nextPresets,
      namedTunnelSelectedPresetId: nextPreset.id,
    });
    toast.success('Named tunnel saved');
  }, [namedTunnelPresets, newPresetHostname, newPresetName, saveTunnelSettings]);

  const primaryCtaClass = 'gap-2 border-[var(--primary-base)] bg-[var(--primary-base)] text-[var(--primary-foreground)] hover:bg-[var(--primary-hover)] hover:text-[var(--primary-foreground)]';

  if (state === 'checking') {
    return (
      <div className="flex items-center justify-center py-12">
        <GridLoader size="sm" />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div>
        <h3 className="typography-ui-header font-semibold text-foreground">Remote Tunnel</h3>
        <p className="typography-meta mt-1 text-muted-foreground/70">
          Configure secure remote access with quick links or your own named Cloudflare tunnel.
        </p>
        <p className="typography-meta mt-1 text-muted-foreground/60">
          Tunnel access is enforced server-side. Connect links are one-time and are revoked when tunnel stops.
        </p>
      </div>

      {renderedSessionRecords.length > 0 && (
        <section className="space-y-2 px-2 pb-2 pt-0">
          <div className="rounded-lg border border-[var(--status-info-border)] bg-[var(--status-info-background)]/30 p-3">
            <div className="mb-2 flex items-center gap-2">
              <RiInformationLine className="size-4 text-[var(--status-info)]" />
              <p className="typography-ui-label text-foreground">Redeemed access links</p>
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
                      {isQuick ? 'QUICK' : 'NAMED'}
                    </span>
                    <span className="typography-meta text-muted-foreground/80">
                      Redeemed {formatAbsoluteTime(record.createdAt)}
                    </span>
                    <span className="typography-meta text-foreground">
                      {record.isActive
                        ? `Expires in ${record.remainingTextForSession}`
                        : (record.inactiveLabel === 'Inactive' ? 'Inactive' : `Inactive (${record.inactiveLabel})`)}
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
              <p className="typography-meta font-medium text-foreground">cloudflared not found</p>
              <p className="typography-meta text-muted-foreground/70">Install it to enable remote tunnel access:</p>
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
            <p className="typography-ui-label text-foreground">Tunnel type</p>
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
                    Quick Tunnel
                  </ButtonSmall>
                </TooltipTrigger>
                <TooltipContent sideOffset={8} className="max-w-xs">
                  {QUICK_TUNNEL_TOOLTIP}
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
                    Named Tunnel
                  </ButtonSmall>
                </TooltipTrigger>
                <TooltipContent sideOffset={8} className="max-w-xs">
                  {NAMED_TUNNEL_TOOLTIP}
                </TooltipContent>
              </Tooltip>
            </div>
          </div>

          <div className="mt-2 grid grid-cols-1 gap-2 py-1.5 md:grid-cols-[14rem_auto] md:gap-x-8 md:gap-y-2">
            <div className="flex min-w-0 items-center gap-2">
              <span className="typography-ui-label shrink-0 text-foreground">Connect link TTL</span>
              <Select
                value={ttlOptionValue(BOOTSTRAP_TTL_OPTIONS, bootstrapTtlMs, '180000')}
                onValueChange={(value) => {
                  void handleBootstrapTtlChange(value);
                }}
                disabled={isSavingTtl || isSavingMode || state === 'starting' || state === 'stopping'}
              >
                <SelectTrigger className="w-fit">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {BOOTSTRAP_TTL_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex min-w-0 items-center gap-2">
              <span className="typography-ui-label shrink-0 text-foreground">Tunnel session TTL</span>
              <Select
                value={ttlOptionValue(SESSION_TTL_OPTIONS, sessionTtlMs, '28800000')}
                onValueChange={(value) => {
                  void handleSessionTtlChange(value);
                }}
                disabled={isSavingTtl || isSavingMode || state === 'starting' || state === 'stopping'}
              >
                <SelectTrigger className="w-fit">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SESSION_TTL_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {(tunnelMode === 'quick' || bootstrapTtlMs === null) && (
            <div className="space-y-1">
              {tunnelMode === 'quick' && (
                <div className="rounded-lg border border-[var(--status-warning)]/35 bg-[var(--status-warning)]/10 p-3">
                  <div className="flex items-start gap-2">
                    <RiErrorWarningLine className="mt-0.5 size-4 shrink-0 text-[var(--status-warning)]" />
                    <div>
                      <p className="typography-meta text-[var(--status-warning)]">
                        Quick Tunnel is best effort and Cloudflare does not guarantee uptime.
                      </p>
                      <p className="typography-meta mt-1 text-[var(--status-warning)]">
                        For more reliable long-lived access, switch to Named Tunnel mode.
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {bootstrapTtlMs === null && (
                <div className="rounded-lg border border-[var(--status-warning)]/35 bg-[var(--status-warning)]/10 p-2.5">
                  <div className="flex items-start gap-2">
                    <RiErrorWarningLine className="mt-0.5 size-4 shrink-0 text-[var(--status-warning)]" />
                    <p className="typography-meta text-[var(--status-warning)]">
                      Warning: never-expiring connect links increase risk if the URL leaks. Prefer a shorter connect-link TTL.
                    </p>
                  </div>
                </div>
              )}
            </div>
          )}

          {tunnelMode === 'named' && (
            <div className="space-y-2 rounded-lg border border-[var(--interactive-border)] bg-[var(--surface-elevated)] p-3">
              <div className="mb-1 flex items-center justify-between gap-3">
                <p className="typography-ui-label text-foreground">Saved named tunnels</p>
                <ButtonSmall
                  variant="ghost"
                  size="xs"
                  className="!font-normal"
                  onClick={() => setIsAddingPreset((prev) => !prev)}
                  disabled={state === 'starting' || state === 'stopping' || isSavingMode}
                >
                  <RiAddLine className="h-3.5 w-3.5" />
                  Add
                </ButtonSmall>
              </div>

              {namedTunnelPresets.length > 0 ? (
                <div className="overflow-hidden rounded-md border border-[var(--surface-subtle)]">
                  {namedTunnelPresets.map((preset, index) => {
                    const selected = preset.id === selectedPresetId;
                    return (
                      <button
                        key={preset.id}
                        type="button"
                        className={cn(
                          'flex w-full items-center justify-between gap-3 px-3 py-2 text-left transition-colors',
                          selected
                            ? 'bg-[var(--interactive-selection)]/15 text-[var(--surface-foreground)]'
                            : 'bg-transparent hover:bg-[var(--interactive-hover)]/40',
                          index < namedTunnelPresets.length - 1 && 'border-b border-[var(--surface-subtle)]'
                        )}
                        onClick={() => {
                          void handleSelectPreset(preset.id);
                        }}
                        disabled={state === 'starting' || state === 'stopping' || isSavingMode}
                      >
                        <span className="min-w-0">
                          <span className="typography-ui-label block truncate text-foreground">{preset.name}</span>
                          <span className="typography-meta block truncate text-muted-foreground/70">{preset.hostname}</span>
                        </span>
                        {selected && <span className="typography-micro text-[var(--interactive-selection)]">selected</span>}
                      </button>
                    );
                  })}
                </div>
              ) : (
                <p className="typography-meta text-muted-foreground/70">No named tunnels saved yet.</p>
              )}

              {isAddingPreset && (
                <div className="space-y-2 rounded-md border border-[var(--surface-subtle)] p-2">
                  <Input
                    value={newPresetName}
                    onChange={(event) => setNewPresetName(event.target.value)}
                    placeholder="Tunnel name (e.g. Production)"
                    className="h-7"
                    disabled={isSavingMode || state === 'starting' || state === 'stopping'}
                  />
                  <Input
                    value={newPresetHostname}
                    onChange={(event) => setNewPresetHostname(event.target.value)}
                    placeholder="Hostname (e.g. oc.example.com)"
                    className="h-7"
                    disabled={isSavingMode || state === 'starting' || state === 'stopping'}
                  />
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
                      Save
                    </ButtonSmall>
                    <ButtonSmall
                      variant="ghost"
                      size="xs"
                      className="!font-normal"
                      onClick={() => {
                        setIsAddingPreset(false);
                        setNewPresetName('');
                        setNewPresetHostname('');
                      }}
                      disabled={isSavingMode || state === 'starting' || state === 'stopping'}
                    >
                      Cancel
                    </ButtonSmall>
                  </div>
                </div>
              )}

              {selectedPreset && (
                <div className="space-y-1">
                  <div className="flex items-center gap-1.5">
                    <p className="typography-meta text-muted-foreground/80">Session token for selected tunnel</p>
                    <Tooltip delayDuration={700}>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          className="rounded p-0.5 text-muted-foreground/70 hover:text-foreground"
                          aria-label="Named tunnel token info"
                        >
                          <RiInformationLine className="h-3.5 w-3.5" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent sideOffset={8} className="max-w-xs">
                        Token is kept only in this app runtime. It is never written to disk.
                      </TooltipContent>
                    </Tooltip>
                  </div>
                  <Input
                    type="password"
                    value={selectedPresetToken}
                    onChange={(event) => {
                      const nextValue = event.target.value;
                      setNamedValidationError(null);
                      setSessionTokensByPresetId((prev) => ({ ...prev, [selectedPreset.id]: nextValue }));
                    }}
                    placeholder="Paste token"
                    className="h-7"
                    disabled={state === 'starting' || state === 'stopping'}
                  />
                  {namedValidationError && (
                    <p className="typography-meta text-[var(--status-error)]">{namedValidationError}</p>
                  )}
                </div>
              )}

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
                  <p className="typography-meta text-[var(--status-info)]">
                    Start a {tunnelMode === 'named' ? 'named' : 'quick'} tunnel and generate a one-time connect link. Do not close the app while this tunnel is in use.
                  </p>
                </div>
              </div>
              <ButtonSmall
                variant="outline"
                onClick={handleStart}
                disabled={state === 'starting' || isSavingMode}
                className={cn(primaryCtaClass, state === 'starting' && 'opacity-70')}
              >
                {state === 'starting'
                  ? <><RiLoader4Line className="size-3.5 animate-spin" /> Starting tunnel...</>
                  : 'Start Tunnel'}
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
              <p className="typography-meta font-medium text-foreground">Tunnel ready</p>
            </div>

            <div>
              <p className="typography-meta mb-1 text-muted-foreground/70">Public URL</p>
              <code className="typography-code block truncate rounded bg-muted/50 px-2 py-1 text-xs text-foreground">
                {tunnelInfo.url}
              </code>
            </div>

            {isConnectLinkLive && tunnelInfo.connectUrl && (
              <>
                <div>
                  <p className="typography-meta mb-1 text-muted-foreground/70">Connect link</p>
                  <div className="flex items-center gap-2">
                    <code className="typography-code flex-1 truncate rounded bg-muted/50 px-2 py-1 text-xs text-foreground">
                      {tunnelInfo.connectUrl}
                    </code>
                    <ButtonSmall variant="ghost" onClick={handleCopyUrl} className="shrink-0 gap-1.5">
                      {copied
                        ? <RiCheckLine className="size-3.5 text-[var(--status-success)]" />
                        : <RiFileCopyLine className="size-3.5" />}
                      {copied ? 'Copied' : 'Copy'}
                    </ButtonSmall>
                  </div>
                  <p className="typography-meta mt-1 text-muted-foreground/70">
                    Expires: {tunnelInfo.bootstrapExpiresAt ? remainingText : 'Never'}
                  </p>
                </div>

                <div className="flex flex-col items-center gap-2 rounded-lg border border-border/50 bg-[var(--surface-elevated)] p-4">
                  {qrDataUrl
                    ? <img src={qrDataUrl} alt="Tunnel connect QR code" className="size-48" />
                    : <div className="size-48 rounded bg-muted/30" />}
                  <p className="typography-meta text-muted-foreground">Scan with your phone to connect</p>
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
                New connect link
              </ButtonSmall>

              <ButtonSmall
                variant="ghost"
                onClick={handleStop}
                disabled={state === 'stopping' || isSavingMode}
                className="gap-2 text-[var(--status-error)]"
              >
                {state === 'stopping'
                  ? <><RiLoader4Line className="size-3.5 animate-spin" /> Stopping...</>
                  : 'Stop Tunnel'}
              </ButtonSmall>
            </div>
          </div>
        </section>
      )}

      {state === 'error' && errorMessage && (
        <section className="space-y-3 px-2 pb-2 pt-0">
          <p className="typography-meta text-[var(--status-error)]">{errorMessage}</p>
          <ButtonSmall variant="ghost" onClick={handleStart}>Retry</ButtonSmall>
        </section>
      )}
    </div>
  );
};
