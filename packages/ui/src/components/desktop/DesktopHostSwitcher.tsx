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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  RiAddLine,
  RiCheckLine,
  RiCloudOffLine,
  RiEarthLine,
  RiLoader4Line,
  RiMore2Line,
  RiPencilLine,
  RiRefreshLine,
  RiServerLine,
  RiShieldKeyholeLine,
  RiStarFill,
  RiStarLine,
  RiDeleteBinLine,
  RiWindowLine,
} from '@remixicon/react';
import { cn } from '@/lib/utils';
import { toast } from '@/components/ui';
import { isTauriShell, isDesktopShell } from '@/lib/desktop';
import {
  desktopHostProbe,
  desktopHostsGet,
  desktopHostsSet,
  desktopOpenNewWindowAtUrl,
  locationMatchesHost,
  normalizeHostUrl,
  redactSensitiveUrl,
  type DesktopHost,
  type HostProbeResult,
} from '@/lib/desktopHosts';

const LOCAL_HOST_ID = 'local';

type HostStatus = {
  status: HostProbeResult['status'];
  latencyMs: number;
};

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

const makeId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `host-${Date.now()}-${Math.random().toString(16).slice(2)}`;
};

const statusDotClass = (status: HostProbeResult['status'] | null): string => {
  if (status === 'ok') return 'bg-status-success';
  if (status === 'auth') return 'bg-status-warning';
  if (status === 'unreachable') return 'bg-status-error';
  return 'bg-muted-foreground/40';
};

const statusLabel = (status: HostProbeResult['status'] | null): string => {
  if (status === 'ok') return 'Connected';
  if (status === 'auth') return 'Auth required';
  if (status === 'unreachable') return 'Unreachable';
  return 'Unknown';
};

const statusIcon = (status: HostProbeResult['status'] | null) => {
  if (status === 'ok') return <RiCheckLine className="h-4 w-4" />;
  if (status === 'auth') return <RiShieldKeyholeLine className="h-4 w-4" />;
  if (status === 'unreachable') return <RiCloudOffLine className="h-4 w-4" />;
  return <RiEarthLine className="h-4 w-4" />;
};

const buildLocalHost = (): DesktopHost => ({
  id: LOCAL_HOST_ID,
  label: 'Local',
  url: getLocalOrigin(),
});

