import React from 'react';
import QRCode from 'qrcode';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NumberInput } from '@/components/ui/number-input';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { useDesktopSshStore } from '@/stores/useDesktopSshStore';
import { useUIStore } from '@/stores/useUIStore';
import { toast } from '@/components/ui';
import { Checkbox } from '@/components/ui/checkbox';
import { Radio } from '@/components/ui/radio';
import { Icon } from "@/components/icon/Icon";
import { cn } from '@/lib/utils';
import { copyTextToClipboard } from '@/lib/clipboard';
import { openExternalUrl } from '@/lib/url';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type { PendingPairingRecord, RemoteClientRecord } from '@/lib/api/types';
import { buildPairingConnectionPayload, encodePairingConnectionPayload, parsePairingConnectionPayload, normalizePairingCandidate, type PairingEndpointCandidate } from '@/lib/connectionPayload';
import { resolvePairingTransportRequest, consumeAddDeviceIntent, selectPairingTransport } from '@/lib/pairingTransportOptions';
import { redeemRemoteInstancePairing } from '@/lib/remoteInstancePairing';
import {
  desktopSshLogsClear,
  desktopSshLogs,
  type DesktopSshInstance,
  type DesktopSshPortForward,
  type DesktopSshPortForwardType,
} from '@/lib/desktopSsh';
import {
  desktopHostsGet,
  desktopHostsSet,
  desktopInstallIdGet,
  buildPairedDesktopHostTransportFields,
  replacePairedDesktopHostTransportFields,
  normalizeHostUrl,
  probeDesktopHostTransports,
  redactSensitiveUrl,
  resolveDesktopHostUrl,
  type DesktopHost,
  directE2eeHostFingerprint,
  type HostProbeResult,
} from '@/lib/desktopHosts';
import { getDesktopLanAddress, isDesktopLocalOriginActive, isDesktopShell } from '@/lib/desktop';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeApiBaseUrl, switchRuntimeEndpoint } from '@/lib/runtime-switch';

const randomPort = (): number => {
  return Math.floor(20000 + Math.random() * 30000);
};

const isPortInUseError = (error: unknown): boolean => {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return message.includes('address already in use') || message.includes('eaddrinuse') || message.includes('port already in use');
};

// Platform this desktop reports about itself when redeeming a pairing link —
// display-only metadata for the issuing server's device list.
const desktopPlatformName = (): string | undefined => {
  if (typeof navigator === 'undefined') return undefined;
  const ua = (navigator.userAgent || '').toLowerCase();
  if (ua.includes('mac')) return 'macos';
  if (ua.includes('win')) return 'windows';
  if (ua.includes('linux')) return 'linux';
  return undefined;
};

// Friendly label for a device's self-reported platform in the device list.
const devicePlatformLabel = (platform?: string | null): string | null => {
  switch ((platform || '').toLowerCase()) {
    case 'ios': return 'iOS';
    case 'android': return 'Android';
    case 'macos':
    case 'darwin': return 'macOS';
    case 'windows':
    case 'win32': return 'Windows';
    case 'linux': return 'Linux';
    default: return null;
  }
};

const phaseLabelKey = (phase?: string): I18nKey => {
  switch (phase) {
    case 'config_resolved':
      return 'settings.remoteInstances.page.phase.resolvingConfiguration';
    case 'auth_check':
      return 'settings.remoteInstances.page.phase.checkingAuth';
    case 'master_connecting':
      return 'settings.remoteInstances.page.phase.establishingSsh';
    case 'remote_probe':
      return 'settings.remoteInstances.page.phase.probingRemote';
    case 'installing':
      return 'settings.remoteInstances.page.phase.installingOpenChamber';
    case 'updating':
      return 'settings.remoteInstances.page.phase.updatingOpenChamber';
    case 'server_detecting':
      return 'settings.remoteInstances.page.phase.detectingServer';
    case 'server_starting':
      return 'settings.remoteInstances.page.phase.startingServer';
    case 'forwarding':
      return 'settings.remoteInstances.page.phase.forwardingPorts';
    case 'ready':
      return 'settings.remoteInstances.sidebar.phase.ready';
    case 'degraded':
      return 'settings.remoteInstances.page.phase.reconnecting';
    case 'error':
      return 'settings.remoteInstances.sidebar.phase.error';
    default:
      return 'settings.remoteInstances.sidebar.phase.idle';
  }
};

const CONNECTING_PHASES = new Set<string>([
  'config_resolved',
  'auth_check',
  'master_connecting',
  'remote_probe',
  'installing',
  'updating',
  'server_detecting',
  'server_starting',
  'forwarding',
]);

const isConnectingPhase = (phase?: string): boolean => {
  return Boolean(phase && CONNECTING_PHASES.has(phase));
};

const phaseDotClass = (phase?: string): string => {
  if (phase === 'ready') {
    return 'bg-[var(--status-success)] animate-pulse';
  }
  if (phase === 'error') {
    return 'bg-[var(--status-error)] animate-pulse';
  }
  if (phase === 'degraded' || isConnectingPhase(phase)) {
    return 'bg-[var(--status-warning)] animate-pulse';
  }
  return 'bg-muted-foreground/40';
};

const buildForwardLabel = (forward: DesktopSshPortForward): string => {
  if (forward.type === 'dynamic') {
    return `${forward.localHost || '127.0.0.1'}:${forward.localPort || 0}`;
  }
  if (forward.type === 'remote') {
    return `${forward.remoteHost || '127.0.0.1'}:${forward.remotePort || 0} -> ${forward.localHost || '127.0.0.1'}:${forward.localPort || 0}`;
  }
  return `${forward.localHost || '127.0.0.1'}:${forward.localPort || 0} -> ${forward.remoteHost || '127.0.0.1'}:${forward.remotePort || 0}`;
};

const makeForward = (): DesktopSshPortForward => {
  return {
    id: `forward-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    enabled: true,
    type: 'local',
    localHost: '127.0.0.1',
    localPort: randomPort(),
    remoteHost: '127.0.0.1',
    remotePort: 80,
  };
};

const suggestConcreteHost = (pattern: string): string => {
  const value = pattern.trim().replace(/\*/g, 'host').replace(/\?/g, 'x');
  return value || 'user@host';
};

const HintLabel: React.FC<{ label: string; hint: React.ReactNode }> = ({ label, hint }) => {
  return (
    <span className="inline-flex items-center gap-1 typography-meta text-muted-foreground">
      <span>{label}</span>
      <Tooltip>
        <TooltipTrigger asChild>
          <Icon name="information" className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help" />
        </TooltipTrigger>
        <TooltipContent sideOffset={8} className="max-w-xs">
          <div className="typography-meta text-foreground">{hint}</div>
        </TooltipContent>
      </Tooltip>
    </span>
  );
};

const forwardTypeDescriptionKey = (type: DesktopSshPortForwardType): I18nKey => {
  switch (type) {
    case 'remote':
      return 'settings.remoteInstances.page.forwardTypeDescription.remote';
    case 'dynamic':
      return 'settings.remoteInstances.page.forwardTypeDescription.dynamic';
    default:
      return 'settings.remoteInstances.page.forwardTypeDescription.local';
  }
};

const formatEndpoint = (host: string | undefined, port: number | undefined): string => {
  const value = (host || '').trim();
  const normalizedHost = !value || value === '127.0.0.1' || value === '::1' ? 'localhost' : value;
  return `${normalizedHost}:${port || 0}`;
};

const toBrowserHost = (host: string | undefined): string => {
  const value = (host || '').trim();
  if (!value || value === '0.0.0.0' || value === '::') {
    return '127.0.0.1';
  }
  return value;
};

const formatLogLine = (line: string): string => {
  const match = line.match(/^\[(\d{10,})\]\s*(?:\[([A-Z]+)\]\s*)?(.*)$/);
  if (!match) {
    return line;
  }

  const millis = Number(match[1]);
  const iso = Number.isFinite(millis) ? new Date(millis).toISOString() : match[1];
  const level = (match[2] || 'INFO').toUpperCase();
  const message = match[3] || '';
  return `[${iso}] [${level}] ${message}`;
};

type HeaderDraft = {
  id: string;
  name: string;
  value: string;
};

const createHeaderDraft = (name = '', value = ''): HeaderDraft => ({
  id: typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `header-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  name,
  value,
});

const isReservedRequestHeaderName = (name: string): boolean => name.trim().toLowerCase() === 'authorization';

const buildRequestHeaders = (headers: HeaderDraft[]): Record<string, string> | undefined => {
  const next: Record<string, string> = {};
  for (const header of headers) {
    const name = header.name.trim();
    const value = header.value.trim();
    if (name && value && !isReservedRequestHeaderName(name)) next[name] = value;
  }
  return Object.keys(next).length > 0 ? next : undefined;
};

const readRequestHeaderDrafts = (headers: Record<string, string> | undefined): HeaderDraft[] => {
  return Object.entries(headers || {}).map(([name, value]) => createHeaderDraft(name, value));
};

const getRuntimePort = (): number | null => {
  if (typeof window === 'undefined') {
    return null;
  }

  const runtimeApiBaseUrl = getRuntimeApiBaseUrl();
  const portSource = runtimeApiBaseUrl || window.location.href;
  try {
    const port = Number(new URL(portSource).port || window.location.port);
    return Number.isFinite(port) && port > 0 ? port : null;
  } catch {
    const port = Number(window.location.port);
    return Number.isFinite(port) && port > 0 ? port : null;
  }
};

const isLoopbackUrl = (value: string): boolean => {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  } catch {
    return false;
  }
};

