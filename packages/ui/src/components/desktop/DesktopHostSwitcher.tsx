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
import { isElectronShell, isDesktopShell } from '@/lib/desktop';
import { Icon } from "@/components/icon/Icon";
import { Spinner } from "@/components/ui/spinner";
import { useUIStore } from '@/stores/useUIStore';
import { useConfigStore } from '@/stores/useConfigStore';
import { useI18n } from '@/lib/i18n';
import {
  desktopHostProbe,
  desktopHostsGet,
  desktopHostsSet,
  desktopLocalClientTokenGet,
  desktopOpenNewWindowAtUrl,
  desktopOpenNewWindowForHost,
  desktopSwitchToLocal,
  getDesktopHostApiUrl,
  normalizeHostUrl,
  probeRelayDesktopHost,
  redactSensitiveUrl,
  resolveDesktopHostUrl,
  type DesktopHost,
  type HostProbeResult,
} from '@/lib/desktopHosts';
import {
  LOCAL_HOST_ID,
  getLocalDesktopOrigin,
  resolveCurrentDesktopHost,
  runtimeKeyForDesktopHost,
  withLocalDesktopHost,
} from '@/lib/desktopCurrentHost';
import {
  getDesktopHostStatusSnapshot,
  isDesktopHostStatusPending,
  probeDesktopHosts,
  setDesktopHostStatus,
  pruneDesktopHostStatuses,
  subscribeDesktopHostStatuses,
  type DesktopHostStatus,
} from '@/lib/desktopHostStatus';
import { scheduleDesktopHostCandidateRefresh } from '@/lib/desktopRelayRestore';
import { adoptRelayTunnel } from '@/lib/relay/runtime-tunnel';
import { createRelayTunnelClient } from '@/lib/relay/tunnel-client';
import { subscribeRuntimeEndpointChanged, switchRuntimeEndpoint } from '@/lib/runtime-switch';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { useHostSwitcherRechecks } from '@/hooks/useHostSwitcherRechecks';
import {
  desktopSshConnect,
  desktopSshDisconnect,
  desktopSshInstancesGet,
  desktopSshStatus,
  type DesktopSshInstanceStatus,
} from '@/lib/desktopSsh';
import {
  connectDesktopSshHost,
  SSH_CONNECT_CANCELLED_ERROR,
  SSH_CONNECT_TIMEOUT_MS,
  waitForSshReady,
} from './desktopSshConnection';
import { finishSshWindowConnect, finishWindowOpen, hasPendingSshWindowConnect, isWindowOpenPending, startWindowOpen, usePendingWindowOpens } from './desktopWindowOpens';

type HostStatus = DesktopHostStatus;

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
  if (status === 'relay-limit') return 'bg-status-error';
  if (status === 'checking') return 'bg-status-info';
  return 'bg-muted-foreground/40';
};

const statusTextClass = (status: HostDisplayStatus): string => {
  if (status === 'ok') return 'text-[var(--status-success)]';
  if (status === 'auth' || status === 'update-recommended') return 'text-[var(--status-warning)]';
  if (status === 'incompatible' || status === 'wrong-service' || status === 'unreachable' || status === 'relay-limit') return 'text-[var(--status-error)]';
  return 'text-muted-foreground';
};

const isBlockedHostStatus = (status: HostProbeResult['status'] | null): boolean => {
  return status === 'unreachable' || status === 'wrong-service' || status === 'incompatible' || status === 'relay-limit';
};

const isBlockedDisplayStatus = (status: HostDisplayStatus): boolean => {
  return status === 'unreachable' || status === 'wrong-service' || status === 'incompatible' || status === 'relay-limit';
};

