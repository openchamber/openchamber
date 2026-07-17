import * as React from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { toast } from '@/components/ui';
import { isDesktopLocalOriginActive, isDesktopTrustedLocalPage, isElectronShell, isDesktopShell } from '@/lib/desktop';
import { Icon } from "@/components/icon/Icon";
import { useUIStore } from '@/stores/useUIStore';
import { useI18n } from '@/lib/i18n';
import {
  desktopHostProbe,
  desktopHostsGet,
  desktopHostsSet,
  desktopLocalClientTokenGet,
  desktopOpenNewWindowAtUrl,
  desktopOpenNewWindowForHost,
  getDesktopHostApiUrl,
  locationMatchesHost,
  normalizeHostUrl,
  getDesktopHostRuntimeSwitchOptions,
  probeDesktopHostTransports,
  probeDesktopHostTransportsForActivation,
  redactSensitiveUrl,
  resolveDesktopHostUrl,
  runtimeKeyForHost,
  resolveActiveDesktopHost,
  shouldDelegateDesktopHostActivation,
  type DesktopHost,
  type HostProbeResult,
} from '@/lib/desktopHosts';
import { scheduleDesktopHostCandidateRefresh } from '@/lib/desktopRelayRestore';
import { adoptRelayTunnel } from '@/lib/relay/runtime-tunnel';
import { getRuntimeApiBaseUrl, getRuntimeKey, subscribeRuntimeEndpointChanged, switchRuntimeEndpoint } from '@/lib/runtime-switch';
import { hostTransportLabelKey } from '@/lib/hostTransportLabel';
import {
  desktopSshConnect,
  desktopSshDisconnect,
  desktopSshInstancesGet,
  desktopSshStatus,
  type DesktopSshInstanceStatus,
} from '@/lib/desktopSsh';

const LOCAL_HOST_ID = 'local';
const SSH_CONNECT_TIMEOUT_MS = 90_000;
const SSH_CONNECT_CANCELLED_ERROR = 'SSH connection cancelled';

type HostStatus = {
  status: HostProbeResult['status'];
  latencyMs: number;
  /** Which transport the successful probe used (multi-transport hosts). */
  via?: 'direct' | 'relay' | 'direct-e2ee';
};

// Last known statuses survive the dropdown unmounting (it remounts on every
// open). Rows show the previous result immediately — refreshed quietly by the
// open-probe — instead of shouting "Unknown" at the user for a few seconds.
const lastKnownHostStatuses: Record<string, HostStatus> = {};

type HostDisplayStatus = HostProbeResult['status'] | 'checking' | null;

const toNavigationUrl = (rawUrl: string): string => {
  const normalized = normalizeHostUrl(rawUrl);
  if (!normalized) {
    return rawUrl.trim();
  }

  try {
    const url = new URL(normalized);
    if (!url.pathname.endsWith('/')) {
      url.pathname = `${url.pathname}/`;
    }
    return url.toString();
  } catch {
    return normalized;
  }
};

const getLocalOrigin = (): string => {
  if (typeof window === 'undefined') return '';
  return window.__OPENCHAMBER_LOCAL_ORIGIN__ || window.location.origin;
};

const getLocalClientToken = async (): Promise<string> => {
  if (!isElectronShell()) return '';
  return desktopLocalClientTokenGet().catch(() => '');
};

const statusDotClass = (status: HostDisplayStatus): string => {
  if (status === 'ok') return 'bg-status-success';
  if (status === 'auth') return 'bg-status-warning';
  if (status === 'update-recommended') return 'bg-status-warning';
  if (status === 'incompatible') return 'bg-status-error';
  if (status === 'wrong-service') return 'bg-status-error';
  if (status === 'unreachable') return 'bg-status-error';
  if (status === 'checking') return 'bg-status-info';
  return 'bg-muted-foreground/40';
};

// Text tone matching statusDotClass, for the per-row status line.
const statusTextClass = (status: HostDisplayStatus): string => {
  if (status === 'ok') return 'text-[var(--status-success)]';
  if (status === 'auth' || status === 'update-recommended') return 'text-[var(--status-warning)]';
  if (status === 'incompatible' || status === 'wrong-service' || status === 'unreachable') return 'text-[var(--status-error)]';
  return 'text-muted-foreground';
};

const isBlockedHostStatus = (status: HostProbeResult['status'] | null): boolean => {
  return status === 'unreachable' || status === 'wrong-service' || status === 'incompatible';
};

const isBlockedDisplayStatus = (status: HostDisplayStatus): boolean => {
  return status === 'unreachable' || status === 'wrong-service' || status === 'incompatible';
};

const statusLabelKey = (status: HostDisplayStatus):
  | 'desktopHostSwitcher.status.connected'
  | 'desktopHostSwitcher.status.authRequired'
  | 'desktopHostSwitcher.status.checking'
  | 'desktopHostSwitcher.status.updateRecommended'
  | 'desktopHostSwitcher.status.incompatible'
  | 'desktopHostSwitcher.status.wrongService'
  | 'desktopHostSwitcher.status.unreachable'
  | 'desktopHostSwitcher.status.unknown' => {
  if (status === 'ok') return 'desktopHostSwitcher.status.connected';
  if (status === 'auth') return 'desktopHostSwitcher.status.authRequired';
  if (status === 'checking') return 'desktopHostSwitcher.status.checking';
  if (status === 'update-recommended') return 'desktopHostSwitcher.status.updateRecommended';
  if (status === 'incompatible') return 'desktopHostSwitcher.status.incompatible';
  if (status === 'wrong-service') return 'desktopHostSwitcher.status.wrongService';
  if (status === 'unreachable') return 'desktopHostSwitcher.status.unreachable';
  return 'desktopHostSwitcher.status.unknown';
};