const resolvePairingServerUrl = async (): Promise<string> => {
  const fallback = normalizeHostUrl(getRuntimeApiBaseUrl()) || window.location.origin;
  if (!isDesktopShell() || !isDesktopLocalOriginActive()) {
    return fallback;
  }

  let response: Response;
  try {
    response = await runtimeFetch('/api/config/settings', {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
  } catch {
    return fallback;
  }
  if (!response.ok) return fallback;

  const settings = (await response.json().catch(() => null)) as null | {
    desktopLanAccessActive?: unknown;
  };
  if (settings?.desktopLanAccessActive !== true) {
    return fallback;
  }

  const address = await getDesktopLanAddress();
  const port = getRuntimePort();
  if (!address || !port) {
    return fallback;
  }

  return `http://${address}:${port}`;
};

const navigateToUrl = (rawUrl: string): void => {
  const target = rawUrl.trim();
  if (!target) {
    return;
  }
  try {
    window.location.assign(target);
  } catch {
    window.location.href = target;
  }
};

const normalizeForSave = (instance: DesktopSshInstance): DesktopSshInstance => {
  const trimmedCommand = instance.sshCommand.trim();
  const nickname = instance.nickname?.trim();
  const forwards = instance.portForwards.map((forward) => ({
    ...forward,
    localHost: forward.localHost?.trim() || '127.0.0.1',
    localPort: typeof forward.localPort === 'number' ? Math.max(1, Math.min(65535, Math.round(forward.localPort))) : undefined,
    remoteHost: forward.remoteHost?.trim(),
    remotePort:
      typeof forward.remotePort === 'number'
        ? Math.max(1, Math.min(65535, Math.round(forward.remotePort)))
        : undefined,
  }));

  return {
    ...instance,
    sshCommand: trimmedCommand,
    ...(nickname ? { nickname } : { nickname: undefined }),
    connectionTimeoutSec: Math.max(5, Math.min(240, Math.round(instance.connectionTimeoutSec || 60))),
    localForward: {
      ...instance.localForward,
      bindHost:
        instance.localForward.bindHost === 'localhost' ||
        instance.localForward.bindHost === '0.0.0.0'
          ? instance.localForward.bindHost
          : '127.0.0.1',
      preferredLocalPort:
        typeof instance.localForward.preferredLocalPort === 'number'
          ? Math.max(1, Math.min(65535, Math.round(instance.localForward.preferredLocalPort)))
          : undefined,
    },
    remoteOpenchamber: {
      ...instance.remoteOpenchamber,
      preferredPort:
        typeof instance.remoteOpenchamber.preferredPort === 'number'
          ? Math.max(1, Math.min(65535, Math.round(instance.remoteOpenchamber.preferredPort)))
          : undefined,
    },
    portForwards: forwards,
  };
};

export const RemoteInstancesPage: React.FC = () => {
  const { t } = useI18n();
  const { clientAuth } = useRuntimeAPIs();
  const showInstanceManagement = isDesktopShell();
  const instances = useDesktopSshStore((state) => state.instances);
  const statusesById = useDesktopSshStore((state) => state.statusesById);
  const importCandidates = useDesktopSshStore((state) => state.importCandidates);
  const isLoading = useDesktopSshStore((state) => state.isLoading);
  const isImportsLoading = useDesktopSshStore((state) => state.isImportsLoading);
  const isSaving = useDesktopSshStore((state) => state.isSaving);
  const error = useDesktopSshStore((state) => state.error);
  const load = useDesktopSshStore((state) => state.load);
  const loadImports = useDesktopSshStore((state) => state.loadImports);
  const refreshStatuses = useDesktopSshStore((state) => state.refreshStatuses);
  const upsertInstance = useDesktopSshStore((state) => state.upsertInstance);
  const createFromCommand = useDesktopSshStore((state) => state.createFromCommand);
  const removeInstance = useDesktopSshStore((state) => state.removeInstance);
  const connect = useDesktopSshStore((state) => state.connect);
  const disconnect = useDesktopSshStore((state) => state.disconnect);
  const retry = useDesktopSshStore((state) => state.retry);

  const selectedId = useUIStore((state) => state.settingsRemoteInstancesSelectedId);
  const setSelectedId = useUIStore((state) => state.setSettingsRemoteInstancesSelectedId);

  const selectedInstance = React.useMemo(() => {
    if (!selectedId) return null;
    return instances.find((instance) => instance.id === selectedId) || null;
  }, [instances, selectedId]);

  const [draft, setDraft] = React.useState<DesktopSshInstance | null>(null);
  const [logDialogOpen, setLogDialogOpen] = React.useState(false);
  const [logDialogLoading, setLogDialogLoading] = React.useState(false);
  const [logDialogError, setLogDialogError] = React.useState<string | null>(null);
  const [logDialogLines, setLogDialogLines] = React.useState<string[]>([]);
  const [patternHost, setPatternHost] = React.useState<string | null>(null);
  const [patternDestination, setPatternDestination] = React.useState('');
  const [patternCreating, setPatternCreating] = React.useState(false);
  const [expandedForwards, setExpandedForwards] = React.useState<Record<string, boolean>>({});
  const [isPrimaryActionPending, setIsPrimaryActionPending] = React.useState(false);
  const [isRetryPending, setIsRetryPending] = React.useState(false);
  const [clockMs, setClockMs] = React.useState(() => Date.now());
  const [directHosts, setDirectHosts] = React.useState<DesktopHost[]>([]);
  // Live reachability per saved host (undefined = probe in flight), mirroring
  // the host switcher's status line so this list is not just dead text.
  const [directHostStatus, setDirectHostStatus] = React.useState<Record<string, HostProbeResult>>({});
  const [directDefaultHostId, setDirectDefaultHostId] = React.useState<string | null>('local');
  const [directLoading, setDirectLoading] = React.useState(false);
  const [directSaving, setDirectSaving] = React.useState(false);
  const [directLabel, setDirectLabel] = React.useState('');
  const [directUrl, setDirectUrl] = React.useState('');
  const [directToken, setDirectToken] = React.useState('');
  const [directHeaders, setDirectHeaders] = React.useState<HeaderDraft[]>([]);
  const [directConnectLink, setDirectConnectLink] = React.useState('');
  const [directError, setDirectError] = React.useState<string | null>(null);
  const [directAddDialogOpen, setDirectAddDialogOpen] = React.useState(false);
  const [directImportDialogOpen, setDirectImportDialogOpen] = React.useState(false);
  const [directEditingId, setDirectEditingId] = React.useState<string | null>(null);
  const [directEditLabel, setDirectEditLabel] = React.useState('');
  const [directEditUrl, setDirectEditUrl] = React.useState('');
  const [directEditToken, setDirectEditToken] = React.useState('');
  const [directEditHeaders, setDirectEditHeaders] = React.useState<HeaderDraft[]>([]);
  const [remoteClients, setRemoteClients] = React.useState<RemoteClientRecord[]>([]);
  const [pendingPairings, setPendingPairings] = React.useState<PendingPairingRecord[]>([]);
  const [remoteClientsLoading, setRemoteClientsLoading] = React.useState(false);
  const [remoteClientLabel, setRemoteClientLabel] = React.useState('');
  const [remoteClientError, setRemoteClientError] = React.useState<string | null>(null);
  const [pairingUrl, setPairingUrl] = React.useState<string | null>(null);
  // The pairing session shown in the QR dialog; used to auto-close the dialog
  // once the device redeems it (the pairing leaves the pending list).
  const [createdPairingId, setCreatedPairingId] = React.useState<string | null>(null);
  const [pairingQrDataUrl, setPairingQrDataUrl] = React.useState<string | null>(null);
  const [pairingCopied, setPairingCopied] = React.useState(false);
  // "Add a device" dialog: a configure phase (name + transport + fallback) then a
  // result phase (QR + link). The QR only ever shows inside this dialog.
  const [addDeviceOpen, setAddDeviceOpen] = React.useState(false);
  const [addDevicePhase, setAddDevicePhase] = React.useState<'configure' | 'result'>('configure');
  const [addDeviceCreating, setAddDeviceCreating] = React.useState(false);
  const [addDeviceTransport, setAddDeviceTransport] = React.useState<'local' | 'lan' | 'relay' | 'managed-e2ee'>('relay');

  const [addDeviceFallback, setAddDeviceFallback] = React.useState(true);
  const [transportOptions, setTransportOptions] = React.useState<{ localUrl: string | null; lanUrl: string | null; relayAvailable: boolean; directE2eeAvailable?: boolean } | null>(null);


  const revokedClientCount = React.useMemo(() => remoteClients.filter((client) => Boolean(client.revokedAt)).length, [remoteClients]);
  const [sshAddDialogOpen, setSshAddDialogOpen] = React.useState(false);
  const [sshCommandDraft, setSshCommandDraft] = React.useState('ssh user@example.com');
  const [sshNameDraft, setSshNameDraft] = React.useState('');

  React.useEffect(() => {
    void load();
    void loadImports();
  }, [load, loadImports]);

  const loadDirectHosts = React.useCallback(async () => {
    setDirectLoading(true);
    setDirectError(null);
    try {
      const config = await desktopHostsGet();
      setDirectHosts(config.hosts || []);
      setDirectDefaultHostId(config.defaultHostId || 'local');
    } catch (err) {
      setDirectError(err instanceof Error ? err.message : String(err));
    } finally {
      setDirectLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void loadDirectHosts();
  }, [loadDirectHosts]);

  const persistDirectHosts = React.useCallback(async (hosts: DesktopHost[], defaultHostId: string | null = directDefaultHostId) => {
    setDirectSaving(true);
    setDirectError(null);
    try {
      await desktopHostsSet({ hosts, defaultHostId, initialHostChoiceCompleted: true });
      setDirectHosts(hosts);
      setDirectDefaultHostId(defaultHostId);
    } catch (err) {
      setDirectError(err instanceof Error ? err.message : String(err));
    } finally {
      setDirectSaving(false);
    }
  }, [directDefaultHostId]);

  const handleAddDirectHost = React.useCallback(async () => {
    const resolved = resolveDesktopHostUrl(directUrl);
    if (!resolved) {
      setDirectError(t('desktopHostSwitcher.error.invalidUrl'));
      return;
    }
    const url = resolved.persistedUrl;
    const id = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `host-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const host: DesktopHost = {
      id,
      label: directLabel.trim() || redactSensitiveUrl(url),
      url,
      apiUrl: url,
      ...(directToken.trim() ? { clientToken: directToken.trim() } : {}),
      ...(buildRequestHeaders(directHeaders) ? { requestHeaders: buildRequestHeaders(directHeaders) } : {}),
    };
    await persistDirectHosts([host, ...directHosts], directDefaultHostId);
    setDirectLabel('');
    setDirectUrl('');
    setDirectToken('');
    setDirectHeaders([]);
    setDirectAddDialogOpen(false);
    if (resolved.redeemUrl) {
      navigateToUrl(resolved.redeemUrl);
    }
  }, [directDefaultHostId, directHeaders, directHosts, directLabel, directToken, directUrl, persistDirectHosts, t]);

  const importDirectConnectLink = React.useCallback(async () => {
    const payload = parsePairingConnectionPayload(directConnectLink);
    if (!payload) {
      setDirectError(t('settings.remoteInstances.direct.error.invalidConnectLink'));
      return;
    }
    // The redeem body is identical across every transport (the desktop is the
    // same device however it reaches the server). The install-id dedupe key
    // collapses re-pairing / re-auth of this desktop into one device record.
    const installId = await desktopInstallIdGet().catch(() => '');
    const redeemBody = {
      clientLabel: payload.label || 'OpenChamber Desktop',
      clientKind: 'desktop',
      deviceName: 'OpenChamber Desktop',
      devicePlatform: desktopPlatformName(),
      ...(installId ? { dedupeKey: `desktop:${installId}` } : {}),
    };
    const redemption = await redeemRemoteInstancePairing(payload, { redeemBody });
    if (!redemption.ok) {
      setDirectError(t(redemption.errorKey));
      return;
    }
    const redeemed = redemption;

    const makeId = (): string => (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `host-${Date.now()}-${Math.random().toString(16).slice(2)}`);

    const { token } = redeemed;
    const transportFields = buildPairedDesktopHostTransportFields(payload.candidates, redeemed.transport, token);
    if (!transportFields) {
      setDirectError(t('desktopHostSwitcher.error.invalidUrl'));
      return;
    }
    const { directE2ee, relay, url } = transportFields;
    // One host per server: match by relay serverId when the link has a relay
    // leg, else by direct URL — re-importing updates the record in place.
    const existing = directHosts.find((host) => (
      directE2ee
        ? Boolean(host.directE2ee && directE2eeHostFingerprint(host.directE2ee) === directE2eeHostFingerprint(directE2ee))
        : relay ? host.relay?.serverId === relay.serverId : (!host.relay && normalizeHostUrl(host.apiUrl || host.url) === url)
    ));
    if (existing) {
      const nextHosts = directHosts.map((host) => host.id === existing.id
        ? { ...replacePairedDesktopHostTransportFields(host, transportFields), label: payload.label || host.label }
        : host);
      await persistDirectHosts(nextHosts, directDefaultHostId);
    } else {
      // payload.label is normally the issuing server's hostname.
      await persistDirectHosts([{ id: makeId(), label: payload.label || redactSensitiveUrl(url), ...transportFields }, ...directHosts], directDefaultHostId);
    }
    setDirectConnectLink('');
    setDirectError(null);
    setDirectImportDialogOpen(false);
  }, [directConnectLink, directDefaultHostId, directHosts, persistDirectHosts, t]);

  const handleRemoveDirectHost = React.useCallback(async (id: string) => {
    const nextHosts = directHosts.filter((host) => host.id !== id);
    const nextDefault = directDefaultHostId === id ? 'local' : directDefaultHostId;
    await persistDirectHosts(nextHosts, nextDefault);
    if (directEditingId === id) {
      setDirectEditingId(null);
    }
  }, [directDefaultHostId, directEditingId, directHosts, persistDirectHosts]);

  const beginEditDirectHost = React.useCallback((host: DesktopHost) => {
    setDirectEditingId(host.id);
    setDirectEditLabel(host.label);
    setDirectEditUrl(host.apiUrl || host.url);
    setDirectEditToken(host.clientToken || '');
    setDirectEditHeaders(readRequestHeaderDrafts(host.requestHeaders));
    setDirectError(null);
  }, []);

  const saveDirectHostEdit = React.useCallback(async () => {
    if (!directEditingId) return;
    const resolved = resolveDesktopHostUrl(directEditUrl);
    if (!resolved) {
      setDirectError(t('desktopHostSwitcher.error.invalidUrl'));
      return;
    }
    const url = resolved.persistedUrl;
    const nextHosts = directHosts.map((host) => host.id === directEditingId
      ? {
        ...host,
        label: directEditLabel.trim() || redactSensitiveUrl(url),
        url,
        apiUrl: url,
        clientToken: directEditToken.trim() || undefined,
        requestHeaders: buildRequestHeaders(directEditHeaders),
      }
      : host);
    await persistDirectHosts(nextHosts, directDefaultHostId);
    setDirectEditingId(null);
    if (resolved.redeemUrl) {
      navigateToUrl(resolved.redeemUrl);
    }
  }, [directDefaultHostId, directEditHeaders, directEditLabel, directEditToken, directEditUrl, directEditingId, directHosts, persistDirectHosts, t]);

  const createSshInstanceFromDialog = React.useCallback(async () => {
    const command = sshCommandDraft.trim();
    if (!command) {
      toast.error(t('settings.remoteInstances.page.toast.sshCommandRequired'));
      return;
    }
    const id = `ssh-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    try {
      await createFromCommand(id, command, sshNameDraft.trim() || t('settings.remoteInstances.sidebar.newSshInstanceName'));
      setSelectedId(id);
      setSshAddDialogOpen(false);
      setSshCommandDraft('ssh user@example.com');
      setSshNameDraft('');
      toast.success(t('settings.remoteInstances.page.toast.instanceCreated'));
    } catch (error) {
      toast.error(t('settings.remoteInstances.sidebar.toast.createFailed'), {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  }, [createFromCommand, setSelectedId, sshCommandDraft, sshNameDraft, t]);

  const setDefaultDirectHost = React.useCallback(async (id: string) => {
    await persistDirectHosts(directHosts, id);
  }, [directHosts, persistDirectHosts]);

  // Probe saved hosts whenever the list changes so each row shows a live
  // Connected/Unreachable status like the host switcher does. One pass per
  // list identity — no polling; the row set changes rarely.
  React.useEffect(() => {
    if (!showInstanceManagement || directHosts.length === 0) return;
    let cancelled = false;
    void Promise.all(directHosts.map(async (host) => {
      const selection = await probeDesktopHostTransports(host);
      return [host.id, selection.probe] as const;
    })).then((entries) => {
      if (cancelled) return;
      setDirectHostStatus(Object.fromEntries(entries));
    });
    return () => {
      cancelled = true;
    };
  }, [directHosts, showInstanceManagement]);

  const loadRemoteClients = React.useCallback(async (options?: { silent?: boolean }) => {
    if (!clientAuth) return;
    if (!options?.silent) setRemoteClientsLoading(true);
    if (!options?.silent) setRemoteClientError(null);
    try {
      // Pending fetch failure returns null (NOT []) so a transient blip neither
      // blanks the pending list nor fakes a "pairing redeemed" signal for the
      // QR dialog's auto-close below.
      const [clients, pending] = await Promise.all([
        clientAuth.listClients(),
        clientAuth.listPendingPairings().catch(() => null),
      ]);
      setRemoteClients(clients);
      if (pending) setPendingPairings(pending);
    } catch (err) {
      // A silent poll must not surface a transient error over the live list.
      if (!options?.silent) setRemoteClientError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!options?.silent) setRemoteClientsLoading(false);
    }
  }, [clientAuth]);

  // Auto-close the QR/link dialog once the device connects: the pairing session
  // is single-use, so it leaving the pending list means it was redeemed (or
  // expired/cancelled — the dialog is stale either way). Armed only after the
  // pairing has been SEEN in the pending list — the result phase renders before
  // the refreshed list arrives, and closing on that stale "absent" would blink
  // the dialog shut immediately. Successful-fetch-only updates keep transient
  // poll failures from faking the disappearance.
  const pairingSeenPendingRef = React.useRef(false);
  React.useEffect(() => {
    if (!addDeviceOpen || addDevicePhase !== 'result' || !createdPairingId) return;
    if (pendingPairings.some((pending) => pending.id === createdPairingId)) {
      pairingSeenPendingRef.current = true;
      return;
    }
    if (!pairingSeenPendingRef.current) return;
    setCreatedPairingId(null);
    setAddDeviceOpen(false);
    // Celebrate only an actual redeem (a client minted from this pairing exists);
    // an expired or cancelled session closes the stale dialog silently.
    if (remoteClients.some((client) => client.pairingId === createdPairingId)) {
      toast.success(t('settings.remoteInstances.clientAuth.addDevice.connectedToast'));
    }
  }, [addDeviceOpen, addDevicePhase, createdPairingId, pendingPairings, remoteClients, t]);

  const cancelPendingPairing = React.useCallback(async (id: string) => {
    if (!clientAuth) return;
    try {
      await clientAuth.cancelPairing(id);
      setPendingPairings((prev) => prev.filter((entry) => entry.id !== id));
      await loadRemoteClients({ silent: true });
    } catch (err) {
      setRemoteClientError(err instanceof Error ? err.message : String(err));
    }
  }, [clientAuth, loadRemoteClients]);

  // Load on mount, then poll while the page is visible so a device that redeems
  // a pairing link shows up in the list without reopening settings.
  React.useEffect(() => {
    if (!clientAuth) return;
    void loadRemoteClients();
    const interval = window.setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      void loadRemoteClients({ silent: true });
    }, 5_000);
    return () => window.clearInterval(interval);
  }, [clientAuth, loadRemoteClients]);

  // Available direct transports for the create dialog. The server is authoritative
  // for LAN reachability (derived from its bind, not the UI origin), so "Local
  // network" works even when the UI is opened on localhost. Falls back to the
  // client-side guess if the endpoint is unavailable.
  const resolveTransportOptions = React.useCallback(async (): Promise<{ localUrl: string | null; lanUrl: string | null; relayAvailable: boolean; directE2eeAvailable: boolean }> => {
    if (clientAuth?.getPairingTransports) {
      try {
        const transports = await clientAuth.getPairingTransports();
        return { localUrl: transports.local, lanUrl: transports.lan, relayAvailable: transports.relayAvailable, directE2eeAvailable: !!transports.directE2eeAvailable };
      } catch {
        // fall through to the client-side guess
      }
    }
    const port = getRuntimePort();
    const localUrl = port ? `http://127.0.0.1:${port}` : (isLoopbackUrl(window.location.origin) ? window.location.origin : null);
    let lanUrl: string | null = null;
    try {
      const resolved = normalizeHostUrl(await resolvePairingServerUrl());
      lanUrl = resolved && !isLoopbackUrl(resolved) ? resolved : null;
    } catch {
      // keep null
    }
    return { localUrl, lanUrl, relayAvailable: true, directE2eeAvailable: false };
  }, [clientAuth]);

  const openAddDevice = React.useCallback(async (preferredTransport?: 'managed-e2ee') => {
    setRemoteClientError(null);
    setPairingUrl(null);
    setPairingQrDataUrl(null);
    setPairingCopied(false);
    setCreatedPairingId(null);
    setAddDevicePhase('configure');
    setAddDeviceFallback(true);
    setAddDeviceOpen(true);
    const opts = await resolveTransportOptions();
    setTransportOptions(opts);
    // "Anywhere" (relay, with home-network preference) is the right default for
    // most people; fall back to narrower options only when relay is unavailable.
    const selected = selectPairingTransport(preferredTransport, opts);
    setAddDeviceTransport(selected);
    if (preferredTransport === 'managed-e2ee' && selected !== 'managed-e2ee') {
      toast.error(t('settings.openchamber.tunnel.field.directE2eeUnsupported'));
    }
  }, [resolveTransportOptions, t]);

  React.useEffect(() => {
    const intent = consumeAddDeviceIntent();
    if (intent === 'managed-e2ee') {
      void openAddDevice('managed-e2ee');
    }
  }, [openAddDevice]);

  const createPairingLink = React.useCallback(async () => {
    if (!clientAuth?.createPairingSession || !transportOptions) return;
    setRemoteClientError(null);
    setAddDeviceCreating(true);
    try {
      const label = remoteClientLabel.trim() || undefined;
      // Map the chosen transport (+ fallback) to the per-link candidate request.
      const { serverUrl, includeRelay, includeDirect, includeDirectE2ee } = resolvePairingTransportRequest(addDeviceTransport, {
        localUrl: transportOptions.localUrl,
        lanUrl: transportOptions.lanUrl,
        addDeviceFallback,
        relayAvailable: transportOptions.relayAvailable
      });
      const { pairing, server } = await clientAuth.createPairingSession({
        label,
        allowedClientKinds: ['mobile', 'desktop'],
        serverUrl,
        includeRelay,
        includeDirect,
        includeDirectE2ee,
      });
      const payload = buildPairingConnectionPayload({
        pairingId: pairing.id,
        secret: pairing.secret,
        // The typed name (`label`) is the per-device label shown in THIS server's
        // device list; it already went to createPairingSession above. The payload
        // label is what the paired device names its connection by, which must be
        // the issuing server's name (hostname), not the device's own name.
        label: server.label,
        fingerprint: pairing.fingerprint ?? undefined,
        expiresAt: pairing.expiresAt,
        candidates: server.candidates.map(normalizePairingCandidate).filter((c): c is PairingEndpointCandidate => c !== null),
      });
      const encoded = encodePairingConnectionPayload(payload);
      setPairingUrl(encoded);
      // Pairing payloads are dense (multiple transport candidates + the relay
      // E2EE key), so render at high resolution with low error-correction.
      setPairingQrDataUrl(await QRCode.toDataURL(encoded, { width: 1024, margin: 2, errorCorrectionLevel: 'L' }));
      setPairingCopied(false);
      pairingSeenPendingRef.current = false;
      setCreatedPairingId(pairing.id);
      setAddDevicePhase('result');
      // Loads the pending list including this pairing BEFORE the result phase
      // polls it, so the auto-close effect sees "present -> gone" transitions.
      await loadRemoteClients({ silent: true });
    } catch (err) {
      setRemoteClientError(err instanceof Error ? err.message : String(err));
    } finally {
      setAddDeviceCreating(false);
    }
  }, [clientAuth, transportOptions, addDeviceTransport, addDeviceFallback, remoteClientLabel, loadRemoteClients]);

  const handleCopyPairing = React.useCallback(() => {
    if (!pairingUrl) return;
    void copyTextToClipboard(pairingUrl).then((result) => {
      if (!result.ok) return;
      setPairingCopied(true);
      window.setTimeout(() => setPairingCopied(false), 2000);
    });
  }, [pairingUrl]);

  const revokeRemoteClient = React.useCallback(async (client: RemoteClientRecord) => {
    if (!clientAuth) return;
    const isLocalDesktopClient = client.clientKind === 'desktop-local';
    setRemoteClientError(null);
    try {
      await clientAuth.revokeClient(client.id);
      if (isLocalDesktopClient && isDesktopShell()) {
        const config = await desktopHostsGet();
        await desktopHostsSet({
          hosts: config.hosts,
          defaultHostId: config.defaultHostId,
          initialHostChoiceCompleted: config.initialHostChoiceCompleted,
          localClientToken: null,
        });
        setRemoteClients((clients) => clients.map((entry) => entry.id === client.id
          ? { ...entry, revokedAt: new Date().toISOString() }
          : entry));
        switchRuntimeEndpoint({ apiBaseUrl: getRuntimeApiBaseUrl(), clientToken: null, runtimeKey: 'local' });
        return;
      }
      await loadRemoteClients();
    } catch (err) {
      setRemoteClientError(err instanceof Error ? err.message : String(err));
    }
  }, [clientAuth, loadRemoteClients]);

  const purgeRevokedRemoteClients = React.useCallback(async () => {
    if (!clientAuth) return;
    setRemoteClientError(null);
    try {
      await clientAuth.purgeRevokedClients();
      await loadRemoteClients();
    } catch (err) {
      setRemoteClientError(err instanceof Error ? err.message : String(err));
    }
  }, [clientAuth, loadRemoteClients]);

  React.useEffect(() => {
    setDraft(selectedInstance);
  }, [selectedInstance]);

  React.useEffect(() => {
    if (!selectedId) {
      return;
    }
    const interval = window.setInterval(() => {
      // Skip polling when tab is hidden to reduce background work
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
        return;
      }
      void refreshStatuses();
    }, 2_000);
    return () => {
      window.clearInterval(interval);
    };
  }, [refreshStatuses, selectedId]);

  React.useEffect(() => {
    // Use requestAnimationFrame for smoother clock updates without setInterval overhead
    let rafId: number | null = null;
    let lastTime = Date.now();

    const tick = () => {
      const now = Date.now();
      // Update only once per second
      if (now - lastTime >= 1_000) {
        setClockMs(now);
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

  const status = selectedId ? statusesById[selectedId] : null;
  const statusPhase = status?.phase;
  const isReady = statusPhase === 'ready';
  const isReconnecting = statusPhase === 'degraded';
  const isConnecting = isConnectingPhase(statusPhase);
  const isBusy = isConnecting || isReconnecting;
  const canDisconnect = isReady || isBusy;
  const statusAgeMs = status ? Math.max(0, clockMs - status.updatedAtMs) : 0;
  const reconnectAppearsStuck = isReconnecting && statusAgeMs > 12_000;

  const hasChanges = React.useMemo(() => {
    if (!draft || !selectedInstance) return false;
    return JSON.stringify(draft) !== JSON.stringify(selectedInstance);
  }, [draft, selectedInstance]);

  const updateDraft = React.useCallback((updater: (current: DesktopSshInstance) => DesktopSshInstance) => {
    setDraft((current) => (current ? updater(current) : current));
  }, []);

  const handleSave = React.useCallback(async () => {
    if (!draft) return;
    const normalized = normalizeForSave(draft);

    if (!normalized.sshCommand.trim()) {
      toast.error(t('settings.remoteInstances.page.toast.sshCommandRequired'));
      return;
    }

    if (normalized.localForward.bindHost === '0.0.0.0') {
      const allow = window.confirm(
        t('settings.remoteInstances.page.confirm.bindAllInterfaces'),
      );
      if (!allow) {
        return;
      }
    }

    if (
      normalized.auth.sshPassword?.enabled &&
      normalized.auth.sshPassword.value?.trim() &&
      normalized.auth.sshPassword.store !== 'settings'
    ) {
      const store = window.confirm(t('settings.remoteInstances.page.confirm.storeSshPasswordPlaintext'));
      normalized.auth.sshPassword.store = store ? 'settings' : 'never';
      if (!store) {
        normalized.auth.sshPassword.value = undefined;
      }
    }

    if (
      normalized.auth.openchamberPassword?.enabled &&
      normalized.auth.openchamberPassword.value?.trim() &&
      normalized.auth.openchamberPassword.store !== 'settings'
    ) {
      const store = window.confirm(t('settings.remoteInstances.page.confirm.storeUiPasswordPlaintext'));
      normalized.auth.openchamberPassword.store = store ? 'settings' : 'never';
      if (!store) {
        normalized.auth.openchamberPassword.value = undefined;
      }
    }

    try {
      await upsertInstance(normalized);
      toast.success(t('settings.remoteInstances.page.toast.instanceSaved'));
    } catch (error) {
      toast.error(t('settings.remoteInstances.page.toast.saveFailed'), {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  }, [draft, t, upsertInstance]);

  const createImportedInstance = React.useCallback(
    async (host: string, destination: string): Promise<boolean> => {
      const id = `ssh-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      try {
        await createFromCommand(id, `ssh ${destination}`, host);
        setSelectedId(id);
        toast.success(t('settings.remoteInstances.page.toast.instanceCreated'));
        return true;
      } catch (error) {
        toast.error(t('settings.remoteInstances.sidebar.toast.createFailed'), {
          description: error instanceof Error ? error.message : String(error),
        });
        return false;
      }
    },
    [createFromCommand, setSelectedId, t],
  );

  const closePatternDialog = React.useCallback(() => {
    if (patternCreating) {
      return;
    }
    setPatternHost(null);
    setPatternDestination('');
  }, [patternCreating]);

  const handleImportCandidate = React.useCallback(
    (host: string, pattern: boolean) => {
      if (pattern) {
        setPatternHost(host);
        setPatternDestination(suggestConcreteHost(host));
        return;
      }
      void createImportedInstance(host, host);
    },
    [createImportedInstance],
  );

  const handlePatternCreate = React.useCallback(async () => {
    const host = patternHost;
    const destination = patternDestination.trim();
    if (!host) {
      return;
    }
    if (!destination) {
      toast.error(t('settings.remoteInstances.page.toast.destinationRequired'));
      return;
    }

    setPatternCreating(true);
    try {
      const created = await createImportedInstance(host, destination);
      if (created) {
        setPatternHost(null);
        setPatternDestination('');
      }
    } finally {
      setPatternCreating(false);
    }
  }, [createImportedInstance, patternDestination, patternHost, t]);

  const connectWithPortRecovery = React.useCallback(async () => {
    if (!selectedInstance) return;
    try {
      await connect(selectedInstance.id);
      return;
    } catch (error) {
      if (!isPortInUseError(error)) {
        throw error;
      }

      const allow = window.confirm(t('settings.remoteInstances.sidebar.confirm.localPortInUseRetry'));
      if (!allow) {
        throw error;
      }

      const nextInstance: DesktopSshInstance = {
        ...selectedInstance,
        localForward: {
          ...selectedInstance.localForward,
          preferredLocalPort: randomPort(),
        },
      };

      await upsertInstance(nextInstance);
      await connect(nextInstance.id);
      toast.success(t('settings.remoteInstances.sidebar.toast.retriedWithRandomPort'));
    }
  }, [connect, selectedInstance, t, upsertInstance]);

  const readLogsForInstance = React.useCallback(async (id: string) => {
    const lines = await desktopSshLogs(id, 600);
    return lines.map((line) => formatLogLine(line));
  }, []);

  const handleOpenLogs = React.useCallback(async () => {
    if (!draft) return;
    setLogDialogOpen(true);
    setLogDialogLoading(true);
    setLogDialogError(null);
    try {
      const lines = await readLogsForInstance(draft.id);
      setLogDialogLines(lines);
    } catch (error) {
      setLogDialogLines([]);
      setLogDialogError(error instanceof Error ? error.message : String(error));
    } finally {
      setLogDialogLoading(false);
    }
  }, [draft, readLogsForInstance]);

  React.useEffect(() => {
    if (!logDialogOpen || !draft) {
      return;
    }

    let disposed = false;
    const run = async () => {
      try {
        const lines = await readLogsForInstance(draft.id);
        if (!disposed) {
          setLogDialogLines(lines);
          setLogDialogError(null);
        }
      } catch (error) {
        if (!disposed) {
          setLogDialogError(error instanceof Error ? error.message : String(error));
        }
      }
    };

    void run();
    const interval = window.setInterval(() => {
      // Skip polling when tab is hidden
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
        return;
      }
      void run();
    }, 1_000);

    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, [draft, logDialogOpen, readLogsForInstance]);

  const logLinesText = React.useMemo(() => logDialogLines.join('\n'), [logDialogLines]);

  const handleCopyAllLogs = React.useCallback(() => {
    if (!logLinesText.trim()) {
      toast.error(t('settings.remoteInstances.page.toast.noLogsToCopy'));
      return;
    }
    void copyTextToClipboard(logLinesText).then((result) => {
      if (result.ok) {
        toast.success(t('settings.remoteInstances.page.toast.logsCopied'));
      }
    });
  }, [logLinesText, t]);

  const handleClearLogs = React.useCallback(async () => {
    if (!draft) {
      return;
    }
    try {
      await desktopSshLogsClear(draft.id);
      setLogDialogLines([]);
      toast.success(t('settings.remoteInstances.page.toast.logsCleared'));
    } catch (error) {
      toast.error(t('settings.remoteInstances.page.toast.clearLogsFailed'), {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  }, [draft, t]);

  const handleOpenCurrentInstance = React.useCallback(async () => {
    if (!status?.localUrl) {
      toast.error(t('settings.remoteInstances.page.toast.instanceUrlUnavailable'));
      return;
    }

    const target = status.localUrl.trim();
    if (!target) {
      toast.error(t('settings.remoteInstances.page.toast.instanceUrlUnavailable'));
      return;
    }

    navigateToUrl(target);
  }, [status?.localUrl, t]);

  const handlePrimaryConnectionAction = React.useCallback(() => {
    if (!draft) {
      return;
    }

    setIsPrimaryActionPending(true);
    const operation = canDisconnect ? disconnect(draft.id) : connectWithPortRecovery();
    void operation
      .catch((error) => {
        const key = canDisconnect
          ? (isReady
            ? 'settings.remoteInstances.page.toast.disconnectFailed'
            : 'settings.remoteInstances.page.toast.cancelConnectionFailed')
          : 'settings.remoteInstances.page.toast.connectFailed';
        toast.error(t(key), {
          description: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        setIsPrimaryActionPending(false);
      });
  }, [canDisconnect, connectWithPortRecovery, disconnect, draft, isReady, t]);

  const handleRetryAction = React.useCallback(() => {
    if (!draft) {
      return;
    }

    if (isConnecting) {
      return;
    }

    setIsRetryPending(true);
    const operation = isReconnecting
      ? disconnect(draft.id).then(() => connectWithPortRecovery())
      : retry(draft.id);

    void operation
      .catch((error) => {
        toast.error(t('settings.remoteInstances.page.toast.retryFailed'), {
          description: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        setIsRetryPending(false);
      });
  }, [connectWithPortRecovery, disconnect, draft, isConnecting, isReconnecting, retry, t]);

  const retryButtonLabel = isConnecting
    ? t('settings.remoteInstances.page.actions.connecting')
    : isReconnecting
      ? reconnectAppearsStuck
        ? t('settings.remoteInstances.page.actions.reconnectNow')
        : t('settings.remoteInstances.page.actions.reconnecting')
      : t('settings.remoteInstances.sidebar.actions.retry');

  const canRetry =
    !isPrimaryActionPending &&
    !isRetryPending &&
    (statusPhase === 'error' || statusPhase === 'idle' || !statusPhase || (isReconnecting && reconnectAppearsStuck)) &&
    !isConnecting;

  const primaryButtonLabel = isReady
    ? t('settings.remoteInstances.sidebar.actions.disconnect')
    : canDisconnect
      ? t('settings.remoteInstances.page.actions.cancel')
      : t('settings.remoteInstances.sidebar.actions.connect');

  if (!draft) {
    return (
      <SettingsPageLayout>
        {clientAuth ? (
          <div data-settings-item="remote-instances.client-auth" className="mb-8">
            <div className="mb-1 px-1 space-y-0.5">
              <h3 className="typography-ui-header font-medium text-foreground">{t('settings.remoteInstances.clientAuth.title')}</h3>
              <p className="typography-meta text-muted-foreground">{t('settings.remoteInstances.clientAuth.description')}</p>
            </div>
            <section className="px-2 pb-2 pt-0 space-y-3">
              <div>
                <Button type="button" size="xs" className="!font-normal" onClick={() => void openAddDevice()}>
                  <Icon name="add" className="h-3.5 w-3.5" />
                  {t('settings.remoteInstances.clientAuth.actions.addDevice')}
                </Button>
              </div>
              <div className="space-y-1">
                {revokedClientCount > 0 ? (
                  <div className="flex justify-end">
                    <Button type="button" variant="ghost" size="xs" className="!font-normal" onClick={() => void purgeRevokedRemoteClients()}>
                      {t('settings.remoteInstances.clientAuth.actions.clearRevoked')}
                    </Button>
                  </div>
                ) : null}
                {remoteClientsLoading && remoteClients.length === 0 && pendingPairings.length === 0 ? (
                  <p className="typography-meta text-muted-foreground">{t('settings.remoteInstances.clientAuth.state.loading')}</p>
                ) : remoteClients.length === 0 && pendingPairings.length === 0 ? (
                  <p className="typography-meta text-muted-foreground">{t('settings.remoteInstances.clientAuth.state.empty')}</p>
                ) : (
                  <>
                    {pendingPairings.map((pending) => (
                      <div key={`pending-${pending.id}`} className="flex items-center justify-between gap-3 py-1.5">
                        <div className="min-w-0">
                          <div className="flex min-w-0 items-center gap-2">
                            <span className="h-2 w-2 shrink-0 rounded-full bg-[var(--status-warning)] animate-pulse" />
                            <p className="typography-ui-label text-foreground truncate">{pending.label || t('settings.remoteInstances.clientAuth.field.labelPlaceholder')}</p>
                            {pending.usesRelay ? (
                              <span className="typography-micro text-muted-foreground bg-muted px-1 rounded shrink-0 leading-none pb-px border border-border/50">{t('settings.remoteInstances.clientAuth.state.viaRelay')}</span>
                            ) : null}
                          </div>
                          <p className="typography-micro text-muted-foreground truncate">{t('settings.remoteInstances.clientAuth.state.pending')}</p>
                        </div>
                        <Button type="button" variant="ghost" size="xs" className="!font-normal" onClick={() => void cancelPendingPairing(pending.id)}>
                          {t('settings.common.actions.cancel')}
                        </Button>
                      </div>
                    ))}
                    {remoteClients.map((client) => {
                      const isLocalDesktopClient = client.clientKind === 'desktop-local';
                      // Live presence: the server refreshes lastUsedAt on every
                      // authenticated request (writes throttled to 60s), so a
                      // device with activity in the last 90s is connected NOW.
                      // The list polls every 5s, keeping this fresh.
                      const lastUsedMs = client.lastUsedAt ? Date.parse(client.lastUsedAt) : Number.NaN;
                      const isOnline = !client.revokedAt
                        && (isLocalDesktopClient || (Number.isFinite(lastUsedMs) && Date.now() - lastUsedMs < 90_000));
                      const statusText = client.revokedAt
                        ? t('settings.remoteInstances.clientAuth.state.revoked')
                        : isOnline
                          ? (client.lastTransport === 'relay' && !isLocalDesktopClient
                            ? t('settings.remoteInstances.clientAuth.state.connectedRelay')
                            : t('settings.remoteInstances.clientAuth.state.connectedDirect'))
                          : client.lastUsedAt
                            ? t('settings.remoteInstances.clientAuth.lastUsed', { date: client.lastUsedAt })
                            : t('settings.remoteInstances.clientAuth.neverUsed');
                      return (
                        <div key={client.id} className="flex items-center justify-between gap-3 py-1.5">
                          <div className="min-w-0">
                            <div className="flex min-w-0 items-center gap-2">
                              <span className={cn(
                                'h-2 w-2 shrink-0 rounded-full',
                                client.revokedAt ? 'bg-muted-foreground/20' : isOnline ? 'bg-[var(--status-success)]' : 'bg-muted-foreground/30',
                              )} />
                              <p className="typography-ui-label text-foreground truncate">{client.label}</p>
                              {devicePlatformLabel(client.devicePlatform) ? (
                                <span className="typography-micro text-muted-foreground bg-muted px-1 rounded shrink-0 leading-none pb-px border border-border/50">
                                  {devicePlatformLabel(client.devicePlatform)}
                                </span>
                              ) : null}
                              {isLocalDesktopClient ? (
                                <span className="typography-micro text-muted-foreground bg-muted px-1 rounded flex-shrink-0 leading-none pb-px border border-border/50">
                                  {t('settings.remoteInstances.clientAuth.state.thisDevice')}
                                </span>
                              ) : null}
                            </div>
                            <p className={cn('typography-micro truncate', isOnline && !client.revokedAt ? 'text-[var(--status-success)]' : 'text-muted-foreground')}>{statusText}</p>
                          </div>
                          <Button type="button" variant="ghost" size="xs" className="!font-normal" onClick={() => void revokeRemoteClient(client)} disabled={Boolean(client.revokedAt)}>
                            {t('settings.remoteInstances.clientAuth.actions.revoke')}
                          </Button>
                        </div>
                      );
                    })}
                  </>
                )}
              </div>
              {remoteClientError ? <p className="typography-meta text-[var(--status-error)]">{remoteClientError}</p> : null}
            </section>
          </div>
        ) : null}

        {showInstanceManagement ? <div data-settings-item="remote-instances.direct-hosts" className="mb-8 border-t border-[var(--surface-subtle)] pt-8">
          <div className="mb-1 flex items-start justify-between gap-3 px-1">
            <div className="min-w-0 space-y-0.5">
              <h3 className="typography-ui-header font-medium text-foreground">{t('settings.remoteInstances.direct.title')}</h3>
              <p className="typography-meta text-muted-foreground">{t('settings.remoteInstances.direct.description')}</p>
            </div>
            {/* Importing a pairing link is the flagship path; add-by-address is
                the manual fallback. The token-storage note lives in the add
                dialog next to the token field it describes. */}
            <div className="flex shrink-0 items-center gap-2 pt-0.5">
              <Button type="button" size="xs" className="!font-normal" onClick={() => setDirectImportDialogOpen(true)} disabled={directSaving}>
                {t('settings.remoteInstances.direct.import.action')}
              </Button>
              <Button type="button" variant="outline" size="xs" className="!font-normal" onClick={() => setDirectAddDialogOpen(true)} disabled={directSaving}>
                <Icon name="add" className="h-3.5 w-3.5" />
                {t('settings.remoteInstances.direct.actions.add')}
              </Button>
            </div>
          </div>
          <section className="px-2 pb-2 pt-0 space-y-4">
            <div className="space-y-1">
              {directLoading ? (
                <p className="typography-meta text-muted-foreground">{t('settings.remoteInstances.direct.state.loading')}</p>
              ) : directHosts.length === 0 ? (
                <p className="typography-meta text-muted-foreground">{t('settings.remoteInstances.direct.state.empty')}</p>
              ) : directHosts.map((host) => {
                const probe = directHostStatus[host.id];
                const statusKey: I18nKey = !probe
                  ? 'desktopHostSwitcher.status.checking'
                  : probe.status === 'ok'
                    ? 'desktopHostSwitcher.status.connected'
                    : probe.status === 'auth'
                      ? 'desktopHostSwitcher.status.authRequired'
                      : probe.status === 'update-recommended'
                        ? 'desktopHostSwitcher.status.updateRecommended'
                        : probe.status === 'incompatible'
                          ? 'desktopHostSwitcher.status.incompatible'
                          : probe.status === 'wrong-service'
                            ? 'desktopHostSwitcher.status.wrongService'
                            : 'desktopHostSwitcher.status.unreachable';
                const isOnline = probe?.status === 'ok';
                return (
                <div key={host.id} className="py-1.5">
                  <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex min-w-0 items-center gap-2">
                          <span className={cn(
                            'h-2 w-2 shrink-0 rounded-full',
                            !probe ? 'bg-muted-foreground/30 animate-pulse' : isOnline ? 'bg-[var(--status-success)]' : 'bg-[var(--status-error)]',
                          )} />
                          <p className="typography-ui-label text-foreground truncate">{redactSensitiveUrl(host.label)}</p>
                          {directDefaultHostId === host.id ? <span className="typography-micro text-muted-foreground shrink-0">{t('desktopHostSwitcher.header.default')}</span> : null}
                          <span className={cn('typography-micro shrink-0', isOnline ? 'text-[var(--status-success)]' : 'text-muted-foreground')}>
                            {t(statusKey)}
                            {isOnline && typeof probe?.latencyMs === 'number'
                              ? t('desktopHostSwitcher.status.ping', { ms: Math.max(0, Math.round(probe.latencyMs)) })
                              : ''}
                          </span>
                        </div>
                        <p className={cn('typography-micro text-muted-foreground truncate', host.apiUrl && 'font-mono')}>
                          {host.relay && !host.apiUrl ? t('mobile.connect.relay.badge') : redactSensitiveUrl(host.apiUrl || host.url)}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <Button type="button" variant="ghost" size="xs" className="!font-normal" onClick={() => void setDefaultDirectHost(host.id)} disabled={directSaving || directDefaultHostId === host.id} aria-label={t('desktopHostSwitcher.actions.setAsDefaultAria')}>
                          {directDefaultHostId === host.id ? <Icon name="star-fill" className="h-3.5 w-3.5" /> : <Icon name="star" className="h-3.5 w-3.5" />}
                        </Button>
                        {/* The edit form is URL/token-centric; relay-ONLY hosts have
                            nothing it can edit and are re-imported via a fresh pairing
                            link instead. Multi-transport hosts keep their relay leg
                            through the edit (object spread preserves it). */}
                        {host.relay && !host.apiUrl ? null : (
                          <Button type="button" variant="ghost" size="xs" className="!font-normal" onClick={() => beginEditDirectHost(host)} disabled={directSaving}>
                            <Icon name="pencil" className="h-3.5 w-3.5" />
                            {t('desktopHostSwitcher.actions.edit')}
                          </Button>
                        )}
                        <Button type="button" variant="ghost" size="xs" className="!font-normal" onClick={() => void handleRemoveDirectHost(host.id)} disabled={directSaving}>
                          <Icon name="delete-bin" className="h-3.5 w-3.5" />
                          {t('settings.common.actions.delete')}
                        </Button>
                      </div>
                  </div>
                </div>
                );
              })}
            </div>

            {directError ? <p className="typography-meta text-[var(--status-error)]">{directError}</p> : null}
          </section>
        </div> : null}

        {showInstanceManagement ? <Dialog open={directAddDialogOpen} onOpenChange={setDirectAddDialogOpen}>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>{t('settings.remoteInstances.direct.actions.add')}</DialogTitle>
              <DialogDescription>{t('settings.remoteInstances.direct.addDialog.description')}</DialogDescription>
            </DialogHeader>
            <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void handleAddDirectHost(); }}>
              <Input className="h-8" value={directLabel} onChange={(event) => setDirectLabel(event.target.value)} placeholder={t('settings.remoteInstances.direct.field.labelPlaceholder')} disabled={directSaving} />
              <Input className="h-8" value={directUrl} onChange={(event) => setDirectUrl(event.target.value)} placeholder={t('settings.remoteInstances.direct.field.urlPlaceholder')} disabled={directSaving} autoFocus />
              <div className="space-y-1">
                <Input className="h-8" value={directToken} onChange={(event) => setDirectToken(event.target.value)} placeholder={t('settings.remoteInstances.direct.field.tokenPlaceholder')} type="password" disabled={directSaving} />
                <p className="px-1 typography-micro text-muted-foreground">{t('settings.remoteInstances.direct.note')}</p>
              </div>
              <div className="space-y-2">
                <div>
                  <p className="typography-ui-label text-foreground">{t('settings.remoteInstances.direct.headers.title')}</p>
                  <p className="typography-meta text-muted-foreground">{t('settings.remoteInstances.direct.headers.description')}</p>
                </div>
                {directHeaders.map((header) => (
                  <div key={header.id} className="flex w-full gap-2">
                    <Input className="h-8 font-mono text-xs" value={header.name} onChange={(event) => setDirectHeaders((headers) => headers.map((item) => item.id === header.id ? { ...item, name: event.target.value } : item))} placeholder={t('settings.remoteInstances.direct.headers.field.namePlaceholder')} disabled={directSaving} />
                    <Input className="h-8 font-mono text-xs" value={header.value} onChange={(event) => setDirectHeaders((headers) => headers.map((item) => item.id === header.id ? { ...item, value: event.target.value } : item))} placeholder={t('settings.remoteInstances.direct.headers.field.valuePlaceholder')} type="password" disabled={directSaving} />
                    <button type="button" onClick={() => setDirectHeaders((headers) => headers.filter((item) => item.id !== header.id))} className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-[var(--status-error-background)] hover:text-[var(--status-error)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]" aria-label={t('settings.remoteInstances.direct.headers.removeAria')} disabled={directSaving}>
                      <Icon name="close" className="h-4 w-4" />
                    </button>
                  </div>
                ))}
                <Button type="button" variant="ghost" size="xs" className="!font-normal" onClick={() => setDirectHeaders((headers) => [...headers, createHeaderDraft()])} disabled={directSaving}>
                  <Icon name="add" className="h-3.5 w-3.5" />
                  {t('settings.remoteInstances.direct.headers.actions.add')}
                </Button>
              </div>
              <div className="flex justify-end gap-2">
                <Button type="button" variant="outline" size="xs" className="!font-normal" onClick={() => setDirectAddDialogOpen(false)} disabled={directSaving}>{t('settings.common.actions.cancel')}</Button>
                <Button type="submit" size="xs" className="!font-normal" disabled={directSaving || !directUrl.trim()}>{t('settings.remoteInstances.direct.actions.add')}</Button>
              </div>
            </form>
          </DialogContent>
        </Dialog> : null}

        {showInstanceManagement ? <Dialog open={Boolean(directEditingId)} onOpenChange={(open) => { if (!open) setDirectEditingId(null); }}>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>{t('desktopHostSwitcher.actions.edit')}</DialogTitle>
              <DialogDescription>{t('settings.remoteInstances.direct.description')}</DialogDescription>
            </DialogHeader>
            <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void saveDirectHostEdit(); }}>
              <Input className="h-8" value={directEditLabel} onChange={(event) => setDirectEditLabel(event.target.value)} placeholder={t('settings.remoteInstances.direct.field.labelPlaceholder')} disabled={directSaving} />
              <Input className="h-8" value={directEditUrl} onChange={(event) => setDirectEditUrl(event.target.value)} placeholder={t('settings.remoteInstances.direct.field.urlPlaceholder')} disabled={directSaving} autoFocus />
              <Input className="h-8" value={directEditToken} onChange={(event) => setDirectEditToken(event.target.value)} placeholder={t('settings.remoteInstances.direct.field.tokenPlaceholder')} type="password" disabled={directSaving} />
              <div className="space-y-2">
                <div>
                  <p className="typography-ui-label text-foreground">{t('settings.remoteInstances.direct.headers.title')}</p>
                  <p className="typography-meta text-muted-foreground">{t('settings.remoteInstances.direct.headers.description')}</p>
                </div>
                {directEditHeaders.map((header) => (
                  <div key={header.id} className="flex w-full gap-2">
                    <Input className="h-8 font-mono text-xs" value={header.name} onChange={(event) => setDirectEditHeaders((headers) => headers.map((item) => item.id === header.id ? { ...item, name: event.target.value } : item))} placeholder={t('settings.remoteInstances.direct.headers.field.namePlaceholder')} disabled={directSaving} />
                    <Input className="h-8 font-mono text-xs" value={header.value} onChange={(event) => setDirectEditHeaders((headers) => headers.map((item) => item.id === header.id ? { ...item, value: event.target.value } : item))} placeholder={t('settings.remoteInstances.direct.headers.field.valuePlaceholder')} type="password" disabled={directSaving} />
                    <button type="button" onClick={() => setDirectEditHeaders((headers) => headers.filter((item) => item.id !== header.id))} className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-[var(--status-error-background)] hover:text-[var(--status-error)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]" aria-label={t('settings.remoteInstances.direct.headers.removeAria')} disabled={directSaving}>
                      <Icon name="close" className="h-4 w-4" />
                    </button>
                  </div>
                ))}
                <Button type="button" variant="ghost" size="xs" className="!font-normal" onClick={() => setDirectEditHeaders((headers) => [...headers, createHeaderDraft()])} disabled={directSaving}>
                  <Icon name="add" className="h-3.5 w-3.5" />
                  {t('settings.remoteInstances.direct.headers.actions.add')}
                </Button>
              </div>
              <div className="flex justify-end gap-2">
                <Button type="button" variant="outline" size="xs" className="!font-normal" onClick={() => setDirectEditingId(null)} disabled={directSaving}>{t('settings.common.actions.cancel')}</Button>
                <Button type="submit" size="xs" className="!font-normal" disabled={directSaving}>{t('settings.common.actions.saveChanges')}</Button>
              </div>
            </form>
          </DialogContent>
        </Dialog> : null}

        {showInstanceManagement ? <Dialog open={directImportDialogOpen} onOpenChange={setDirectImportDialogOpen}>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>{t('settings.remoteInstances.direct.import.action')}</DialogTitle>
              <DialogDescription>{t('settings.remoteInstances.direct.import.description')}</DialogDescription>
            </DialogHeader>
            <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void importDirectConnectLink(); }}>
              <Input className="h-8" value={directConnectLink} onChange={(event) => setDirectConnectLink(event.target.value)} placeholder={t('settings.remoteInstances.direct.import.placeholder')} disabled={directSaving} autoFocus />
              <div className="flex justify-end gap-2">
                <Button type="button" variant="outline" size="xs" className="!font-normal" onClick={() => setDirectImportDialogOpen(false)} disabled={directSaving}>{t('settings.common.actions.cancel')}</Button>
                <Button type="submit" size="xs" className="!font-normal" disabled={directSaving || !directConnectLink.trim()}>{t('settings.remoteInstances.direct.import.action')}</Button>
              </div>
            </form>
          </DialogContent>
        </Dialog> : null}

        <Dialog open={addDeviceOpen} onOpenChange={setAddDeviceOpen}>
          <DialogContent className={addDevicePhase === 'result' ? 'sm:max-w-lg' : 'sm:max-w-md'}>
            <DialogHeader>
              <DialogTitle>{addDevicePhase === 'result' ? t('settings.remoteInstances.clientAuth.qrDialogTitle') : t('settings.remoteInstances.clientAuth.actions.addDevice')}</DialogTitle>
              {/* Configure phase: what this dialog will produce. Result phase: what
                  to do with the QR code that is now on screen. */}
              <DialogDescription>{addDevicePhase === 'result' ? t('settings.remoteInstances.clientAuth.qrScanHint') : t('settings.remoteInstances.clientAuth.addDevice.subtitle')}</DialogDescription>
            </DialogHeader>
            {addDevicePhase === 'configure' ? (
              <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void createPairingLink(); }}>
                <Input
                  className="h-8"
                  value={remoteClientLabel}
                  onChange={(event) => setRemoteClientLabel(event.target.value)}
                  placeholder={t('settings.remoteInstances.clientAuth.field.labelPlaceholder')}
                  autoFocus
                />
                <div className="space-y-1.5">
                  <p className="typography-ui-label text-foreground">{t('settings.remoteInstances.clientAuth.addDevice.transportLabel')}</p>
                  {/* Ordered by how likely a first-time user is to want each option;
                      "Anywhere" is the default. Every option explains its outcome in
                      plain words — "relay" appears only inside the description. */}
                  <div role="radiogroup" aria-label={t('settings.remoteInstances.clientAuth.addDevice.transportLabel')} className="space-y-1.5">
                    {([
                      ...(transportOptions?.directE2eeAvailable ? [{ key: 'managed-e2ee' as const, label: t('settings.remoteInstances.transport.managedE2ee.label'), hint: t('settings.remoteInstances.transport.managedE2ee.description'), available: true }] : []),
                      { key: 'relay' as const, label: t('settings.remoteInstances.clientAuth.addDevice.transport.relay'), hint: t('settings.remoteInstances.clientAuth.addDevice.transport.relayHint'), available: Boolean(transportOptions?.relayAvailable) },
                      { key: 'lan' as const, label: t('settings.remoteInstances.clientAuth.addDevice.transport.lan'), hint: t('settings.remoteInstances.clientAuth.addDevice.transport.lanHint'), available: Boolean(transportOptions?.lanUrl) },
                      { key: 'local' as const, label: t('settings.remoteInstances.clientAuth.addDevice.transport.local'), hint: t('settings.remoteInstances.clientAuth.addDevice.transport.localHint'), available: Boolean(transportOptions?.localUrl) },
                    ]).map((option) => {
                      const selected = addDeviceTransport === option.key;
                      return (
                        <div
                          key={option.key}
                          className={cn('flex items-start gap-2 py-0.5', option.available ? 'cursor-pointer' : 'opacity-45')}
                          onClick={() => { if (option.available) setAddDeviceTransport(option.key); }}
                          role="presentation"
                        >
                          <Radio
                            checked={selected}
                            disabled={!option.available}
                            onChange={() => setAddDeviceTransport(option.key)}
                            ariaLabel={option.label}
                            className="mt-0.5"
                          />
                          <div className="min-w-0">
                            <p className={cn('typography-ui-label font-normal', selected ? 'text-foreground' : 'text-foreground/70')}>{option.label}</p>
                            <p className="typography-meta text-muted-foreground">{option.hint}</p>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  {addDeviceTransport === 'lan' ? (
                    <label className="flex w-fit cursor-pointer items-center gap-2 pt-1">
                      <Checkbox checked={addDeviceFallback} onChange={setAddDeviceFallback} ariaLabel={t('settings.remoteInstances.clientAuth.addDevice.fallback.relay')} />
                      <span className="typography-meta text-muted-foreground">{t('settings.remoteInstances.clientAuth.addDevice.fallback.relay')}</span>
                    </label>
                  ) : null}
                  {addDeviceTransport === 'managed-e2ee' ? (
                    <div className="space-y-2">
                      <div className="rounded-md border border-[var(--status-info-border)] bg-[var(--status-info-background)]/30 p-3">
                        <div className="flex items-start gap-2">
                          <Icon name="information" className="mt-0.5 size-4 shrink-0 text-[var(--status-info)]" />
                          <p className="typography-meta text-[var(--status-info)]">
                            {t('settings.remoteInstances.transport.managedE2ee.note')}
                          </p>
                        </div>
                      </div>
                    </div>
                  ) : addDeviceTransport === 'relay' && transportOptions?.lanUrl ? (
                    <label className="flex w-fit cursor-pointer items-center gap-2 pt-1">
                      <Checkbox checked={addDeviceFallback} onChange={setAddDeviceFallback} ariaLabel={t('settings.remoteInstances.clientAuth.addDevice.fallback.preferLocal')} />
                      <span className="typography-meta text-muted-foreground">{t('settings.remoteInstances.clientAuth.addDevice.fallback.preferLocal')}</span>
                    </label>
                  ) : null}
                </div>
                {remoteClientError ? <p className="typography-meta text-[var(--status-error)]">{remoteClientError}</p> : null}
                <div className="flex justify-end gap-2">
                  <Button type="button" variant="outline" size="xs" className="!font-normal" onClick={() => setAddDeviceOpen(false)} disabled={addDeviceCreating}>{t('settings.common.actions.cancel')}</Button>
                  <Button type="submit" size="xs" className="!font-normal" disabled={addDeviceCreating || !transportOptions}>{t('settings.remoteInstances.clientAuth.addDevice.create')}</Button>
                </div>
              </form>
            ) : (
              <div className="space-y-3">
                {pairingQrDataUrl ? (
                  <div className="flex justify-center">
                    <img src={pairingQrDataUrl} alt={t('settings.remoteInstances.clientAuth.qrAlt')} className="w-full max-w-[420px] rounded-md bg-white p-4" />
                  </div>
                ) : null}
                {pairingUrl ? (
                  <div className="flex items-center gap-2 rounded-md border border-[var(--interactive-border)] p-2">
                    <code className="min-w-0 flex-1 truncate typography-code text-muted-foreground">{pairingUrl}</code>
                    <Button type="button" variant="outline" size="xs" className="!font-normal shrink-0" onClick={handleCopyPairing}>
                      <Icon name={pairingCopied ? 'check' : 'file-copy'} className={cn('h-3.5 w-3.5', pairingCopied && 'text-[var(--status-success)]')} />
                      {pairingCopied ? t('settings.remoteInstances.clientAuth.actions.copied') : t('settings.common.actions.copyAll')}
                    </Button>
                  </div>
                ) : null}
                <div className="flex justify-end">
                  <Button type="button" size="xs" className="!font-normal" onClick={() => setAddDeviceOpen(false)}>{t('settings.remoteInstances.clientAuth.addDevice.done')}</Button>
                </div>
              </div>
            )}
          </DialogContent>
        </Dialog>

        {showInstanceManagement ? <div className="mb-8 border-t border-[var(--surface-subtle)] pt-8">
          <div className="mb-1 px-1 space-y-0.5">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <h3 className="typography-ui-header font-medium text-foreground">{t('settings.remoteInstances.sidebar.title')}</h3>
                <p className="typography-meta text-muted-foreground">{t('settings.remoteInstances.sidebar.total', { count: instances.length })}</p>
              </div>
              <Button type="button" size="xs" className="!font-normal" onClick={() => setSshAddDialogOpen(true)}>
                <Icon name="add" className="h-3.5 w-3.5" />
                {t('settings.remoteInstances.sidebar.actions.addSshInstance')}
              </Button>
            </div>
          </div>
          <section className="px-2 pb-2 pt-0 space-y-1">
            {isLoading ? (
              <p className="typography-meta text-muted-foreground">{t('settings.remoteInstances.page.import.loading')}</p>
            ) : instances.length === 0 ? (
              <p className="typography-meta text-muted-foreground">{t('settings.remoteInstances.page.import.noneFound')}</p>
            ) : instances.map((instance) => {
              const instanceStatus = statusesById[instance.id];
              const title = instance.nickname?.trim() || instance.sshParsed?.destination || instance.id;
              const phase = instanceStatus?.phase;
              const ready = phase === 'ready';
              return (
                <div key={instance.id} className="flex items-center justify-between gap-3 py-1.5">
                  <div className="min-w-0">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className={`h-2 w-2 rounded-full ${phaseDotClass(phase)}`} />
                      <p className="typography-ui-label text-foreground truncate">{title}</p>
                    </div>
                    <p className="typography-micro text-muted-foreground truncate">
                      {t(phaseLabelKey(phase))}{instanceStatus?.localUrl ? ` · ${instanceStatus.localUrl}` : ''}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button type="button" variant="ghost" size="xs" className="!font-normal" onClick={() => {
                      const op = ready ? disconnect(instance.id) : connect(instance.id);
                      void op.catch((err) => toast.error(ready ? t('settings.remoteInstances.sidebar.toast.disconnectFailed') : t('settings.remoteInstances.sidebar.toast.connectFailed'), {
                        description: err instanceof Error ? err.message : String(err),
                      }));
                    }}>
                      {ready ? <Icon name="stop" className="h-3.5 w-3.5" /> : <Icon name="plug-2" className="h-3.5 w-3.5" />}
                      {ready ? t('settings.remoteInstances.sidebar.actions.disconnect') : t('settings.remoteInstances.sidebar.actions.connect')}
                    </Button>
                    <Button type="button" variant="ghost" size="xs" className="!font-normal" onClick={() => setSelectedId(instance.id)}>
                      <Icon name="pencil" className="h-3.5 w-3.5" />
                      {t('desktopHostSwitcher.actions.edit')}
                    </Button>
                    <Button type="button" variant="ghost" size="xs" className="!font-normal" onClick={() => {
                      const ok = window.confirm(t('settings.remoteInstances.page.confirm.removeInstance'));
                      if (!ok) return;
                      void removeInstance(instance.id).catch((err) => toast.error(t('settings.remoteInstances.page.toast.removeInstanceFailed'), {
                        description: err instanceof Error ? err.message : String(err),
                      }));
                    }}>
                      <Icon name="delete-bin" className="h-3.5 w-3.5" />
                      {t('settings.common.actions.delete')}
                    </Button>
                  </div>
                </div>
              );
            })}
          </section>
        </div> : null}

        {showInstanceManagement ? <Dialog open={sshAddDialogOpen} onOpenChange={setSshAddDialogOpen}>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>{t('settings.remoteInstances.sidebar.actions.addSshInstance')}</DialogTitle>
              <DialogDescription>{t('settings.remoteInstances.page.section.instanceDescription')}</DialogDescription>
            </DialogHeader>
            <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void createSshInstanceFromDialog(); }}>
              <Input className="h-8" value={sshNameDraft} onChange={(event) => setSshNameDraft(event.target.value)} placeholder={t('settings.remoteInstances.page.field.nicknamePlaceholder')} disabled={isSaving} />
              <Input className="h-8" value={sshCommandDraft} onChange={(event) => setSshCommandDraft(event.target.value)} placeholder={t('settings.remoteInstances.page.field.sshCommandPlaceholder')} disabled={isSaving} autoFocus />
              <div className="flex justify-end gap-2">
                <Button type="button" variant="outline" size="xs" className="!font-normal" onClick={() => setSshAddDialogOpen(false)} disabled={isSaving}>{t('settings.common.actions.cancel')}</Button>
                <Button type="submit" size="xs" className="!font-normal" disabled={isSaving || !sshCommandDraft.trim()}>{t('settings.common.actions.create')}</Button>
              </div>
            </form>
          </DialogContent>
        </Dialog> : null}

        {showInstanceManagement ? <div className="mb-8 border-t border-[var(--surface-subtle)] pt-8">
          <div className="mb-1 px-1 space-y-0.5">
            <h3 className="typography-ui-header font-medium text-foreground">{t('settings.remoteInstances.page.import.sectionTitle')}</h3>
          </div>
          <section className="px-2 pb-2 pt-0">
          {isImportsLoading ? (
            <p className="typography-meta text-muted-foreground">{t('settings.remoteInstances.page.import.loading')}</p>
          ) : importCandidates.length === 0 ? (
            <p className="typography-meta text-muted-foreground">{t('settings.remoteInstances.page.import.noneFound')}</p>
          ) : (
            <div>
              {importCandidates.map((candidate) => (
                <div key={`${candidate.source}:${candidate.host}`} className="flex items-center justify-between gap-3 border-b border-[var(--surface-subtle)] py-3 last:border-b-0">
                  <div className="min-w-0">
                    <div className="typography-ui-label font-medium text-foreground truncate">
                      {candidate.host}
                      {candidate.pattern ? ` ${t('settings.remoteInstances.page.import.patternSuffix')}` : ''}
                    </div>
                    <div className="typography-meta text-muted-foreground truncate">{candidate.sshCommand}</div>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    className="!font-normal"
                    onClick={() => void handleImportCandidate(candidate.host, candidate.pattern)}
                  >
                    {t('settings.common.actions.import')}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </section>
        </div> : null}

        <Dialog
          open={Boolean(patternHost)}
          onOpenChange={(open) => {
            if (!open) {
              closePatternDialog();
            }
          }}
        >
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>{t('settings.remoteInstances.page.patternDialog.title')}</DialogTitle>
              <DialogDescription>
                {patternHost ? t('settings.remoteInstances.page.patternDialog.descriptionWithHost', { host: patternHost }) : t('settings.remoteInstances.page.patternDialog.description')}
              </DialogDescription>
            </DialogHeader>
            <form
              className="space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                handlePatternCreate();
              }}
            >
              <Input
                value={patternDestination}
                onChange={(event) => setPatternDestination(event.target.value)}
                placeholder={t('settings.remoteInstances.page.patternDialog.destinationPlaceholder')}
                autoFocus
              />
              <div className="flex items-center justify-end gap-2">
                <Button type="button" variant="outline" size="xs" className="!font-normal" onClick={closePatternDialog} disabled={patternCreating}>
                  {t('settings.common.actions.cancel')}
                </Button>
                <Button type="submit" size="xs" className="!font-normal" disabled={patternCreating}>
                  {t('settings.remoteInstances.page.actions.create')}
                </Button>
              </div>
            </form>
          </DialogContent>
        </Dialog>
      </SettingsPageLayout>
    );
  }

  const isManagedMode = draft.remoteOpenchamber.mode === 'managed';
  const instanceTitle = draft.nickname?.trim() || draft.sshParsed?.destination || draft.id;

  return (
    <Dialog open={Boolean(draft)} onOpenChange={(open) => { if (!open) setSelectedId(null); }}>
      <DialogContent className="sm:max-w-4xl max-h-[90vh] overflow-auto">
      <div className="mb-6 px-1">
        <h2 className="typography-ui-header font-semibold text-foreground truncate">{instanceTitle}</h2>
        <div className="mt-1 flex flex-wrap items-center gap-2 typography-meta text-muted-foreground">
          <span className={`h-2.5 w-2.5 rounded-full ${phaseDotClass(statusPhase)}`} />
          <span>{t(phaseLabelKey(statusPhase))}</span>
          {status?.localUrl ? <span className="font-mono text-foreground/80">{status.localUrl}</span> : null}
          {reconnectAppearsStuck ? <span>{t('settings.remoteInstances.page.status.reconnectStale')}</span> : null}
        </div>
      </div>

      <div className="mb-8">
        <div className="mb-1 px-1 space-y-0.5">
          <h3 className="typography-ui-header font-medium text-foreground">{t('settings.remoteInstances.page.section.actions')}</h3>
          <p className="typography-meta text-muted-foreground">{t('settings.remoteInstances.page.section.actionsDescription')}</p>
        </div>
        <section className="px-2 pb-2 pt-0 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant={canDisconnect ? 'outline' : 'default'}
              size="xs"
              className="!font-normal"
              onClick={handlePrimaryConnectionAction}
              disabled={isPrimaryActionPending || isRetryPending}
            >
              {canDisconnect ? <Icon name="stop" className="h-3.5 w-3.5" /> : <Icon name="plug-2" className="h-3.5 w-3.5" />}
              {primaryButtonLabel}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="xs"
              className="!font-normal"
              onClick={handleRetryAction}
              disabled={!canRetry}
            >
              <Icon name="refresh" className={`h-3.5 w-3.5 ${isConnecting || (isReconnecting && !reconnectAppearsStuck) ? 'animate-spin' : ''}`} />
              {retryButtonLabel}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="xs"
              className="!font-normal"
              onClick={() => {
                void handleOpenLogs();
              }}
            >
              <Icon name="terminal-window" className="h-3.5 w-3.5" />
              {t('settings.remoteInstances.page.actions.logs')}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="xs"
              className="!font-normal text-[var(--status-error)] border-[var(--status-error)]/30 hover:text-[var(--status-error)]"
              onClick={() => {
                const ok = window.confirm(t('settings.remoteInstances.page.confirm.removeInstance'));
                if (!ok) return;
                void removeInstance(draft.id)
                  .then(() => {
                    setSelectedId(null);
                    toast.success(t('settings.remoteInstances.page.toast.instanceRemoved'));
                  })
                  .catch((err) => {
                    toast.error(t('settings.remoteInstances.page.toast.removeInstanceFailed'), {
                      description: err instanceof Error ? err.message : String(err),
                    });
                  });
              }}
            >
              <Icon name="delete-bin" className="h-3.5 w-3.5" />
              {t('settings.remoteInstances.sidebar.actions.remove')}
            </Button>
          </div>
          {status?.localUrl ? (
            <div className="flex flex-wrap items-center gap-2 typography-meta text-muted-foreground">
              <span>{t('settings.remoteInstances.page.status.currentLocalUrl')}</span>
              <span className="font-mono text-foreground/90">{status.localUrl}</span>
            </div>
          ) : null}
        </section>
      </div>

      <div className="mb-8">
        <div className="mb-1 px-1 space-y-0.5">
          <h3 className="typography-ui-header font-medium text-foreground">{t('settings.remoteInstances.page.section.instance')}</h3>
          <p className="typography-meta text-muted-foreground">{t('settings.remoteInstances.page.section.instanceDescription')}</p>
        </div>
        <section className="px-2 pb-2 pt-0 space-y-3">
          <div className="flex flex-col gap-1.5 py-1.5 md:flex-row md:items-center md:gap-8">
            <span className="typography-ui-label text-foreground w-56 shrink-0">{t('settings.remoteInstances.page.field.sshCommand')}</span>
            <Input
              className="h-7 md:max-w-xl"
              value={draft.sshCommand}
              onChange={(event) =>
                updateDraft((current) => ({
                  ...current,
                  sshCommand: event.target.value,
                }))
              }
              placeholder={t('settings.remoteInstances.page.field.sshCommandPlaceholder')}
            />
          </div>
          <div className="flex flex-col gap-1.5 py-1.5 md:flex-row md:items-center md:gap-8">
            <span className="typography-ui-label text-foreground w-56 shrink-0">{t('settings.remoteInstances.page.field.nickname')}</span>
            <Input
              className="h-7 md:max-w-sm"
              value={draft.nickname || ''}
              onChange={(event) =>
                updateDraft((current) => ({
                  ...current,
                  nickname: event.target.value,
                }))
              }
              placeholder={t('settings.remoteInstances.page.field.nicknamePlaceholder')}
            />
          </div>
          <div className="flex flex-col gap-1.5 py-1.5 md:flex-row md:items-center md:gap-8">
            <span className="typography-ui-label text-foreground w-56 shrink-0">{t('settings.remoteInstances.page.field.connectionTimeoutSeconds')}</span>
            <NumberInput
              containerClassName="w-fit"
              min={5}
              max={240}
              step={1}
              className="w-16 tabular-nums"
              value={draft.connectionTimeoutSec}
              onValueChange={(next) => {
                updateDraft((current) => ({
                  ...current,
                  connectionTimeoutSec: Number.isFinite(next) ? next : current.connectionTimeoutSec,
                }));
              }}
            />
          </div>
        </section>
      </div>

      <div className="mb-8 border-t border-[var(--surface-subtle)] pt-8">
        <div className="mb-1 px-1 space-y-0.5">
          <h3 className="typography-ui-header font-medium text-foreground">{t('settings.remoteInstances.page.section.remoteServer')}</h3>
          <p className="typography-meta text-muted-foreground">{t('settings.remoteInstances.page.section.remoteServerDescription')}</p>
        </div>
        <section className="px-2 pb-2 pt-0 space-y-3">
          <div className="flex flex-col gap-1.5 py-1.5 md:flex-row md:items-center md:gap-8">
            <div className="w-56 shrink-0">
                <HintLabel
                  label={t('settings.remoteInstances.page.field.mode')}
                  hint={t('settings.remoteInstances.page.field.modeHint')}
                />
            </div>
            <Select
              value={draft.remoteOpenchamber.mode}
              onValueChange={(value) =>
                updateDraft((current) => ({
                  ...current,
                  remoteOpenchamber: {
                    ...current.remoteOpenchamber,
                    mode: value === 'external' ? 'external' : 'managed',
                  },
                }))
              }
            >
              <SelectTrigger className="h-7 w-fit min-w-[140px]">
                <SelectValue placeholder={t('settings.remoteInstances.page.field.modePlaceholder')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="managed">{t('settings.remoteInstances.page.field.modeManaged')}</SelectItem>
                <SelectItem value="external">{t('settings.remoteInstances.page.field.modeExternal')}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5 py-1.5 md:flex-row md:items-center md:gap-8">
            <div className="w-56 shrink-0">
                <HintLabel
                  label={t('settings.remoteInstances.page.field.preferredRemotePort')}
                  hint={t('settings.remoteInstances.page.field.preferredRemotePortHint')}
                />
            </div>
            <NumberInput
              containerClassName="w-fit"
              min={1}
              max={65535}
              step={1}
              className="w-20 tabular-nums"
              value={draft.remoteOpenchamber.preferredPort}
              onValueChange={(next) => {
                updateDraft((current) => ({
                  ...current,
                  remoteOpenchamber: {
                    ...current.remoteOpenchamber,
                    preferredPort: Number.isFinite(next) && next > 0 ? next : undefined,
                  },
                }));
              }}
              onClear={() => {
                updateDraft((current) => ({
                  ...current,
                  remoteOpenchamber: {
                    ...current.remoteOpenchamber,
                    preferredPort: undefined,
                  },
                }));
              }}
              emptyLabel={t('settings.remoteInstances.page.field.auto')}
            />
          </div>

          {isManagedMode ? (
            <div className="flex flex-col gap-1.5 py-1.5 md:flex-row md:items-center md:gap-8">
              <div className="w-56 shrink-0">
                <HintLabel
                  label={t('settings.remoteInstances.page.field.installMethod')}
                  hint={t('settings.remoteInstances.page.field.installMethodHint')}
                />
              </div>
              <Select
                value={draft.remoteOpenchamber.installMethod}
                onValueChange={(value) =>
                  updateDraft((current) => ({
                    ...current,
                    remoteOpenchamber: {
                      ...current.remoteOpenchamber,
                      installMethod:
                        value === 'npm' || value === 'download_release' || value === 'upload_bundle'
                          ? value
                          : 'bun',
                    },
                  }))
                }
              >
                <SelectTrigger className="h-7 w-fit min-w-[140px]">
                  <SelectValue placeholder={t('settings.remoteInstances.page.field.selectInstallMethodPlaceholder')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="bun">bun</SelectItem>
                  <SelectItem value="npm">npm</SelectItem>
                  <SelectItem value="download_release">{t('settings.remoteInstances.page.field.installMethodDownloadRelease')}</SelectItem>
                  <SelectItem value="upload_bundle">{t('settings.remoteInstances.page.field.installMethodUploadBundle')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          ) : null}

          {isManagedMode ? (
            <div className="flex flex-col gap-1.5 py-1.5 md:flex-row md:items-center md:gap-8">
              <div className="w-56 shrink-0">
                <HintLabel
                  label={t('settings.remoteInstances.page.field.keepServerRunning')}
                  hint={t('settings.remoteInstances.page.field.keepServerRunningHint')}
                />
              </div>
              <div className="flex w-full items-center gap-2 md:max-w-xs">
                <Switch
                  checked={draft.remoteOpenchamber.keepRunning}
                  onCheckedChange={(checked) =>
                    updateDraft((current) => ({
                      ...current,
                      remoteOpenchamber: {
                        ...current.remoteOpenchamber,
                        keepRunning: checked,
                      },
                    }))
                  }
                />
              </div>
            </div>
          ) : null}
        </section>
      </div>

      <div className="mb-8 border-t border-[var(--surface-subtle)] pt-8">
        <div className="mb-1 px-1 space-y-0.5">
          <h3 className="typography-ui-header font-medium text-foreground">{t('settings.remoteInstances.page.section.mainTunnel')}</h3>
          <p className="typography-meta text-muted-foreground">{t('settings.remoteInstances.page.section.mainTunnelDescription')}</p>
        </div>
        <section className="px-2 pb-2 pt-0 space-y-3">
          <div className="flex flex-col gap-1.5 py-1.5 md:flex-row md:items-center md:gap-8">
            <div className="w-56 shrink-0">
                <HintLabel
                  label={t('settings.remoteInstances.page.field.bindHost')}
                  hint={t('settings.remoteInstances.page.field.bindHostHint')}
                />
            </div>
            <Select
              value={draft.localForward.bindHost}
              onValueChange={(value) => {
                if (value === '0.0.0.0') {
                  const allow = window.confirm(
                    t('settings.remoteInstances.page.confirm.bindAllInterfaces'),
                  );
                  if (!allow) return;
                }
                updateDraft((current) => ({
                  ...current,
                  localForward: {
                    ...current.localForward,
                    bindHost: value === 'localhost' || value === '0.0.0.0' ? value : '127.0.0.1',
                  },
                }));
              }}
            >
              <SelectTrigger className="h-7 w-fit min-w-[140px]">
                <SelectValue placeholder={t('settings.remoteInstances.page.field.selectBindHostPlaceholder')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="127.0.0.1">127.0.0.1</SelectItem>
                <SelectItem value="localhost">localhost</SelectItem>
                <SelectItem value="0.0.0.0">0.0.0.0</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5 py-1.5 md:flex-row md:items-center md:gap-8">
            <div className="w-56 shrink-0">
                <HintLabel
                  label={t('settings.remoteInstances.page.field.preferredLocalPort')}
                  hint={t('settings.remoteInstances.page.field.preferredLocalPortHint')}
                />
            </div>
            <div className="flex w-full items-center gap-2 md:max-w-sm">
              <NumberInput
                containerClassName="w-fit"
                min={1}
                max={65535}
                step={1}
                className="w-20 tabular-nums"
                value={draft.localForward.preferredLocalPort}
                onValueChange={(next) => {
                  updateDraft((current) => ({
                    ...current,
                    localForward: {
                      ...current.localForward,
                      preferredLocalPort: Number.isFinite(next) && next > 0 ? next : undefined,
                    },
                  }));
                }}
                onClear={() => {
                  updateDraft((current) => ({
                    ...current,
                    localForward: {
                      ...current.localForward,
                      preferredLocalPort: undefined,
                    },
                  }));
                }}
                emptyLabel={t('settings.remoteInstances.page.field.auto')}
              />
              <Button
                type="button"
                variant="outline"
                size="xs"
                className="!font-normal h-7 w-7 px-0"
                title={t('settings.remoteInstances.page.actions.pickRandomPort')}
                onClick={() =>
                  updateDraft((current) => ({
                    ...current,
                    localForward: {
                      ...current.localForward,
                      preferredLocalPort: randomPort(),
                    },
                  }))
                }
              >
                <Icon name="shuffle" className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        </section>
      </div>

      <div className="mb-8 border-t border-[var(--surface-subtle)] pt-8">
        <div className="mb-1 px-1 space-y-0.5">
          <h3 className="typography-ui-header font-medium text-foreground">{t('settings.remoteInstances.page.section.authentication')}</h3>
          <p className="typography-meta text-muted-foreground">{t('settings.remoteInstances.page.section.authenticationDescription')}</p>
        </div>
        <section className="px-2 pb-2 pt-0 space-y-3">
          <div className="flex flex-col gap-1.5 py-1.5 md:flex-row md:items-center md:gap-8">
            <span className="typography-ui-label text-foreground w-56 shrink-0">{t('settings.remoteInstances.page.field.sshPasswordOptional')}</span>
            <Input
              className="h-7 md:max-w-sm"
              type="password"
              value={draft.auth.sshPassword?.value || ''}
              onChange={(event) =>
                updateDraft((current) => ({
                  ...current,
                  auth: {
                    ...current.auth,
                    sshPassword: {
                      enabled: event.target.value.trim().length > 0,
                      value: event.target.value,
                      store: current.auth.sshPassword?.store || 'never',
                    },
                  },
                }))
              }
              placeholder={t('settings.remoteInstances.page.field.sshPasswordPlaceholder')}
            />
          </div>

          <div className="flex flex-col gap-1.5 py-1.5 md:flex-row md:items-center md:gap-8">
            <span className="typography-ui-label text-foreground w-56 shrink-0">{t('settings.remoteInstances.page.field.uiPasswordOptional')}</span>
            <Input
              className="h-7 md:max-w-sm"
              type="password"
              value={draft.auth.openchamberPassword?.value || ''}
              onChange={(event) =>
                updateDraft((current) => ({
                  ...current,
                  auth: {
                    ...current.auth,
                    openchamberPassword: {
                      enabled: event.target.value.trim().length > 0,
                      value: event.target.value,
                      store: current.auth.openchamberPassword?.store || 'never',
                    },
                  },
                }))
              }
              placeholder={t('settings.remoteInstances.page.field.uiPasswordPlaceholder')}
            />
          </div>
        </section>
      </div>

      <div className="mb-8 border-t border-[var(--surface-subtle)] pt-8">
        <div className="mb-1 px-1 space-y-0.5">
          <h3 className="typography-ui-header font-medium text-foreground">{t('settings.remoteInstances.page.section.portForwards')}</h3>
          <p className="typography-meta text-muted-foreground">{t('settings.remoteInstances.page.section.portForwardsDescription')}</p>
        </div>
        <section className="px-2 pb-2 pt-0 space-y-2">
          {draft.portForwards.length === 0 ? (
            <p className="typography-micro text-muted-foreground/80">{t('settings.remoteInstances.page.empty.noExtraForwards')}</p>
          ) : null}

          {draft.portForwards.map((forward, index) => {
            const updateForward = (updater: (forward: DesktopSshPortForward) => DesktopSshPortForward) => {
              updateDraft((current) => ({
                ...current,
                portForwards: current.portForwards.map((item, itemIndex) =>
                  itemIndex === index ? updater(item) : item,
                ),
              }));
            };

            const localLabel = forward.type === 'remote' ? 'Local target' : 'Local listen';
            const localHint = forward.type === 'remote'
              ? 'Local host and port on your machine that receives traffic from remote -R listener.'
              : 'Local host and port where this forward listens on your machine.';
            const remoteLabel = forward.type === 'remote' ? 'Remote listen' : 'Remote target';
            const remoteHint = forward.type === 'remote'
              ? 'Remote host and port where SSH creates the -R listener.'
              : 'Remote host and port that receives traffic from local -L listener.';

            const localEndpoint = formatEndpoint(forward.localHost || 'localhost', forward.localPort);
            const remoteEndpoint = formatEndpoint(forward.remoteHost || 'localhost', forward.remotePort);
            const canOpenLocalEndpoint =
              forward.type === 'local' && typeof forward.localPort === 'number' && forward.localPort > 0;
            const localEndpointUrl = canOpenLocalEndpoint
              ? `http://${toBrowserHost(forward.localHost)}:${forward.localPort}`
              : '';

            const isForwardOpen = Boolean(expandedForwards[forward.id]);

            const typeLabel = forward.type === 'local' ? t('settings.remoteInstances.page.forwardType.local') : forward.type === 'remote' ? t('settings.remoteInstances.page.forwardType.remote') : t('settings.remoteInstances.page.forwardType.dynamic');

            return (
              <Collapsible
                key={forward.id}
                open={isForwardOpen}
                onOpenChange={(open) => {
                  setExpandedForwards((current) => ({
                    ...current,
                    [forward.id]: open,
                  }));
                }}
                className={`${index > 0 ? 'border-t border-[var(--surface-subtle)]' : ''} py-2`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0 flex items-center gap-2">
                    <CollapsibleTrigger className="flex items-center gap-2 group">
                      <Icon name="arrow-down-s" className={`h-4 w-4 text-muted-foreground transition-transform ${isForwardOpen ? 'rotate-180' : ''}`} />
                      <span className="typography-ui-label text-foreground truncate">{buildForwardLabel(forward)}</span>
                      <span className="typography-micro text-muted-foreground/70 shrink-0">{typeLabel}</span>
                    </CollapsibleTrigger>
                  </div>
                  <div className="flex items-center gap-2">
                    <Switch checked={forward.enabled} onCheckedChange={(checked) => updateForward((item) => ({ ...item, enabled: checked }))} aria-label={t('settings.remoteInstances.page.actions.enableForwardAria')} />
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      className="!font-normal h-6 w-6 px-0 text-[var(--status-error)] hover:text-[var(--status-error)]"
                      onClick={() =>
                        updateDraft((current) => ({
                          ...current,
                          portForwards: current.portForwards.filter((item) => item.id !== forward.id),
                        }))
                      }
                    >
                      <Icon name="delete-bin" className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
                <CollapsibleContent className="pt-2">
                  <div className="space-y-0 pb-2">
                    <p className="typography-meta text-muted-foreground mb-3">{t(forwardTypeDescriptionKey(forward.type))}</p>
                    <div className="flex flex-col gap-1.5 py-1.5 md:flex-row md:items-center md:gap-8">
                      <div className="w-56 shrink-0">
                        <HintLabel
                          label={t('settings.remoteInstances.page.field.forwardType')}
                          hint={t('settings.remoteInstances.page.field.forwardTypeHint')}
                        />
                      </div>
                      <Select
                        value={forward.type}
                        onValueChange={(value) =>
                          updateForward((item) => ({
                            ...item,
                            type: (value === 'dynamic' || value === 'remote' ? value : 'local') as DesktopSshPortForwardType,
                          }))
                        }
                      >
                        <SelectTrigger className="h-7 w-fit min-w-[140px]">
                          <SelectValue placeholder={t('settings.remoteInstances.page.field.typePlaceholder')} />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="local">{t('settings.remoteInstances.page.forwardType.local')}</SelectItem>
                          <SelectItem value="remote">{t('settings.remoteInstances.page.forwardType.remote')}</SelectItem>
                          <SelectItem value="dynamic">{t('settings.remoteInstances.page.forwardType.dynamic')}</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="flex flex-col gap-1.5 py-1.5 md:flex-row md:items-center md:gap-8">
                      <div className="w-56 shrink-0">
                        <HintLabel label={localLabel} hint={localHint} />
                      </div>
                      <div className="flex items-center gap-1.5">
                        <Input
                          className="h-7 w-32"
                          value={forward.localHost || '127.0.0.1'}
                          onChange={(event) =>
                            updateForward((item) => ({
                              ...item,
                              localHost: event.target.value,
                            }))
                          }
                          placeholder={t('settings.remoteInstances.page.field.localHostPlaceholder')}
                        />
                        <span className="text-muted-foreground">:</span>
                        <NumberInput
                          containerClassName="w-fit"
                          min={1}
                          max={65535}
                          step={1}
                          className="w-16 tabular-nums"
                          value={forward.localPort}
                          onValueChange={(next) => {
                            updateForward((item) => ({
                              ...item,
                              localPort: Number.isFinite(next) && next > 0 ? next : undefined,
                            }));
                          }}
                          onClear={() => {
                            updateForward((item) => ({
                              ...item,
                              localPort: undefined,
                            }));
                          }}
                          emptyLabel={t('settings.remoteInstances.page.field.auto')}
                        />
                      </div>
                    </div>

                    {forward.type !== 'dynamic' ? (
                      <div className="flex flex-col gap-1.5 py-1.5 md:flex-row md:items-center md:gap-8">
                        <div className="w-56 shrink-0">
                          <HintLabel label={remoteLabel} hint={remoteHint} />
                        </div>
                        <div className="flex items-center gap-1.5">
                          <Input
                            className="h-7 w-32"
                            value={forward.remoteHost || ''}
                            onChange={(event) =>
                              updateForward((item) => ({
                                ...item,
                                remoteHost: event.target.value,
                              }))
                            }
                            placeholder={t('settings.remoteInstances.page.field.remoteHostPlaceholder')}
                          />
                          <span className="text-muted-foreground">:</span>
                          <NumberInput
                            containerClassName="w-fit"
                            min={1}
                            max={65535}
                            step={1}
                            className="w-16 tabular-nums"
                            value={forward.remotePort}
                            onValueChange={(next) => {
                              updateForward((item) => ({
                                ...item,
                                remotePort: Number.isFinite(next) && next > 0 ? next : undefined,
                              }));
                            }}
                            onClear={() => {
                              updateForward((item) => ({
                                ...item,
                                remotePort: undefined,
                              }));
                            }}
                            emptyLabel={t('settings.remoteInstances.page.field.auto')}
                          />
                        </div>
                      </div>
                    ) : null}

                    <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-md bg-[var(--surface-subtle)] p-2">
                      <div className="flex flex-wrap items-center gap-1 typography-micro text-muted-foreground/80">
                        {forward.type === 'dynamic' ? (
                          <>
                            <Icon name="computer" className="h-3.5 w-3.5" />
                            <span className="font-mono text-foreground">{localEndpoint}</span>
                            <span>{t('settings.remoteInstances.page.preview.localSocks5')}</span>
                          </>
                        ) : forward.type === 'remote' ? (
                          <>
                            <Icon name="server" className="h-3.5 w-3.5" />
                            <span className="font-mono text-foreground">{remoteEndpoint}</span>
                            <span>{t('settings.remoteInstances.page.preview.remote')}</span>
                            <Icon name="arrow-right" className="h-3.5 w-3.5" />
                            <Icon name="computer" className="h-3.5 w-3.5" />
                            <span className="font-mono text-foreground">{localEndpoint}</span>
                            <span>{t('settings.remoteInstances.page.preview.local')}</span>
                          </>
                        ) : (
                          <>
                            <Icon name="computer" className="h-3.5 w-3.5" />
                            <span className="font-mono text-foreground">{localEndpoint}</span>
                            <span>{t('settings.remoteInstances.page.preview.local')}</span>
                            <Icon name="arrow-right" className="h-3.5 w-3.5" />
                            <Icon name="server" className="h-3.5 w-3.5" />
                            <span className="font-mono text-foreground">{remoteEndpoint}</span>
                            <span>{t('settings.remoteInstances.page.preview.remote')}</span>
                          </>
                        )}
                      </div>

                      {canOpenLocalEndpoint ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="xs"
                          className="!font-normal"
                          onClick={() => {
                            void openExternalUrl(localEndpointUrl).then((opened) => {
                              if (!opened) {
                                toast.error(t('settings.remoteInstances.page.toast.openLocalEndpointFailed'));
                              }
                            });
                          }}
                        >
                          <Icon name="external-link" className="h-3.5 w-3.5" />
                          {t('settings.remoteInstances.page.actions.openLocal')}
                        </Button>
                      ) : null}
                    </div>
                  </div>
                </CollapsibleContent>
              </Collapsible>
            );
          })}

          <Button
            type="button"
            variant="outline"
            size="xs"
            className="!font-normal mt-1"
            onClick={() => {
              const nextForward = makeForward();
              updateDraft((current) => ({
                ...current,
                portForwards: [...current.portForwards, nextForward],
              }));
              setExpandedForwards((current) => ({
                ...current,
                [nextForward.id]: true,
              }));
            }}
          >
            <Icon name="add" className="h-3.5 w-3.5" />
            {t('settings.remoteInstances.page.actions.addForward')}
          </Button>
        </section>
      </div>

      <div className="mt-8 border-t border-[var(--interactive-border)] pt-3">
        <div className="flex items-center gap-2">
          <Button type="button" size="xs" className="!font-normal" onClick={() => void handleSave()} disabled={!hasChanges || isSaving}>
            {t('settings.common.actions.saveChanges')}
          </Button>
          {status?.localUrl ? (
            <>
              <Button
                type="button"
                variant="outline"
                size="xs"
                className="!font-normal"
                onClick={() => {
                  void copyTextToClipboard(status.localUrl || '').then((result) => {
                    if (result.ok) {
                      toast.success(t('settings.remoteInstances.page.toast.localUrlCopied'));
                    }
                  });
                }}
              >
                <Icon name="file-copy" className="h-3.5 w-3.5" />
                {t('settings.remoteInstances.page.actions.copyLocalUrl')}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="xs"
                className="!font-normal"
                onClick={() => {
                  void handleOpenCurrentInstance();
                }}
              >
                <Icon name="external-link" className="h-3.5 w-3.5" />
                {t('settings.remoteInstances.page.actions.open')}
              </Button>
            </>
          ) : null}
          {error ? <div className="ml-auto typography-meta text-[var(--status-error)]">{error}</div> : null}
        </div>
      </div>

      <Dialog open={logDialogOpen} onOpenChange={setLogDialogOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t('settings.remoteInstances.page.logsDialog.title')}</DialogTitle>
            <DialogDescription>
              {draft?.nickname?.trim() || draft?.sshParsed?.destination || draft?.id || t('settings.remoteInstances.page.logsDialog.selectedInstanceFallback')}
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center justify-end gap-2">
            <Button type="button" variant="outline" size="xs" className="!font-normal" onClick={handleCopyAllLogs} disabled={logDialogLoading || !logLinesText.trim()}>
              <Icon name="file-copy" className="h-3.5 w-3.5" />
              {t('settings.common.actions.copyAll')}
            </Button>
            <Button type="button" variant="outline" size="xs" className="!font-normal" onClick={() => void handleClearLogs()} disabled={logDialogLoading}>
              <Icon name="delete-bin" className="h-3.5 w-3.5" />
              {t('settings.common.actions.clear')}
            </Button>
          </div>
          {logDialogLoading ? (
            <div className="typography-meta text-muted-foreground">{t('settings.remoteInstances.page.logsDialog.loading')}</div>
          ) : logDialogError ? (
            <div className="typography-meta text-[var(--status-error)]">{logDialogError}</div>
          ) : (
            <pre className="max-h-[55vh] overflow-auto rounded-md border border-[var(--interactive-border)] bg-[var(--surface-elevated)] p-3 typography-micro text-foreground whitespace-pre-wrap break-words">
              {logDialogLines.length > 0 ? logDialogLines.join('\n') : t('settings.remoteInstances.page.logsDialog.empty')}
            </pre>
          )}
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(patternHost)}
        onOpenChange={(open) => {
          if (!open) {
            closePatternDialog();
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('settings.remoteInstances.page.patternDialog.title')}</DialogTitle>
            <DialogDescription>
              {patternHost
                ? t('settings.remoteInstances.page.patternDialog.descriptionWithHost', { host: patternHost })
                : t('settings.remoteInstances.page.patternDialog.description')}
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              handlePatternCreate();
            }}
          >
            <Input
              value={patternDestination}
              onChange={(event) => setPatternDestination(event.target.value)}
              placeholder={t('settings.remoteInstances.page.patternDialog.destinationPlaceholder')}
              autoFocus
            />
            <div className="flex items-center justify-end gap-2">
              <Button type="button" variant="outline" size="xs" className="!font-normal" onClick={closePatternDialog} disabled={patternCreating}>
                {t('settings.common.actions.cancel')}
              </Button>
              <Button type="submit" size="xs" className="!font-normal" disabled={patternCreating}>
                {t('settings.common.actions.create')}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
      </DialogContent>
    </Dialog>
  );
};