const statusLabelKey = (status: HostDisplayStatus):
  | 'desktopHostSwitcher.status.connected'
  | 'desktopHostSwitcher.status.authRequired'
  | 'desktopHostSwitcher.status.checking'
  | 'desktopHostSwitcher.status.updateRecommended'
  | 'desktopHostSwitcher.status.incompatible'
  | 'desktopHostSwitcher.status.wrongService'
  | 'desktopHostSwitcher.status.unreachable'
  | 'desktopHostSwitcher.status.relayLimit'
  | 'desktopHostSwitcher.status.unknown' => {
  if (status === 'ok') return 'desktopHostSwitcher.status.connected';
  if (status === 'auth') return 'desktopHostSwitcher.status.authRequired';
  if (status === 'checking') return 'desktopHostSwitcher.status.checking';
  if (status === 'update-recommended') return 'desktopHostSwitcher.status.updateRecommended';
  if (status === 'incompatible') return 'desktopHostSwitcher.status.incompatible';
  if (status === 'wrong-service') return 'desktopHostSwitcher.status.wrongService';
  if (status === 'unreachable') return 'desktopHostSwitcher.status.unreachable';
  if (status === 'relay-limit') return 'desktopHostSwitcher.status.relayLimit';
  return 'desktopHostSwitcher.status.unknown';
};

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
  const isRuntimeConnected = useConfigStore((state) => state.isConnected);

  const [configHosts, setConfigHosts] = React.useState<DesktopHost[]>([]);
  const [defaultHostId, setDefaultHostId] = React.useState<string | null>(null);
  const statusSnapshot = React.useSyncExternalStore(subscribeDesktopHostStatuses, getDesktopHostStatusSnapshot, getDesktopHostStatusSnapshot);
  const statusById = statusSnapshot.byHostId;
  const isProbing = statusSnapshot.isProbing;
  const [isLoading, setIsLoading] = React.useState(false);
  const [isSaving, setIsSaving] = React.useState(false);
  const [switchingHostId, setSwitchingHostId] = React.useState<string | null>(null);
  const openingHostIds = usePendingWindowOpens(setConfigHosts);
  const sshWindowConnectPending = hasPendingSshWindowConnect(openingHostIds);
  const [sshHostIds, setSshHostIds] = React.useState<Record<string, true>>({});
  const [sshStatusesById, setSshStatusesById] = React.useState<Record<string, DesktopSshInstanceStatus>>({});
  const [switchModal, setSwitchModal] = React.useState<{
    open: boolean;
    kind: 'ssh' | 'check';
    hostId: string | null;
    hostLabel: string;
    phase: DesktopSshInstanceStatus['phase'] | 'idle';
    detail: string | null;
    error: string | null;
  }>({
    open: false,
    kind: 'ssh',
    hostId: null,
    hostLabel: '',
    phase: 'idle',
    detail: null,
    error: null,
  });
  const [error, setError] = React.useState<string>('');
  const [localOrigin, setLocalOrigin] = React.useState<string>(() => getLocalDesktopOrigin());

  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [editLabel, setEditLabel] = React.useState('');
  const [editUrl, setEditUrl] = React.useState('');

  const [runtimeEndpointEpoch, setRuntimeEndpointEpoch] = React.useState(0);
  const switchTokenRef = React.useRef(0);
  const selectionTokenRef = React.useRef(0);
  React.useEffect(() => () => {
    selectionTokenRef.current += 1;
    switchTokenRef.current += 1;
  }, []);

  const allHosts = React.useMemo(() => {
    const normalizedRemote = configHosts.map((h) => ({
      ...h,
      url: normalizeHostUrl(h.url) || h.url,
    }));
    return withLocalDesktopHost(normalizedRemote, localOrigin);
  }, [configHosts, localOrigin]);

  React.useEffect(() => {
    return subscribeRuntimeEndpointChanged(() => setRuntimeEndpointEpoch((epoch) => epoch + 1));
  }, []);

  const current = React.useMemo(() => {
    void runtimeEndpointEpoch;
    return resolveCurrentDesktopHost(allHosts);
  }, [allHosts, runtimeEndpointEpoch]);
  const currentDefaultLabel = React.useMemo(() => {
    const id = defaultHostId || LOCAL_HOST_ID;
    return allHosts.find((h) => h.id === id)?.label ?? null;
  }, [allHosts, defaultHostId]);

  const persist = React.useCallback(async (nextHosts: DesktopHost[], nextDefaultHostId: string | null) => {
    if (!isDesktopShell()) return;
    if (hasPendingSshWindowConnect()) return;
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
      pruneDesktopHostStatuses((cfg.hosts || []).map((host) => host.id));
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
    await probeDesktopHosts(hosts);
  }, []);

  React.useEffect(() => {
    if (!open) {
      selectionTokenRef.current += 1;
      switchTokenRef.current += 1;
      setEditingId(null);
      setEditLabel('');
      setEditUrl('');
      setSwitchingHostId(null);
      setSwitchModal({ open: false, kind: 'ssh', hostId: null, hostLabel: '', phase: 'idle', detail: null, error: null });
      setError('');
      return;
    }
    void refresh();
  }, [open, refresh]);

  React.useEffect(() => {
    if (!open) return;
    void probeAll(allHosts);
  }, [open, allHosts, probeAll]);

  const plainHosts = React.useMemo(() => allHosts.filter((host) => !sshHostIds[host.id] && !host.relay), [allHosts, sshHostIds]);
  const pollSshStatuses = React.useCallback(async () => setSshStatusesById(await getSshStatusById()), []);
  const rechecking = open && isDesktopShell();
  useHostSwitcherRechecks(rechecking ? plainHosts : null, rechecking ? pollSshStatuses : null);

  const connectSshHost = React.useCallback((host: DesktopHost) => connectDesktopSshHost(host, {
    ready: sshStatusesById[host.id]?.phase === 'ready',
    onStatus: (status) => setSshStatusesById((prev) => ({ ...prev, [status.id]: status })),
  }), [sshStatusesById]);

  const handleSwitch = React.useCallback(async (selectedHost: DesktopHost) => {
    const selectionToken = ++selectionTokenRef.current;
    switchTokenRef.current += 1;
    let host = selectedHost;
    const activateRelay = (relay: NonNullable<DesktopHost['relay']>, liveTunnel?: ReturnType<typeof createRelayTunnelClient>) => {
      if (liveTunnel) {
        adoptRelayTunnel({ relayUrl: relay.relayUrl, serverId: relay.serverId, hostEncPubJwk: relay.hostEncPubJwk }, liveTunnel);
      }
      switchRuntimeEndpoint({
        apiBaseUrl: typeof window !== 'undefined' ? window.location.origin : '',
        clientToken: host.clientToken || null,
        runtimeKey: runtimeKeyForDesktopHost(host),
        relay,
      });
      scheduleDesktopHostCandidateRefresh(host.id);
    };

    if (isElectronShell() && host.id !== LOCAL_HOST_ID && sshHostIds[host.id]) {
      setSwitchingHostId(host.id);
      try {
        const connectedHost = await connectSshHost(host);
        if (selectionToken !== selectionTokenRef.current) return;
        host = connectedHost;
      } catch (err) {
        if (selectionToken !== selectionTokenRef.current) return;
        const message = err instanceof Error ? err.message : String(err);
        if (message !== SSH_CONNECT_CANCELLED_ERROR) {
          toast.error(t('desktopHostSwitcher.toast.sshFailedToConnect', { host: redactSensitiveUrl(host.label) }), {
            description: message,
          });
        }
        setSwitchingHostId(null);
        return;
      }
    }

    const origin = host.id === LOCAL_HOST_ID ? localOrigin : (normalizeHostUrl(host.url) || '');
    const apiOrigin = host.id === LOCAL_HOST_ID ? localOrigin : (normalizeHostUrl(getDesktopHostApiUrl(host)) || '');
    const sshForwarded = host.sshForwarded === true || (
      sshStatusesById[host.id]?.phase === 'ready' && sshStatusesById[host.id]?.localUrl === apiOrigin
    );
    const relayOnly = Boolean(host.relay) && !origin && host.id !== LOCAL_HOST_ID;
    if (!origin && !relayOnly) {
      setSwitchingHostId(null);
      return;
    }

    if (isElectronShell()) {
      if (!apiOrigin && !host.relay) {
        setSwitchingHostId(null);
        return;
      }
      setSwitchingHostId(host.id);
      if (host.id === LOCAL_HOST_ID && await desktopSwitchToLocal()) {
        onHostSwitched?.();
        setSwitchingHostId(null);
        return;
      }
      const sshJustConnected = host !== selectedHost;
      const clientToken = host.id === LOCAL_HOST_ID ? await getLocalClientToken() : (host.clientToken || '');

      const answersNow = host.id === LOCAL_HOST_ID || (host.id === current.id && isRuntimeConnected);
      const recheck = sshJustConnected || (!answersNow && isDesktopHostStatusPending(host.id));
      const cached = recheck ? undefined : statusById[host.id];
      if (cached?.status === 'ok') {
        if (cached.via === 'relay' && host.relay) {
          activateRelay(host.relay);
        } else if (apiOrigin) {
          switchRuntimeEndpoint({ apiBaseUrl: apiOrigin, clientToken: clientToken || null, requestHeaders: host.requestHeaders || null, runtimeKey: runtimeKeyForDesktopHost(host), sshForwarded });
        } else if (host.relay) {
          activateRelay(host.relay);
        }
        setSwitchModal((prev) => ({ ...prev, open: false, hostId: null }));
        onHostSwitched?.();
        setSwitchingHostId(null);
        return;
      }

      const switchToken = switchTokenRef.current + 1;
      switchTokenRef.current = switchToken;
      setSwitchModal({
        open: true,
        kind: 'check',
        hostId: host.id,
        hostLabel: redactSensitiveUrl(host.label),
        phase: 'idle',
        detail: null,
        error: null,
      });
      let finalStatus: HostStatus = { status: 'unreachable', latencyMs: 0 };
      let transport: 'direct' | 'relay' | null = null;
      if (apiOrigin) {
        const probe = await desktopHostProbe(apiOrigin, {
          clientToken: clientToken || null,
          requestHeaders: host.requestHeaders || null,
          expectedServerId: host.relay?.serverId ?? null,
        }).catch((): HostProbeResult => ({ status: 'unreachable', latencyMs: 0 }));
        finalStatus = { status: probe.status, latencyMs: probe.latencyMs };
        if (!isBlockedHostStatus(probe.status)) transport = 'direct';
      }
      let relayProbeTunnel: ReturnType<typeof createRelayTunnelClient> | undefined;
      if (!transport && host.relay) {
        if (switchToken !== switchTokenRef.current) return;
        const probe = await probeRelayDesktopHost(host.relay, { keepTunnel: true, clientToken: clientToken || null, requestHeaders: host.requestHeaders || null })
          .catch((): HostProbeResult => ({ status: 'unreachable', latencyMs: 0 }));
        if (probe.status === 'ok') {
          finalStatus = { status: probe.status, latencyMs: probe.latencyMs, via: 'relay' };
          transport = 'relay';
          relayProbeTunnel = 'tunnel' in probe ? probe.tunnel : undefined;
        } else if (probe.status === 'relay-limit') {
          finalStatus = { status: probe.status, latencyMs: 0 };
        }
      }
      setDesktopHostStatus(host.id, finalStatus);

      if (switchToken !== switchTokenRef.current) {
        relayProbeTunnel?.close();
        return;
      }
      setSwitchingHostId(null);
      if (!transport) {
        const message = t(
          finalStatus.status === 'relay-limit' ? 'desktopHostSwitcher.toast.relayLimit' : 'desktopHostSwitcher.toast.instanceUnreachable',
          { host: redactSensitiveUrl(host.label) },
        );
        setSwitchModal((prev) => ({ ...prev, error: message }));
        toast.error(message);
        return;
      }
      setSwitchModal((prev) => ({ ...prev, open: false, hostId: null }));
      if (transport === 'relay' && host.relay) {
        activateRelay(host.relay, relayProbeTunnel);
      } else {
        switchRuntimeEndpoint({ apiBaseUrl: apiOrigin, clientToken: clientToken || null, requestHeaders: host.requestHeaders || null, runtimeKey: runtimeKeyForDesktopHost(host), sshForwarded });
      }
      onHostSwitched?.();
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
      const switchToken = switchTokenRef.current + 1;
      switchTokenRef.current = switchToken;
      setSwitchModal({
        open: true,
        kind: 'ssh',
        hostId: host.id,
        hostLabel: redactSensitiveUrl(host.label),
        phase: 'master_connecting',
        detail: null,
        error: null,
      });
      try {
        await desktopSshConnect(host.id);
        if (switchToken !== switchTokenRef.current) {
          return;
        }

        const readyStatus = await waitForSshReady(host.id, SSH_CONNECT_TIMEOUT_MS, (status) => {
          setSshStatusesById((prev) => ({
            ...prev,
            [status.id]: status,
          }));
          setSwitchModal((prev) => ({
            ...prev,
            phase: status.phase,
            detail: status.detail || null,
          }));
        }, () => switchToken !== switchTokenRef.current);

        if (switchToken !== switchTokenRef.current) {
          return;
        }

        const targetOrigin = normalizeHostUrl(readyStatus.localUrl || '') || origin;
        const target = toNavigationUrl(targetOrigin);
        onHostSwitched?.();
        window.location.assign(target);
        return;
      } catch (err) {
        if (switchToken !== switchTokenRef.current) {
          return;
        }

        const message = err instanceof Error ? err.message : String(err);
        if (message === SSH_CONNECT_CANCELLED_ERROR) {
          return;
        }

        setSwitchModal((prev) => ({
          ...prev,
          error: message,
        }));
        toast.error(t('desktopHostSwitcher.toast.sshFailedToConnect', { host: redactSensitiveUrl(host.label) }), {
          description: message,
        });
        return;
      } finally {
        if (switchToken === switchTokenRef.current) {
          setSwitchingHostId(null);
        }
      }
    }

    if (host.id !== LOCAL_HOST_ID && isDesktopShell()) {
      setSwitchingHostId(host.id);
      const probe = await desktopHostProbe(origin, { clientToken: host.clientToken || null, requestHeaders: host.requestHeaders || null }).catch((): HostProbeResult => ({ status: 'unreachable', latencyMs: 0 }));
      setDesktopHostStatus(host.id, { status: probe.status, latencyMs: probe.latencyMs });

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
  }, [connectSshHost, current.id, isRuntimeConnected, localOrigin, onHostSwitched, sshHostIds, sshStatusesById, statusById, t]);

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

  const openInNewWindow = React.useCallback(async (selectedHost: DesktopHost) => {
    const reportFailure = (err: unknown) => {
      toast.error(t('desktopHostSwitcher.error.failedToOpenNewWindow'), {
        description: err instanceof Error ? err.message : String(err),
      });
    };
    const hostId = selectedHost.id;
    if (isWindowOpenPending(hostId)) return;
    const connectsSsh = isElectronShell() && hostId !== LOCAL_HOST_ID && Boolean(sshHostIds[hostId]);
    startWindowOpen(hostId, connectsSsh);
    try {
      let host = selectedHost;
      if (connectsSsh) {
        try {
          host = await connectSshHost(host);
        } catch (err) {
          toast.error(t('desktopHostSwitcher.toast.sshFailedToConnect', { host: redactSensitiveUrl(host.label) }), {
            description: err instanceof Error ? err.message : String(err),
          });
          return;
        }
        finishSshWindowConnect(host);
      }
      if (host.relay && host.id !== LOCAL_HOST_ID) {
        await desktopOpenNewWindowForHost(host.id).catch(reportFailure);
        return;
      }
      const origin = host.id === LOCAL_HOST_ID ? localOrigin : getDesktopHostApiUrl(host);
      if (!origin) return;
      const target = toNavigationUrl(origin);
      await desktopOpenNewWindowAtUrl(target, { clientToken: host.clientToken || null, requestHeaders: host.requestHeaders || null }).catch(reportFailure);
    } finally {
      finishWindowOpen(hostId);
    }
  }, [connectSshHost, localOrigin, sshHostIds, t]);

  const switchToLocal = React.useCallback(async () => {
    switchTokenRef.current += 1;
    setSwitchingHostId(null);
    setSwitchModal((prev) => ({
      ...prev,
      open: false,
      hostId: null,
      error: null,
      detail: null,
      phase: 'idle',
    }));
    if (!localOrigin) return;
    const localTarget = toNavigationUrl(localOrigin);
    if (isElectronShell()) {
      if (await desktopSwitchToLocal()) {
        onHostSwitched?.();
        return;
      }
      const clientToken = await getLocalClientToken();
      switchRuntimeEndpoint({ apiBaseUrl: localOrigin, clientToken: clientToken || null, runtimeKey: 'local' });
      onHostSwitched?.();
      return;
    }
    onHostSwitched?.();
    window.location.assign(localTarget);
  }, [localOrigin, onHostSwitched]);

  const cancelSwitch = React.useCallback(async () => {
    const hostId = switchModal.hostId || switchingHostId;
    const kind = switchModal.kind;
    switchTokenRef.current += 1;
    setSwitchingHostId(null);
    setSwitchModal((prev) => ({
      ...prev,
      open: false,
      hostId: null,
      phase: 'idle',
      detail: null,
      error: null,
    }));

    if (kind !== 'ssh' || !hostId || hostId === LOCAL_HOST_ID || !isDesktopShell()) {
      return;
    }

    await desktopSshDisconnect(hostId).catch(() => {});
  }, [switchModal.hostId, switchModal.kind, switchingHostId]);

  const retrySwitch = React.useCallback(() => {
    const hostId = switchModal.hostId;
    if (!hostId) return;
    const host = allHosts.find((item) => item.id === hostId);
    if (!host) return;
    void handleSwitch(host);
  }, [allHosts, handleSwitch, switchModal.hostId]);

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
        const refreshed = (await desktopHostsGet()).hosts.find((entry) => entry.id === host.id);
        if (!refreshed) throw new Error('SSH host is no longer available');
        setConfigHosts((previous) => previous.map((entry) => entry.id === host.id ? refreshed : entry));
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
              {currentDefaultLabel !== null && (
                <>
                  <span className="text-muted-foreground/50">•</span>
                  <span className="font-medium text-foreground">{t('desktopHostSwitcher.header.default')}</span>
                  <span className="max-w-[9rem] truncate text-muted-foreground">{redactSensitiveUrl(currentDefaultLabel)}</span>
                </>
              )}
            </div>
            <button
              type="button"
              className={cn(
                'inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors',
                'hover:text-foreground hover:bg-interactive-hover',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
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
            {currentDefaultLabel !== null && (
              <>
                <span className="typography-meta text-muted-foreground">{t('desktopHostSwitcher.header.currentDefaultColon')}</span>
                <span className="typography-ui-label text-foreground truncate">{redactSensitiveUrl(currentDefaultLabel)}</span>
              </>
            )}
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
          <div className="flex-shrink-0 rounded-lg border border-edge bg-muted/20 p-3">
            <div className="typography-meta text-muted-foreground">
              {t('desktopHostSwitcher.state.limitedOnPage')}
            </div>
          </div>
        )}

        <ScrollableOverlay outerClassName="flex-1 min-h-0" disableHorizontal>
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
                const statusKind: HostDisplayStatus = isSsh
                  ? sshPhaseToHostStatus(sshStatus?.phase)
                  : (status?.status ?? (isActive && isRuntimeConnected ? 'ok' : statusSnapshot.pendingHostIds.has(host.id) ? 'checking' : null));
                const isEditing = editingId === host.id;
                const effectiveUrl = isLocal ? localOrigin : (normalizeHostUrl(host.url) || host.url);
                const displayLabel = host.id === LOCAL_HOST_ID
                  ? t('desktopHostSwitcher.instance.local')
                  : redactSensitiveUrl(host.label);
                const displayUrl = host.relay && !host.apiUrl ? t('mobile.connect.relay.badge') : redactSensitiveUrl(effectiveUrl);

                return (
                  <div
                    key={host.id}
                    className={cn(
                      'group flex items-center gap-2 px-2.5 py-2 rounded-md overflow-hidden',
                      embedded && 'rounded-xl px-3 py-2.5',
                      embedded && isActive
                        ? 'bg-interactive-selection text-interactive-selection-foreground'
                        : isEditing ? 'bg-interactive-hover' : 'hover:bg-interactive-hover'
                    )}
                  >
                    <button
                      type="button"
                      className={cn(
                        'flex items-center gap-2 flex-1 min-w-0 text-start',
                        isEditing && 'pointer-events-none opacity-70'
                      )}
                      onClick={() => void handleSwitch(host)}
                      disabled={switchingHostId === host.id}
                      aria-label={t('desktopHostSwitcher.actions.switchToAria', { instance: displayLabel })}
                    >
                      <span className={cn('h-2 w-2 rounded-full flex-shrink-0', statusDotClass(statusKind))} />
                      <div className="flex-1 min-w-0 space-y-0.5">
                        <div className="flex min-w-0 items-center gap-1.5">
                          <span className="typography-ui-label font-medium truncate text-inherit">
                            {displayLabel}
                          </span>
                          {isActive && (
                            <span className="typography-micro flex-shrink-0 text-muted-foreground bg-muted px-1 rounded leading-none pb-px border border-edge">
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
                          {!isSsh && status?.via === 'relay' ? ` · ${t('settings.remoteInstances.clientAuth.state.viaRelay')}` : ''}
                        </div>
                        <div className="typography-micro text-muted-foreground truncate font-mono">
                          {displayUrl}
                        </div>
                      </div>
                    </button>

                    <div className="flex items-center gap-2 flex-shrink-0">
                      {isSsh && !isLocal && (
                        (sshStatus?.phase === 'idle' || sshStatus?.phase === 'error' || !sshStatus?.phase) ? (
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
                                : 'text-muted-foreground hover:text-primary/80',
                            )}
                            onClick={() => void setDefault(host.id)}
                            aria-label={isDefault ? t('desktopHostSwitcher.actions.defaultInstanceAria') : t('desktopHostSwitcher.actions.setAsDefaultAria')}
                            disabled={isSaving || sshWindowConnectPending || (!isDefault && isBlockedDisplayStatus(statusKind))}
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
                                  : 'text-muted-foreground hover:text-foreground',
                              )}
                            onClick={(e) => {
                              e.stopPropagation();
                              void openInNewWindow(host);
                            }}
                            disabled={isBlockedDisplayStatus(statusKind) || switchingHostId === host.id || openingHostIds.has(host.id)}
                            aria-label={t('desktopHostSwitcher.actions.openInNewWindowAria')}
                          >
                            {openingHostIds.has(host.id) ? <Spinner className="h-4 w-4" /> : <Icon name="window" className="h-4 w-4" />}
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
        </ScrollableOverlay>

        {desktopAvailable && editingId && editingId !== LOCAL_HOST_ID && (
          <div className="flex-shrink-0 rounded-lg border border-edge bg-muted/20 p-3">
            <div className="flex items-center justify-between gap-2">
              <div className="typography-ui-label font-medium text-foreground">{t('desktopHostSwitcher.edit.title')}</div>
              <div className="flex items-center gap-2">
                <Button type="button" variant="outline" size="sm" onClick={cancelEdit} disabled={isSaving}>
                  {t('desktopHostSwitcher.actions.cancel')}
                </Button>
                <Button type="button" size="sm" onClick={() => void commitEdit()} disabled={isSaving || sshWindowConnectPending}>
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
            className="w-full flex items-center gap-2 px-2 py-2 text-start text-muted-foreground hover:text-foreground hover:bg-interactive-hover/30 transition-colors"
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

  const switchDialog = (
    <Dialog
      open={switchModal.open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && switchingHostId) {
          void cancelSwitch();
          return;
        }
        setSwitchModal((prev) => ({
          ...prev,
          open: nextOpen,
          ...(nextOpen ? {} : { hostId: null, error: null, detail: null, phase: 'idle' as const }),
        }));
      }}
    >
      <DialogContent className="w-[min(28rem,calc(100vw-2rem))] max-w-none">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {switchModal.error ? <Icon name="loader-4" className="h-4 w-4" /> : <Spinner className="h-4 w-4" />}
            {t('desktopHostSwitcher.ssh.connectingTo', { host: switchModal.hostLabel || t('desktopHostSwitcher.ssh.instanceFallback') })}
          </DialogTitle>
          <DialogDescription>
            {switchModal.error
              ? switchModal.error
              : switchModal.kind === 'check'
                ? t('desktopHostSwitcher.status.checking')
                : switchModal.detail || t(sshPhaseLabelKey(switchModal.phase))}
          </DialogDescription>
        </DialogHeader>
        {switchModal.error ? (
          <div className="flex justify-end gap-2">
            {localOrigin ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => void switchToLocal()}
              >
                {t('desktopHostSwitcher.actions.switchToLocal')}
              </Button>
            ) : null}
            <Button
              type="button"
              size="sm"
              onClick={retrySwitch}
              disabled={!switchModal.hostId}
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
        {switchDialog}
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
      {switchDialog}
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