const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

const sshPhaseLabelKey = (phase: DesktopSshInstanceStatus['phase'] | undefined):
  | 'desktopHostSwitcher.sshPhase.ready'
  | 'desktopHostSwitcher.sshPhase.error'
  | 'desktopHostSwitcher.sshPhase.reconnecting'
  | 'desktopHostSwitcher.sshPhase.resolvingConfig'
  | 'desktopHostSwitcher.sshPhase.checkingAuth'
  | 'desktopHostSwitcher.sshPhase.connectingSsh'
  | 'desktopHostSwitcher.sshPhase.probingRemote'
  | 'desktopHostSwitcher.sshPhase.installing'
  | 'desktopHostSwitcher.sshPhase.updating'
  | 'desktopHostSwitcher.sshPhase.detectingServer'
  | 'desktopHostSwitcher.sshPhase.startingServer'
  | 'desktopHostSwitcher.sshPhase.forwardingPorts'
  | 'desktopHostSwitcher.sshPhase.idle' => {
  switch (phase) {
    case 'ready':
      return 'desktopHostSwitcher.sshPhase.ready';
    case 'error':
      return 'desktopHostSwitcher.sshPhase.error';
    case 'degraded':
      return 'desktopHostSwitcher.sshPhase.reconnecting';
    case 'config_resolved':
      return 'desktopHostSwitcher.sshPhase.resolvingConfig';
    case 'auth_check':
      return 'desktopHostSwitcher.sshPhase.checkingAuth';
    case 'master_connecting':
      return 'desktopHostSwitcher.sshPhase.connectingSsh';
    case 'remote_probe':
      return 'desktopHostSwitcher.sshPhase.probingRemote';
    case 'installing':
      return 'desktopHostSwitcher.sshPhase.installing';
    case 'updating':
      return 'desktopHostSwitcher.sshPhase.updating';
    case 'server_detecting':
      return 'desktopHostSwitcher.sshPhase.detectingServer';
    case 'server_starting':
      return 'desktopHostSwitcher.sshPhase.startingServer';
    case 'forwarding':
      return 'desktopHostSwitcher.sshPhase.forwardingPorts';
    default:
      return 'desktopHostSwitcher.sshPhase.idle';
  }
};

const sshPhaseToHostStatus = (
  phase: DesktopSshInstanceStatus['phase'] | undefined,
): HostProbeResult['status'] | null => {
  if (!phase || phase === 'idle') return null;
  if (phase === 'ready') return 'ok';
  if (phase === 'error') return 'unreachable';
  return 'auth';
};

const getSshStatusById = async (): Promise<Record<string, DesktopSshInstanceStatus>> => {
  const statuses = await desktopSshStatus().catch(() => []);
  const next: Record<string, DesktopSshInstanceStatus> = {};
  for (const status of statuses) {
    next[status.id] = status;
  }
  return next;
};

const waitForSshReady = async (
  id: string,
  timeoutMs: number,
  onUpdate: (status: DesktopSshInstanceStatus) => void,
  shouldCancel?: () => boolean,
): Promise<DesktopSshInstanceStatus> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (shouldCancel?.()) {
      throw new Error(SSH_CONNECT_CANCELLED_ERROR);
    }

    const statuses = await desktopSshStatus(id).catch(() => []);
    const status = statuses.find((item) => item.id === id);
    if (status) {
      onUpdate(status);
      if (status.phase === 'ready') {
        return status;
      }
      if (status.phase === 'error') {
        throw new Error(status.detail || 'SSH connection failed');
      }
    }
    await sleep(700);
  }

  if (shouldCancel?.()) {
    throw new Error(SSH_CONNECT_CANCELLED_ERROR);
  }

  throw new Error('Timed out waiting for SSH connection');
};

const buildLocalHost = (localOrigin?: string | null): DesktopHost => ({
  id: LOCAL_HOST_ID,
  label: 'Local',
  url: localOrigin || getLocalOrigin(),
});

const resolveCurrentHost = (hosts: DesktopHost[]) => {
  const currentHref = typeof window === 'undefined' ? '' : window.location.href;
  const localOrigin = hosts.find((host) => host.id === LOCAL_HOST_ID)?.url || getLocalOrigin();
  const runtimeApiBaseUrl = getRuntimeApiBaseUrl();
  const normalizedLocal = normalizeHostUrl(localOrigin) || localOrigin;
  const normalizedCurrent = normalizeHostUrl(currentHref) || currentHref;

  const activeRuntimeKey = getRuntimeKey();
  const activeHost = resolveActiveDesktopHost(hosts, localOrigin, runtimeApiBaseUrl, activeRuntimeKey);

  if (activeHost) {
    if (activeHost.id === LOCAL_HOST_ID) {
      return { id: LOCAL_HOST_ID, label: 'Local', url: normalizedLocal };
    }
    return {
      id: activeHost.id,
      label: activeHost.label,
      url: normalizeHostUrl(activeHost.url) || activeHost.url,
    };
  }

  if (currentHref && locationMatchesHost(currentHref, localOrigin)) {
    return { id: LOCAL_HOST_ID, label: 'Local', url: normalizedLocal };
  }

  const match = hosts.find((h) => {
    return currentHref ? locationMatchesHost(currentHref, h.url) : false;
  });

  if (match) {
    return { id: match.id, label: match.label, url: normalizeHostUrl(match.url) || match.url };
  }

  if (currentHref.startsWith('openchamber-ui://')) {
    return { id: LOCAL_HOST_ID, label: 'Local', url: normalizedLocal };
  }

  return {
    id: 'custom',
    label: redactSensitiveUrl(normalizedCurrent || 'Instance'),
    url: normalizedCurrent,
  };
};

type DesktopHostSwitcherDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  embedded?: boolean;
  onHostSwitched?: () => void;
};

export function DesktopHostSwitcherDialog({
  open,
  onOpenChange,
  embedded = false,
  onHostSwitched,
}: DesktopHostSwitcherDialogProps) {
  const { t } = useI18n();
  const setSettingsDialogOpen = useUIStore((state) => state.setSettingsDialogOpen);
  const setSettingsPage = useUIStore((state) => state.setSettingsPage);

  const [configHosts, setConfigHosts] = React.useState<DesktopHost[]>([]);
  const [defaultHostId, setDefaultHostId] = React.useState<string | null>(null);
  const [statusById, setStatusById] = React.useState<Record<string, HostStatus>>(() => ({ ...lastKnownHostStatuses }));
  React.useEffect(() => {
    Object.assign(lastKnownHostStatuses, statusById);
  }, [statusById]);
  const [isLoading, setIsLoading] = React.useState(false);
  const [isProbing, setIsProbing] = React.useState(false);
  const [isSaving, setIsSaving] = React.useState(false);
  const [switchingHostId, setSwitchingHostId] = React.useState<string | null>(null);
  const [sshHostIds, setSshHostIds] = React.useState<Record<string, true>>({});
  const [sshStatusesById, setSshStatusesById] = React.useState<Record<string, DesktopSshInstanceStatus>>({});
  const [sshSwitchModal, setSshSwitchModal] = React.useState<{
    open: boolean;
    hostId: string | null;
    hostLabel: string;
    phase: DesktopSshInstanceStatus['phase'] | 'idle';
    detail: string | null;
    error: string | null;
  }>({
    open: false,
    hostId: null,
    hostLabel: '',
    phase: 'idle',
    detail: null,
    error: null,
  });
  const [error, setError] = React.useState<string>('');
  const [localOrigin, setLocalOrigin] = React.useState<string>(() => getLocalOrigin());

  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [editLabel, setEditLabel] = React.useState('');
  const [editUrl, setEditUrl] = React.useState('');

  const [runtimeEndpointEpoch, setRuntimeEndpointEpoch] = React.useState(0);
  const sshSwitchTokenRef = React.useRef(0);

  const allHosts = React.useMemo(() => {
    const local = buildLocalHost(localOrigin);
    const normalizedRemote = configHosts.map((h) => ({
      ...h,
      url: normalizeHostUrl(h.url) || h.url,
    }));
    return [local, ...normalizedRemote];
  }, [configHosts, localOrigin]);

  React.useEffect(() => {
    return subscribeRuntimeEndpointChanged(() => setRuntimeEndpointEpoch((epoch) => epoch + 1));
  }, []);

  const current = React.useMemo(() => {
    void runtimeEndpointEpoch;
    return resolveCurrentHost(allHosts);
  }, [allHosts, runtimeEndpointEpoch]);
  const currentDefaultLabel = React.useMemo(() => {
    const id = defaultHostId || LOCAL_HOST_ID;
    return allHosts.find((h) => h.id === id)?.label || t('desktopHostSwitcher.instance.local');
  }, [allHosts, defaultHostId, t]);

  const persist = React.useCallback(async (nextHosts: DesktopHost[], nextDefaultHostId: string | null) => {
    if (!isDesktopShell()) return;
    setIsSaving(true);
    setError('');
    try {
      const remote = nextHosts.filter((h) => h.id !== LOCAL_HOST_ID);
      await desktopHostsSet({ hosts: remote, defaultHostId: nextDefaultHostId });
      setConfigHosts(remote);
      setDefaultHostId(nextDefaultHostId);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('desktopHostSwitcher.error.failedToSave'));
    } finally {
      setIsSaving(false);
    }
  }, [t]);

  const openRemoteInstancesSettings = React.useCallback(() => {
    setSettingsPage('remote-instances');
    setSettingsDialogOpen(true);
    onOpenChange(false);
  }, [onOpenChange, setSettingsDialogOpen, setSettingsPage]);

  const refresh = React.useCallback(async () => {
    if (!isDesktopShell()) return;
    setIsLoading(true);
    setError('');
    try {
      const [cfg, sshCfg, sshStatusMap] = await Promise.all([
        desktopHostsGet(),
        desktopSshInstancesGet().catch(() => ({ instances: [] })),
        getSshStatusById(),
      ]);
      if (cfg.localOrigin) {
        setLocalOrigin(cfg.localOrigin);
      }
      const nextSshHostIds: Record<string, true> = {};
      for (const instance of sshCfg.instances) {
        nextSshHostIds[instance.id] = true;
      }
      setConfigHosts(cfg.hosts || []);
      setDefaultHostId(cfg.defaultHostId ?? null);
      setSshHostIds(nextSshHostIds);
      setSshStatusesById(sshStatusMap);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('desktopHostSwitcher.error.failedToLoad'));
      setConfigHosts([]);
      setDefaultHostId(null);
      setSshHostIds({});
      setSshStatusesById({});
    } finally {
      setIsLoading(false);
    }
  }, [t]);

  const probeAll = React.useCallback(async (hosts: DesktopHost[]) => {
    if (!isDesktopShell()) return;
    if (isElectronShell() && !isDesktopTrustedLocalPage()) return;
    setIsProbing(true);
    try {
      const localClientToken = await getLocalClientToken();
      const results = await Promise.all(
        hosts.map(async (h) => {
          const clientToken = h.id === LOCAL_HOST_ID ? localClientToken : (h.clientToken || '');
          const selection = await probeDesktopHostTransports({ ...h, ...(clientToken ? { clientToken } : {}) });
          return [h.id, { ...selection.probe, ...(selection.transport ? { via: selection.transport.kind } : {}) } satisfies HostStatus] as const;
        })
      );
      const next: Record<string, HostStatus> = {};
      for (const [id, val] of results) {
        next[id] = val;
      }
      setStatusById(next);
    } finally {
      setIsProbing(false);
    }
  }, []);

  React.useEffect(() => {
    if (!open) {
      setEditingId(null);
      setEditLabel('');
      setEditUrl('');
      setSwitchingHostId(null);
      setSshSwitchModal({ open: false, hostId: null, hostLabel: '', phase: 'idle', detail: null, error: null });
      setError('');
      return;
    }
    void refresh();
  }, [open, refresh]);

  React.useEffect(() => {
    if (!open) return;
    void probeAll(allHosts);
  }, [open, allHosts, probeAll]);

  React.useEffect(() => {
    if (!open || !isDesktopShell()) {
      return;
    }
    let cancelled = false;
    const run = async () => {
      const statuses = await getSshStatusById();
      if (!cancelled) {
        setSshStatusesById(statuses);
      }
    };
    void run();
    const interval = window.setInterval(() => {
      // Skip polling when tab is hidden to reduce background work
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
        return;
      }
      void run();
    }, 1_500);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [open]);

  const handleSwitch = React.useCallback(async (host: DesktopHost) => {
    if (isElectronShell() && shouldDelegateDesktopHostActivation(isDesktopLocalOriginActive())) {
      setSwitchingHostId(host.id);
      try {
        await desktopOpenNewWindowForHost(host.id);
        onHostSwitched?.();
      } finally {
        setSwitchingHostId(null);
      }
      return;
    }
    // Encrypted transports are activated in-renderer; managed direct E2EE and
    // explicit Relay remain structurally separate runtime descriptors.
    const activateTransport = (
      transport: NonNullable<Awaited<ReturnType<typeof probeDesktopHostTransports>>['transport']>,
      clientToken: string,
    ): boolean => {
      const options = getDesktopHostRuntimeSwitchOptions(
        { ...host, clientToken: clientToken || undefined },
        transport,
        window.location.origin,
        runtimeKeyForHost(host),
      );
      if (!options) {
        if (transport.kind === 'relay') transport.tunnel?.close();
        return false;
      }
      // Adopt the probe's live relay tunnel before switching so activation does
      // not pay for a second WebSocket connection and E2EE handshake.
      if (transport.kind === 'relay' && transport.tunnel) {
        adoptRelayTunnel(transport.descriptor, transport.tunnel);
      }
      switchRuntimeEndpoint(options);
      if (transport.kind === 'relay') {
        scheduleDesktopHostCandidateRefresh(host.id);
      }
      return true;
    };
    const origin = host.id === LOCAL_HOST_ID ? localOrigin : (normalizeHostUrl(host.url) || '');
    const apiOrigin = host.id === LOCAL_HOST_ID ? localOrigin : (normalizeHostUrl(getDesktopHostApiUrl(host)) || '');
    const encryptedOnly = Boolean(host.relay || host.directE2ee) && !host.apiUrl && host.id !== LOCAL_HOST_ID;
    if (!origin && !encryptedOnly) return;

    if (isElectronShell()) {
      if (!apiOrigin && !host.relay && !host.directE2ee) return;
      setSwitchingHostId(host.id);
      const clientToken = host.id === LOCAL_HOST_ID ? await getLocalClientToken() : (host.clientToken || '');

      // The dropdown already probed every host when it opened — act on that
      // result instead of re-probing (re-probes doubled the switch latency and
      // flashed transient Unreachable states over a known-good host).
      const cached = statusById[host.id];
      if (cached?.status === 'ok' && cached.via === 'direct') {
        const transport = apiOrigin ? { kind: 'direct' as const, url: apiOrigin } : null;
        if (!transport || !activateTransport(transport, clientToken)) {
          setSwitchingHostId(null);
          return;
        }
        onHostSwitched?.();
        setSwitchingHostId(null);
        return;
      }

      // No usable probe result — resolve only the transports explicitly stored
      // for this host. Managed direct E2EE never enters the Relay probe branch;
      // Relay activation retains the probe tunnel for no-second-handshake adoption.
      const selection = await probeDesktopHostTransportsForActivation({ ...host, ...(clientToken ? { clientToken } : {}) });
      const finalStatus: HostStatus = { ...selection.probe, ...(selection.transport ? { via: selection.transport.kind } : {}) };
      setStatusById((prev) => ({ ...prev, [host.id]: finalStatus }));

      if (!selection.transport) {
        toast.error(t('desktopHostSwitcher.toast.instanceUnreachable', { host: redactSensitiveUrl(host.label) }));
        setSwitchingHostId(null);
        return;
      }
      if (!activateTransport(selection.transport, clientToken)) {
        setSwitchingHostId(null);
        return;
      }
      if (selection.lateDirect && selection.directUrl) {
        void selection.lateDirect.then((probe) => {
          if (isBlockedHostStatus(probe.status)) return;
          if (getRuntimeKey() !== runtimeKeyForHost(host)) return;
          switchRuntimeEndpoint({
            apiBaseUrl: selection.directUrl!,
            clientToken: clientToken || null,
            requestHeaders: host.requestHeaders || null,
            runtimeKey: runtimeKeyForHost(host),
          });
        });
      }
      onHostSwitched?.();
      setSwitchingHostId(null);
      return;
    }

    const isSshHost = Boolean(sshHostIds[host.id]);

    if (host.id !== LOCAL_HOST_ID && isSshHost && isDesktopShell()) {
      let existingStatus = sshStatusesById[host.id];
      const latestStatus = await desktopSshStatus(host.id)
        .then((items) => items.find((item) => item.id === host.id) || null)
        .catch(() => null);
      if (latestStatus) {
        existingStatus = latestStatus;
        setSshStatusesById((prev) => ({
          ...prev,
          [host.id]: latestStatus,
        }));
      }

      const existingUrl = normalizeHostUrl(existingStatus?.localUrl || host.url || '');
      if (existingStatus?.phase === 'ready' && existingUrl) {
        const target = toNavigationUrl(existingUrl);
        onHostSwitched?.();
        window.location.assign(target);
        return;
      }

      setSwitchingHostId(host.id);
      const switchToken = sshSwitchTokenRef.current + 1;
      sshSwitchTokenRef.current = switchToken;
      setSshSwitchModal({
        open: true,
        hostId: host.id,
        hostLabel: redactSensitiveUrl(host.label),
        phase: 'master_connecting',
        detail: null,
        error: null,
      });
      try {
        await desktopSshConnect(host.id);
        if (switchToken !== sshSwitchTokenRef.current) {
          return;
        }

        const readyStatus = await waitForSshReady(host.id, SSH_CONNECT_TIMEOUT_MS, (status) => {
          setSshStatusesById((prev) => ({
            ...prev,
            [status.id]: status,
          }));
          setSshSwitchModal((prev) => ({
            ...prev,
            phase: status.phase,
            detail: status.detail || null,
          }));
        }, () => switchToken !== sshSwitchTokenRef.current);

        if (switchToken !== sshSwitchTokenRef.current) {
          return;
        }

        const targetOrigin = normalizeHostUrl(readyStatus.localUrl || '') || origin;
        const target = toNavigationUrl(targetOrigin);
        onHostSwitched?.();
        window.location.assign(target);
        return;
      } catch (err) {
        if (switchToken !== sshSwitchTokenRef.current) {
          return;
        }

        const message = err instanceof Error ? err.message : String(err);
        if (message === SSH_CONNECT_CANCELLED_ERROR) {
          return;
        }

        setSshSwitchModal((prev) => ({
          ...prev,
          error: message,
        }));
        toast.error(t('desktopHostSwitcher.toast.sshFailedToConnect', { host: redactSensitiveUrl(host.label) }), {
          description: message,
        });
        return;
      } finally {
        if (switchToken === sshSwitchTokenRef.current) {
          setSwitchingHostId(null);
        }
      }
    }

    if (host.id !== LOCAL_HOST_ID && isDesktopShell()) {
      setSwitchingHostId(host.id);
      const probe = await desktopHostProbe(origin, { clientToken: host.clientToken || null, requestHeaders: host.requestHeaders || null }).catch((): HostProbeResult => ({ status: 'unreachable', latencyMs: 0 }));
      setStatusById((prev) => ({
        ...prev,
        [host.id]: { status: probe.status, latencyMs: probe.latencyMs },
      }));

      if (isBlockedHostStatus(probe.status)) {
        toast.error(t('desktopHostSwitcher.toast.instanceUnreachable', { host: redactSensitiveUrl(host.label) }));
        setSwitchingHostId(null);
        return;
      }
    }

    const target = toNavigationUrl(origin);
    onHostSwitched?.();

    try {
      window.location.assign(target);
    } catch {
      window.location.href = target;
    }
  }, [localOrigin, onHostSwitched, sshHostIds, sshStatusesById, statusById, t]);

  const cancelEdit = React.useCallback(() => {
    setEditingId(null);
    setEditLabel('');
    setEditUrl('');
  }, []);

  const stopDropdownTypeahead = React.useCallback((event: React.KeyboardEvent<HTMLInputElement>) => {
    event.stopPropagation();
  }, []);

  const commitEdit = React.useCallback(async () => {
    if (!editingId) return;
    if (editingId === LOCAL_HOST_ID) {
      cancelEdit();
      return;
    }

    const resolved = resolveDesktopHostUrl(editUrl);
    if (!resolved) {
      setError(t('desktopHostSwitcher.error.invalidUrl'));
      return;
    }
    const url = resolved.persistedUrl;

    const label = (editLabel || redactSensitiveUrl(url)).trim();
    const nextHosts = configHosts.map((h) => (h.id === editingId ? { ...h, label, url, apiUrl: url } : h));
    await persist(nextHosts, defaultHostId);
    cancelEdit();
    if (resolved.redeemUrl) {
      window.location.assign(resolved.redeemUrl);
    }
  }, [cancelEdit, configHosts, defaultHostId, editLabel, editUrl, editingId, persist, t]);

  const setDefault = React.useCallback(async (id: string) => {
    const next = id === LOCAL_HOST_ID ? LOCAL_HOST_ID : id;
    await persist(configHosts, next);
  }, [configHosts, persist]);

  const openInNewWindow = React.useCallback((host: DesktopHost) => {
    const reportFailure = (err: unknown) => {
      toast.error(t('desktopHostSwitcher.error.failedToOpenNewWindow'), {
        description: err instanceof Error ? err.message : String(err),
      });
    };
    if (isElectronShell() && shouldDelegateDesktopHostActivation(isDesktopLocalOriginActive())) {
      desktopOpenNewWindowForHost(host.id).catch(reportFailure);
      return;
    }
    // Relay-capable hosts can't be expressed as a fixed window URL — the new
    // window boots the local UI and picks direct-vs-tunnel itself.
    if ((host.relay || host.directE2ee) && host.id !== LOCAL_HOST_ID) {
      desktopOpenNewWindowForHost(host.id).catch(reportFailure);
      return;
    }
    const origin = host.id === LOCAL_HOST_ID ? localOrigin : getDesktopHostApiUrl(host);
    if (!origin) return;
    const target = toNavigationUrl(origin);
    desktopOpenNewWindowAtUrl(target, { clientToken: host.clientToken || null, requestHeaders: host.requestHeaders || null }).catch(reportFailure);
  }, [localOrigin, t]);

  const switchToLocal = React.useCallback(async () => {
    sshSwitchTokenRef.current += 1;
    setSwitchingHostId(null);
    setSshSwitchModal((prev) => ({
      ...prev,
      open: false,
      hostId: null,
      error: null,
      detail: null,
      phase: 'idle',
    }));
    const localTarget = toNavigationUrl(localOrigin);
    if (isElectronShell()) {
      const clientToken = await getLocalClientToken();
      switchRuntimeEndpoint({ apiBaseUrl: localOrigin, clientToken: clientToken || null, runtimeKey: 'local' });
      onHostSwitched?.();
      return;
    }
    onHostSwitched?.();
    window.location.assign(localTarget);
  }, [localOrigin, onHostSwitched]);

  const cancelSshSwitch = React.useCallback(async () => {
    const hostId = sshSwitchModal.hostId || switchingHostId;
    sshSwitchTokenRef.current += 1;
    setSwitchingHostId(null);
    setSshSwitchModal({
      open: false,
      hostId: null,
      hostLabel: '',
      phase: 'idle',
      detail: null,
      error: null,
    });

    if (!hostId || hostId === LOCAL_HOST_ID || !isDesktopShell()) {
      return;
    }

    await desktopSshDisconnect(hostId).catch(() => {});
  }, [sshSwitchModal.hostId, switchingHostId]);

  const retrySshSwitch = React.useCallback(() => {
    const hostId = sshSwitchModal.hostId;
    if (!hostId) return;
    const host = allHosts.find((item) => item.id === hostId);
    if (!host) return;
    void handleSwitch(host);
  }, [allHosts, handleSwitch, sshSwitchModal.hostId]);

  const connectSshHostInPlace = React.useCallback(async (host: DesktopHost) => {
    if (!isDesktopShell()) return;
    setSwitchingHostId(host.id);
    try {
      await desktopSshConnect(host.id);
      const readyStatus = await waitForSshReady(host.id, SSH_CONNECT_TIMEOUT_MS, (status) => {
        setSshStatusesById((prev) => ({
          ...prev,
          [status.id]: status,
        }));
      });
      if (readyStatus.phase === 'ready') {
        toast.success(t('desktopHostSwitcher.toast.sshConnected', { host: redactSensitiveUrl(host.label) }));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message !== SSH_CONNECT_CANCELLED_ERROR) {
        toast.error(t('desktopHostSwitcher.toast.sshFailedToConnect', { host: redactSensitiveUrl(host.label) }), {
          description: message,
        });
      }
    } finally {
      setSwitchingHostId(null);
    }
  }, [t]);

  if (!isDesktopShell()) {
    return null;
  }

  const desktopAvailable = isDesktopShell();

  const content = (
    <>
      {embedded ? (
        <div className="flex-shrink-0 border-b border-[var(--interactive-border)] px-3 py-2">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0 flex items-baseline gap-1.5 typography-ui-label">
              <span className="font-medium text-foreground">{t('desktopHostSwitcher.header.current')}</span>
              <span className="max-w-[9rem] truncate text-muted-foreground">{redactSensitiveUrl(current.label)}</span>
              <span className="text-muted-foreground/50">•</span>
              <span className="font-medium text-foreground">{t('desktopHostSwitcher.header.default')}</span>
              <span className="max-w-[9rem] truncate text-muted-foreground">{redactSensitiveUrl(currentDefaultLabel)}</span>
            </div>
            <button
              type="button"
              className={cn(
                'inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors',
                'hover:text-foreground hover:bg-interactive-hover',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary'
              )}
              onClick={() => void probeAll(allHosts)}
              disabled={!desktopAvailable || isLoading || isProbing}
              aria-label={t('desktopHostSwitcher.actions.refreshInstancesAria')}
            >
              <Icon name="refresh" className={cn('h-4 w-4', isProbing && 'animate-spin')} />
            </button>
          </div>
        </div>
      ) : (
        <DialogHeader className="flex-shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <Icon name="server" className="h-5 w-5" />
            {t('desktopHostSwitcher.title')}
          </DialogTitle>
          <DialogDescription>
            {t('desktopHostSwitcher.description')}
          </DialogDescription>
        </DialogHeader>
      )}

      {!embedded && (
        <div className="flex items-center justify-between gap-2 flex-shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className="typography-meta text-muted-foreground">{t('desktopHostSwitcher.header.currentColon')}</span>
            <span className="typography-ui-label text-foreground truncate">{redactSensitiveUrl(current.label)}</span>
            <span className="typography-meta text-muted-foreground">{t('desktopHostSwitcher.header.currentDefaultColon')}</span>
            <span className="typography-ui-label text-foreground truncate">{redactSensitiveUrl(currentDefaultLabel)}</span>
          </div>
          <div className="flex items-center gap-1">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => void probeAll(allHosts)}
              disabled={!desktopAvailable || isLoading || isProbing}
            >
              <Icon name="refresh" className={cn('h-4 w-4', isProbing && 'animate-spin')} />
              {t('desktopHostSwitcher.actions.refresh')}
            </Button>
          </div>
        </div>
      )}

        {!desktopAvailable && (
          <div className="flex-shrink-0 rounded-lg border border-border/50 bg-muted/20 p-3">
            <div className="typography-meta text-muted-foreground">
              {t('desktopHostSwitcher.state.limitedOnPage')}
            </div>
          </div>
        )}

        <div className="flex-1 min-h-0 overflow-y-auto">
          <div className={cn('space-y-1', embedded && 'space-y-1.5 px-3 py-1')}>
            {isLoading ? (
              <div className="px-2 py-2 text-muted-foreground text-sm">{t('desktopHostSwitcher.state.loading')}</div>
            ) : (
              allHosts.map((host) => {
                const isLocal = host.id === LOCAL_HOST_ID;
                const isSsh = Boolean(sshHostIds[host.id]);
                const isActive = host.id === current.id;
                const isDefault = (defaultHostId || LOCAL_HOST_ID) === host.id;
                const status = statusById[host.id] || null;
                const sshStatus = sshStatusesById[host.id] || null;
                // While a probe runs, keep showing the last known result (quiet
                // refresh); only fall back to "Checking" when there has never
                // been one. "Unknown" is never shown — an unprobed host is by
                // definition being checked.
                const statusKind: HostDisplayStatus = isSsh
                  ? sshPhaseToHostStatus(sshStatus?.phase)
                  : (status?.status ?? 'checking');
                const isEditing = editingId === host.id;
                const effectiveUrl = isLocal ? localOrigin : (normalizeHostUrl(host.url) || host.url);
                const displayLabel = host.id === LOCAL_HOST_ID
                  ? t('desktopHostSwitcher.instance.local')
                  : redactSensitiveUrl(host.label);
                const transportLabelKey = hostTransportLabelKey(host);
                const displayUrl = transportLabelKey && !host.apiUrl
                  ? t(transportLabelKey)
                  : redactSensitiveUrl(effectiveUrl);

                return (
                  <div
                    key={host.id}
                    className={cn(
                      'group flex items-center gap-2 px-2.5 py-2 rounded-md overflow-hidden',
                      // Dropdown (embedded): mobile-style card per host; the
                      // active host reads as selected, not just labelled.
                      embedded && 'rounded-xl bg-[var(--surface-muted)] px-3 py-2.5',
                      embedded && isActive && 'bg-[var(--interactive-selection)]/25',
                      isEditing ? 'bg-interactive-hover/20' : 'hover:bg-interactive-hover/30'
                    )}
                  >
                    <button
                      type="button"
                      className={cn(
                        'flex items-center gap-2 flex-1 min-w-0 text-left',
                        isEditing && 'pointer-events-none opacity-70'
                      )}
                      onClick={() => void handleSwitch(host)}
                      disabled={switchingHostId === host.id}
                      aria-label={t('desktopHostSwitcher.actions.switchToAria', { instance: displayLabel })}
                    >
                      <span className={cn('h-2 w-2 rounded-full flex-shrink-0', statusDotClass(statusKind))} />
                      {/* Same reading order as the settings device list: name +
                          badges on the first line, a toned status line under it,
                          then the address. */}
                      <div className="flex-1 min-w-0 space-y-0.5">
                        <div className="flex min-w-0 items-center gap-1.5">
                          <span className="typography-ui-label font-medium truncate text-foreground">
                            {displayLabel}
                          </span>
                          {isActive && (
                            <span className="typography-micro flex-shrink-0 text-muted-foreground bg-muted px-1 rounded leading-none pb-px border border-border/50">
                              {t('desktopHostSwitcher.header.current')}
                            </span>
                          )}
                          {isSsh && (
                            <span className="typography-micro flex-shrink-0 px-1 rounded leading-none pb-px text-[var(--status-info)] bg-[var(--status-info)]/10">
                              SSH
                            </span>
                          )}
                        </div>
                        <div className={cn('typography-micro truncate', statusTextClass(statusKind))}>
                          {isSsh ? t(sshPhaseLabelKey(sshStatus?.phase)) : t(statusLabelKey(statusKind))}
                          {!isSsh && statusKind === 'ok' && typeof status?.latencyMs === 'number'
                            ? t('desktopHostSwitcher.status.ping', { ms: Math.max(0, Math.round(status.latencyMs)) })
                            : ''}
                          {!isSsh && statusKind === 'ok' && transportLabelKey ? ` · ${t(transportLabelKey)}` : ''}
                        </div>
                        <div className="typography-micro text-muted-foreground/70 truncate font-mono">
                          {displayUrl}
                        </div>
                      </div>
                    </button>

                    <div className="flex items-center gap-2 flex-shrink-0">
                      {isSsh && !isLocal && (
                        (sshStatus?.phase === 'idle' || !sshStatus?.phase) ? (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="h-8 px-2.5"
                            disabled={switchingHostId === host.id}
                            onClick={(e) => {
                              e.stopPropagation();
                              void connectSshHostInPlace(host);
                            }}
                          >
                            {switchingHostId === host.id ? <Icon name="loader-4" className="h-3.5 w-3.5 animate-spin" /> : <Icon name="plug-2" className="h-3.5 w-3.5" />}
                            {t('desktopHostSwitcher.actions.connect')}
                          </Button>
                        ) : (
                          <div
                            className="h-8 w-8 opacity-0 pointer-events-none"
                            aria-hidden="true"
                          />
                        )
                      )}

                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            className={cn(
                              'h-8 w-8 rounded-md inline-flex items-center justify-center hover:bg-interactive-hover transition-colors',
                              isDefault
                                ? 'text-primary hover:text-primary/80'
                                : 'text-muted-foreground/60 hover:text-primary/80',
                            )}
                            onClick={() => void setDefault(host.id)}
                            aria-label={isDefault ? t('desktopHostSwitcher.actions.defaultInstanceAria') : t('desktopHostSwitcher.actions.setAsDefaultAria')}
                            disabled={isSaving || (!isDefault && isBlockedDisplayStatus(statusKind))}
                          >
                            {isDefault ? <Icon name="star-fill" className="h-4 w-4" /> : <Icon name="star" className="h-4 w-4" />}
                          </button>
                        </TooltipTrigger>
                        <TooltipContent sideOffset={6}>
                          {isDefault ? t('desktopHostSwitcher.header.default') : t('desktopHostSwitcher.actions.setAsDefault')}
                        </TooltipContent>
                      </Tooltip>

                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                              className={cn(
                                'h-8 w-8 rounded-md inline-flex items-center justify-center hover:bg-interactive-hover transition-colors',
                                isBlockedDisplayStatus(statusKind)
                                  ? 'text-muted-foreground/30 cursor-not-allowed'
                                  : 'text-muted-foreground/60 hover:text-foreground',
                              )}
                            onClick={(e) => {
                              e.stopPropagation();
                              openInNewWindow(host);
                            }}
                            disabled={isBlockedDisplayStatus(statusKind)}
                            aria-label={t('desktopHostSwitcher.actions.openInNewWindowAria')}
                          >
                            <Icon name="window" className="h-4 w-4" />
                          </button>
                        </TooltipTrigger>
                        <TooltipContent sideOffset={6}>
                          {isBlockedDisplayStatus(statusKind)
                            ? t('desktopHostSwitcher.state.instanceUnreachable')
                            : t('desktopHostSwitcher.actions.openInNewWindow')}
                        </TooltipContent>
                      </Tooltip>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {desktopAvailable && editingId && editingId !== LOCAL_HOST_ID && (
          <div className="flex-shrink-0 rounded-lg border border-border/50 bg-muted/20 p-3">
            <div className="flex items-center justify-between gap-2">
              <div className="typography-ui-label font-medium text-foreground">{t('desktopHostSwitcher.edit.title')}</div>
              <div className="flex items-center gap-2">
                <Button type="button" variant="outline" size="sm" onClick={cancelEdit} disabled={isSaving}>
                  {t('desktopHostSwitcher.actions.cancel')}
                </Button>
                <Button type="button" size="sm" onClick={() => void commitEdit()} disabled={isSaving}>
                  {isSaving ? <Icon name="loader-4" className="h-4 w-4 animate-spin" /> : null}
                  {t('desktopHostSwitcher.actions.save')}
                </Button>
              </div>
            </div>
            <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
              <Input
                value={editLabel}
                onChange={(e) => setEditLabel(e.target.value)}
                onKeyDown={stopDropdownTypeahead}
                placeholder={t('desktopHostSwitcher.field.labelPlaceholder')}
                disabled={isSaving}
              />
              <Input
                value={editUrl}
                onChange={(e) => setEditUrl(e.target.value)}
                onKeyDown={stopDropdownTypeahead}
                placeholder={t('desktopHostSwitcher.field.urlPlaceholder')}
                disabled={isSaving}
              />
            </div>
          </div>
        )}

        <div className="flex-shrink-0 border-t border-[var(--interactive-border)]">
          <button
            type="button"
            className="w-full flex items-center gap-2 px-2 py-2 text-left text-muted-foreground hover:text-foreground hover:bg-interactive-hover/30 transition-colors"
            onClick={openRemoteInstancesSettings}
          >
            <Icon name="add" className="h-4 w-4" />
            <span className="typography-ui-label">{t('desktopHostSwitcher.actions.addInstance')}</span>
          </button>
        </div>

        {error && (
          <div className="flex-shrink-0 typography-meta text-status-error">{error}</div>
        )}
    </>
  );

  const sshSwitchDialog = (
    <Dialog
      open={sshSwitchModal.open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && switchingHostId) {
          void cancelSshSwitch();
          return;
        }
        setSshSwitchModal((prev) => ({
          ...prev,
          open: nextOpen,
          ...(nextOpen ? {} : { hostId: null, error: null, detail: null, phase: 'idle' as const }),
        }));
      }}
    >
      <DialogContent className="w-[min(28rem,calc(100vw-2rem))] max-w-none">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Icon name="loader-4" className={cn('h-4 w-4', !sshSwitchModal.error && 'animate-spin')} />
            {t('desktopHostSwitcher.ssh.connectingTo', { host: sshSwitchModal.hostLabel || t('desktopHostSwitcher.ssh.instanceFallback') })}
          </DialogTitle>
          <DialogDescription>
            {sshSwitchModal.error
              ? sshSwitchModal.error
              : sshSwitchModal.detail || t(sshPhaseLabelKey(sshSwitchModal.phase))}
          </DialogDescription>
        </DialogHeader>
        {sshSwitchModal.error ? (
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void switchToLocal()}
            >
              {t('desktopHostSwitcher.actions.switchToLocal')}
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={retrySshSwitch}
              disabled={!sshSwitchModal.hostId}
            >
              {t('desktopHostSwitcher.actions.retry')}
            </Button>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );

  if (embedded) {
    return (
      <>
        <div className="w-full max-h-[70vh] flex flex-col overflow-hidden gap-2">
          {content}
        </div>
        {sshSwitchDialog}
      </>
    );
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="w-[min(42rem,calc(100vw-2rem))] max-w-none max-h-[70vh] flex flex-col overflow-hidden gap-3">
          {content}
        </DialogContent>
      </Dialog>
      {sshSwitchDialog}
    </>
  );
}

export function DesktopHostSwitcherInline() {
  const [open, setOpen] = React.useState(false);
  const { t } = useI18n();

  if (!isDesktopShell()) {
    return null;
  }

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        data-oc-host-switcher
        className="w-full justify-center"
        onClick={() => setOpen(true)}
      >
        <Icon name="server" className="h-4 w-4" />
        {t('desktopHostSwitcher.actions.switchInstance')}
      </Button>
      <DesktopHostSwitcherDialog open={open} onOpenChange={setOpen} />
    </>
  );
}