const resolveCurrentHost = (hosts: DesktopHost[]) => {
  const currentHref = typeof window === 'undefined' ? '' : window.location.href;
  const localOrigin = getLocalOrigin();
  const normalizedLocal = normalizeHostUrl(localOrigin) || localOrigin;
  const normalizedCurrent = normalizeHostUrl(currentHref) || currentHref;

  if (currentHref && locationMatchesHost(currentHref, localOrigin)) {
    return { id: LOCAL_HOST_ID, label: 'Local', url: normalizedLocal };
  }

  const match = hosts.find((h) => {
    return currentHref ? locationMatchesHost(currentHref, h.url) : false;
  });

  if (match) {
    return { id: match.id, label: match.label, url: normalizeHostUrl(match.url) || match.url };
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
  const [configHosts, setConfigHosts] = React.useState<DesktopHost[]>([]);
  const [defaultHostId, setDefaultHostId] = React.useState<string | null>(null);
  const [statusById, setStatusById] = React.useState<Record<string, HostStatus>>({});
  const [isLoading, setIsLoading] = React.useState(false);
  const [isProbing, setIsProbing] = React.useState(false);
  const [isSaving, setIsSaving] = React.useState(false);
  const [switchingHostId, setSwitchingHostId] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string>('');

  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [editLabel, setEditLabel] = React.useState('');
  const [editUrl, setEditUrl] = React.useState('');

  const [newLabel, setNewLabel] = React.useState('');
  const [newUrl, setNewUrl] = React.useState('');
  const [isAddFormOpen, setIsAddFormOpen] = React.useState(!embedded);

  const allHosts = React.useMemo(() => {
    const local = buildLocalHost();
    const normalizedRemote = configHosts.map((h) => ({
      ...h,
      url: normalizeHostUrl(h.url) || h.url,
    }));
    return [local, ...normalizedRemote];
  }, [configHosts]);

  const current = React.useMemo(() => resolveCurrentHost(allHosts), [allHosts]);
  const currentDefaultLabel = React.useMemo(() => {
    const id = defaultHostId || LOCAL_HOST_ID;
    return allHosts.find((h) => h.id === id)?.label || 'Local';
  }, [allHosts, defaultHostId]);

  const persist = React.useCallback(async (nextHosts: DesktopHost[], nextDefaultHostId: string | null) => {
    if (!isTauriShell()) return;
    setIsSaving(true);
    setError('');
    try {
      // Persist only remote hosts; Local is derived.
      const remote = nextHosts.filter((h) => h.id !== LOCAL_HOST_ID);
      await desktopHostsSet({ hosts: remote, defaultHostId: nextDefaultHostId });
      setConfigHosts(remote);
      setDefaultHostId(nextDefaultHostId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setIsSaving(false);
    }
  }, []);

  const refresh = React.useCallback(async () => {
    if (!isTauriShell()) return;
    setIsLoading(true);
    setError('');
    try {
      const cfg = await desktopHostsGet();
      setConfigHosts(cfg.hosts || []);
      setDefaultHostId(cfg.defaultHostId ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
      setConfigHosts([]);
      setDefaultHostId(null);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const probeAll = React.useCallback(async (hosts: DesktopHost[]) => {
    if (!isTauriShell()) return;
    setIsProbing(true);
    try {
      const results = await Promise.all(
        hosts.map(async (h) => {
          const url = normalizeHostUrl(h.url);
          if (!url) {
            return [h.id, { status: 'unreachable' as const, latencyMs: 0 } satisfies HostStatus] as const;
          }
          const res = await desktopHostProbe(url).catch((): HostProbeResult => ({ status: 'unreachable', latencyMs: 0 }));
          return [h.id, { status: res.status, latencyMs: res.latencyMs } satisfies HostStatus] as const;
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
      setNewLabel('');
      setNewUrl('');
      setIsAddFormOpen(!embedded);
      setError('');
      return;
    }
    void refresh();
  }, [embedded, open, refresh]);

  React.useEffect(() => {
    if (!open) return;
    void probeAll(allHosts);
  }, [open, allHosts, probeAll]);

  const handleSwitch = React.useCallback(async (host: DesktopHost) => {
    const origin = host.id === LOCAL_HOST_ID ? getLocalOrigin() : (normalizeHostUrl(host.url) || '');
    if (!origin) return;

    if (host.id !== LOCAL_HOST_ID && isTauriShell()) {
      setSwitchingHostId(host.id);
      const probe = await desktopHostProbe(origin).catch((): HostProbeResult => ({ status: 'unreachable', latencyMs: 0 }));
      setStatusById((prev) => ({
        ...prev,
        [host.id]: { status: probe.status, latencyMs: probe.latencyMs },
      }));

      if (probe.status === 'unreachable') {
        toast.error(`Instance "${redactSensitiveUrl(host.label)}" is unreachable`);
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
  }, [onHostSwitched]);

  const beginEdit = React.useCallback((host: DesktopHost) => {
    setEditingId(host.id);
    setEditLabel(host.label);
    setEditUrl(host.url);
    setError('');
  }, []);

  const cancelEdit = React.useCallback(() => {
    setEditingId(null);
    setEditLabel('');
    setEditUrl('');
  }, []);

  const commitEdit = React.useCallback(async () => {
    if (!editingId) return;
    if (editingId === LOCAL_HOST_ID) {
      cancelEdit();
      return;
    }

    const url = normalizeHostUrl(editUrl);
    if (!url) {
      setError('Invalid URL (must be http/https)');
      return;
    }

    const label = (editLabel || redactSensitiveUrl(url)).trim();
    const nextHosts = configHosts.map((h) => (h.id === editingId ? { ...h, label, url } : h));
    await persist(nextHosts, defaultHostId);
    cancelEdit();
  }, [cancelEdit, configHosts, defaultHostId, editLabel, editUrl, editingId, persist]);

  const addHost = React.useCallback(async () => {
    const url = normalizeHostUrl(newUrl);
    if (!url) {
      setError('Invalid URL (must be http/https)');
      return;
    }
    const label = (newLabel || redactSensitiveUrl(url)).trim();
    const id = makeId();

    const nextHosts = [{ id, label, url }, ...configHosts];
    await persist(nextHosts, defaultHostId);
    setNewLabel('');
    setNewUrl('');
    if (embedded) {
      setIsAddFormOpen(false);
    }
  }, [configHosts, defaultHostId, embedded, newLabel, newUrl, persist]);

  const deleteHost = React.useCallback(async (id: string) => {
    if (id === LOCAL_HOST_ID) return;
    const nextHosts = configHosts.filter((h) => h.id !== id);
    const nextDefault = defaultHostId === id ? LOCAL_HOST_ID : defaultHostId;
    await persist(nextHosts, nextDefault);
  }, [configHosts, defaultHostId, persist]);

  const setDefault = React.useCallback(async (id: string) => {
    const next = id === LOCAL_HOST_ID ? LOCAL_HOST_ID : id;
    await persist(configHosts, next);
  }, [configHosts, persist]);

  const openInNewWindow = React.useCallback((host: DesktopHost) => {
    const origin = host.id === LOCAL_HOST_ID ? getLocalOrigin() : (normalizeHostUrl(host.url) || '');
    if (!origin) return;
    const target = toNavigationUrl(origin);
    desktopOpenNewWindowAtUrl(target).catch((err: unknown) => {
      toast.error('Failed to open new window', {
        description: err instanceof Error ? err.message : String(err),
      });
    });
  }, []);

  if (!isDesktopShell()) {
    return null;
  }

  const tauriAvailable = isTauriShell();

  const content = (
    <>
      {embedded ? (
        <div className="flex-shrink-0 border-b border-[var(--interactive-border)] bg-[var(--surface-elevated)] px-2 py-2.5">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0 flex items-center gap-2">
              <span className="typography-ui-header font-semibold text-foreground">Current</span>
              <span className="max-w-[9rem] truncate typography-ui-label text-muted-foreground">{redactSensitiveUrl(current.label)}</span>
              <span className="text-muted-foreground">•</span>
              <span className="typography-ui-header font-semibold text-foreground">Default</span>
              <span className="max-w-[9rem] truncate typography-ui-label text-muted-foreground">{redactSensitiveUrl(currentDefaultLabel)}</span>
            </div>
            <button
              type="button"
              className={cn(
                'inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors',
                'hover:text-foreground hover:bg-interactive-hover',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary'
              )}
              onClick={() => void probeAll(allHosts)}
              disabled={!tauriAvailable || isLoading || isProbing}
              aria-label="Refresh instances"
            >
              <RiRefreshLine className={cn('h-4 w-4', isProbing && 'animate-spin')} />
            </button>
          </div>
        </div>
      ) : (
        <DialogHeader className="flex-shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <RiServerLine className="h-5 w-5" />
            Instance
          </DialogTitle>
          <DialogDescription>
            Switch between Local and remote OpenChamber servers
          </DialogDescription>
        </DialogHeader>
      )}

      {!embedded && (
        <div className="flex items-center justify-between gap-2 flex-shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className="typography-meta text-muted-foreground">Current:</span>
            <span className="typography-ui-label text-foreground truncate">{redactSensitiveUrl(current.label)}</span>
            <span className="typography-meta text-muted-foreground">Current default:</span>
            <span className="typography-ui-label text-foreground truncate">{redactSensitiveUrl(currentDefaultLabel)}</span>
          </div>
          <div className="flex items-center gap-1">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => void probeAll(allHosts)}
              disabled={!tauriAvailable || isLoading || isProbing}
            >
              <RiRefreshLine className={cn('h-4 w-4', isProbing && 'animate-spin')} />
              Refresh
            </Button>
          </div>
        </div>
      )}

        {!tauriAvailable && (
          <div className="flex-shrink-0 rounded-lg border border-border/50 bg-muted/20 p-3">
            <div className="typography-meta text-muted-foreground">
              Instance switcher is limited on this page. Use Local to recover.
            </div>
          </div>
        )}

        <div className="flex-1 min-h-0 overflow-y-auto">
          <div className="space-y-1">
            {isLoading ? (
              <div className="px-2 py-2 text-muted-foreground text-sm">Loading…</div>
            ) : (
              allHosts.map((host) => {
                const isLocal = host.id === LOCAL_HOST_ID;
                const isActive = host.id === current.id;
                const isDefault = (defaultHostId || LOCAL_HOST_ID) === host.id;
                const status = statusById[host.id] || null;
                const isEditing = editingId === host.id;
                const effectiveUrl = isLocal ? getLocalOrigin() : (normalizeHostUrl(host.url) || host.url);
                const displayLabel = redactSensitiveUrl(host.label);
                const displayUrl = redactSensitiveUrl(effectiveUrl);

                return (
                  <div
                    key={host.id}
                    className={cn(
                      'group flex items-center gap-2 px-2.5 py-2 rounded-md overflow-hidden',
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
                      aria-label={`Switch to ${displayLabel}`}
                    >
                      <span className={cn('h-2 w-2 rounded-full flex-shrink-0', statusDotClass(status?.status ?? null))} />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className={cn('typography-ui-label truncate', isActive ? 'text-foreground' : 'text-foreground')}>
                            {displayLabel}
                          </span>
                          {isActive && (
                            <span className="typography-micro text-muted-foreground">Current</span>
                          )}
                          <span className="inline-flex items-center gap-1 typography-micro text-muted-foreground">
                            {statusIcon(status?.status ?? null)}
                            <span>
                              {statusLabel(status?.status ?? null)}
                              {status?.status === 'ok' && typeof status.latencyMs === 'number' ? ` · ${Math.max(0, Math.round(status.latencyMs))}ms ping` : ''}
                            </span>
                          </span>
                        </div>
                        <div className="typography-micro text-muted-foreground truncate font-mono">
                          {displayUrl}
                        </div>
                      </div>
                    </button>

                    <div className="flex items-center gap-2 flex-shrink-0">
                      {!isLocal && (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <button
                              type="button"
                              className="h-8 w-8 rounded-md inline-flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-interactive-hover transition-colors"
                              aria-label="Instance actions"
                              disabled={isSaving}
                              onClick={(e) => e.stopPropagation()}
                            >
                              <RiMore2Line className="h-4 w-4" />
                            </button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-fit min-w-28">
                            <DropdownMenuItem
                              onClick={(e) => {
                                e.stopPropagation();
                                beginEdit(host);
                              }}
                              disabled={isSaving}
                            >
                              <RiPencilLine className="h-4 w-4 mr-1" />
                              Edit
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={(e) => {
                                e.stopPropagation();
                                void deleteHost(host.id);
                              }}
                              className="text-destructive focus:text-destructive"
                              disabled={isSaving}
                            >
                              <RiDeleteBinLine className="h-4 w-4 mr-1" />
                              Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}

                      {isLocal && (
                        <div
                          className="h-8 w-8 opacity-0 pointer-events-none"
                          aria-hidden="true"
                        />
                      )}

                      <Tooltip delayDuration={700}>
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
                            aria-label={isDefault ? 'Default instance' : 'Set as default'}
                            disabled={isSaving}
                          >
                            {isDefault ? <RiStarFill className="h-4 w-4" /> : <RiStarLine className="h-4 w-4" />}
                          </button>
                        </TooltipTrigger>
                        <TooltipContent sideOffset={6}>
                          {isDefault ? 'Default' : 'Set as default'}
                        </TooltipContent>
                      </Tooltip>

                      <Tooltip delayDuration={700}>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            className={cn(
                              'h-8 w-8 rounded-md inline-flex items-center justify-center hover:bg-interactive-hover transition-colors',
                              status?.status === 'unreachable'
                                ? 'text-muted-foreground/30 cursor-not-allowed'
                                : 'text-muted-foreground/60 hover:text-foreground',
                            )}
                            onClick={(e) => {
                              e.stopPropagation();
                              openInNewWindow(host);
                            }}
                            disabled={status?.status === 'unreachable'}
                            aria-label="Open in new window"
                          >
                            <RiWindowLine className="h-4 w-4" />
                          </button>
                        </TooltipTrigger>
                        <TooltipContent sideOffset={6}>
                          {status?.status === 'unreachable' ? 'Instance unreachable' : 'Open in new window'}
                        </TooltipContent>
                      </Tooltip>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {tauriAvailable && editingId && editingId !== LOCAL_HOST_ID && (
          <div className="flex-shrink-0 rounded-lg border border-border/50 bg-muted/20 p-3">
            <div className="flex items-center justify-between gap-2">
              <div className="typography-ui-label font-medium text-foreground">Edit instance</div>
              <div className="flex items-center gap-2">
                <Button type="button" variant="outline" size="sm" onClick={cancelEdit} disabled={isSaving}>
                  Cancel
                </Button>
                <Button type="button" size="sm" onClick={() => void commitEdit()} disabled={isSaving}>
                  {isSaving ? <RiLoader4Line className="h-4 w-4 animate-spin" /> : null}
                  Save
                </Button>
              </div>
            </div>
            <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
              <Input
                value={editLabel}
                onChange={(e) => setEditLabel(e.target.value)}
                placeholder="Label"
                disabled={isSaving}
              />
              <Input
                value={editUrl}
                onChange={(e) => setEditUrl(e.target.value)}
                placeholder="https://host:port"
                disabled={isSaving}
              />
            </div>
          </div>
        )}

        {embedded && !isAddFormOpen ? (
          <div className="flex-shrink-0 border-t border-[var(--interactive-border)]">
            <button
              type="button"
              className="w-full flex items-center gap-2 px-2 py-2 text-left text-muted-foreground hover:text-foreground hover:bg-interactive-hover/30 transition-colors"
              onClick={() => setIsAddFormOpen(true)}
              disabled={!tauriAvailable || isSaving}
            >
              <RiAddLine className="h-4 w-4" />
              <span className="typography-ui-label">Add instance</span>
            </button>
          </div>
        ) : (
          <div className={cn(
            'flex-shrink-0',
            embedded
              ? 'border-t border-[var(--interactive-border)] px-2 py-2'
              : 'rounded-md border border-[var(--interactive-border)] bg-[var(--surface-elevated)] p-2.5'
          )}>
            <div className="flex items-center justify-between gap-2">
              <div className="typography-ui-label font-medium text-foreground">Add instance</div>
              <div className="flex items-center gap-2">
                {embedded && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setIsAddFormOpen(false)}
                    disabled={isSaving}
                  >
                    Cancel
                  </Button>
                )}
                <Button
                  type="button"
                  size="sm"
                  onClick={() => void addHost()}
                  disabled={!tauriAvailable || isSaving || !newUrl.trim()}
                >
                  {isSaving ? <RiLoader4Line className="h-4 w-4 animate-spin" /> : null}
                  Add
                </Button>
              </div>
            </div>
            <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
              <Input
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                placeholder="Label (optional)"
                disabled={!tauriAvailable || isSaving}
              />
              <Input
                value={newUrl}
                onChange={(e) => setNewUrl(e.target.value)}
                placeholder="https://host:port"
                disabled={!tauriAvailable || isSaving}
              />
            </div>
          </div>
        )}

        {error && (
          <div className="flex-shrink-0 typography-meta text-status-error">{error}</div>
        )}
    </>
  );

  if (embedded) {
    return (
      <div className="w-full max-h-[70vh] flex flex-col overflow-hidden gap-2">
        {content}
      </div>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(42rem,calc(100vw-2rem))] max-w-none max-h-[70vh] flex flex-col overflow-hidden gap-3">
        {content}
      </DialogContent>
    </Dialog>
  );
}

type DesktopHostSwitcherButtonProps = {
  headerIconButtonClass: string;
};

export function DesktopHostSwitcherButton({ headerIconButtonClass }: DesktopHostSwitcherButtonProps) {
  const [open, setOpen] = React.useState(false);
  const [label, setLabel] = React.useState('Local');
  const [status, setStatus] = React.useState<HostProbeResult['status'] | null>(null);

  React.useEffect(() => {
    if (!isTauriShell()) return;

    let cancelled = false;
    const run = async () => {
      try {
        const cfg = await desktopHostsGet();
        const local = buildLocalHost();
        const all = [local, ...(cfg.hosts || [])];
        const current = resolveCurrentHost(all);
        if (cancelled) return;
        setLabel(redactSensitiveUrl(current.label || 'Instance'));
        const normalized = normalizeHostUrl(current.url);
        if (!normalized) {
          setStatus(null);
          return;
        }
        const res = await desktopHostProbe(normalized).catch((): HostProbeResult => ({ status: 'unreachable', latencyMs: 0 }));
        if (cancelled) return;
        setStatus(res.status);
      } catch {
        if (!cancelled) {
          setLabel('Instance');
          setStatus(null);
        }
      }
    };

    void run();
    const interval = window.setInterval(() => {
      void run();
    }, 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  if (!isDesktopShell()) {
    return null;
  }

  const isCurrentlyLocal = (() => {
    try {
      return locationMatchesHost(window.location.href, getLocalOrigin());
    } catch {
      return false;
    }
  })();

  // Fallback label when Tauri IPC is temporarily unavailable.
  const fallbackLabel = (() => {
    try {
      const host = typeof window !== 'undefined' ? window.location.hostname : '';
      return host ? host : 'Instance';
    } catch {
      return 'Instance';
    }
  })();

  const effectiveLabel = isCurrentlyLocal
    ? 'Local'
    : label === 'Local'
      ? fallbackLabel
      : label;
  const safeEffectiveLabel = redactSensitiveUrl(effectiveLabel);

  return (
    <>
      <Tooltip delayDuration={500}>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() => setOpen(true)}
            aria-label="Switch instance"
            data-oc-host-switcher
            className={cn(headerIconButtonClass, 'relative w-auto px-3')}
          >
            <RiServerLine className="h-5 w-5" />
            <span className="hidden sm:inline typography-ui-label font-medium text-muted-foreground truncate max-w-[11rem]">
              {safeEffectiveLabel}
            </span>
            <span
              className={cn(
                'pointer-events-none absolute top-1.5 right-1.5 h-1.5 w-1.5 rounded-full',
                statusDotClass(status)
              )}
              aria-label="Instance status"
            />
          </button>
        </TooltipTrigger>
        <TooltipContent>
          <p>Instance</p>
        </TooltipContent>
      </Tooltip>
      <DesktopHostSwitcherDialog open={open} onOpenChange={setOpen} />
    </>
  );
}

export function DesktopHostSwitcherInline() {
  const [open, setOpen] = React.useState(false);

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
        <RiServerLine className="h-4 w-4" />
        Switch instance
      </Button>
      <DesktopHostSwitcherDialog open={open} onOpenChange={setOpen} />
    </>
  );
}
