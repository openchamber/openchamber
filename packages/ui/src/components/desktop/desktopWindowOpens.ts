import React from 'react';
import type { DesktopHost } from '@/lib/desktopHosts';

type WindowOpensSnapshot = {
  pending: ReadonlyMap<string, boolean>;
  refreshedSshHosts: ReadonlyMap<string, DesktopHost>;
};

let snapshot: WindowOpensSnapshot = { pending: new Map(), refreshedSshHosts: new Map() };
const listeners = new Set<() => void>();

const publish = (next: WindowOpensSnapshot) => {
  snapshot = next;
  listeners.forEach((listener) => listener());
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

const getSnapshot = () => snapshot;

export const isWindowOpenPending = (hostId: string) => snapshot.pending.has(hostId);

export const hasPendingSshWindowConnect = (pending: ReadonlyMap<string, boolean> = snapshot.pending) =>
  [...pending.values()].some(Boolean);

export const startWindowOpen = (hostId: string, connectsSsh: boolean) => {
  publish({ ...snapshot, pending: new Map(snapshot.pending).set(hostId, connectsSsh) });
};

export const finishSshWindowConnect = (host: DesktopHost) => {
  publish({
    pending: new Map(snapshot.pending).set(host.id, false),
    refreshedSshHosts: new Map(snapshot.refreshedSshHosts).set(host.id, host),
  });
};

export const finishWindowOpen = (hostId: string) => {
  const pending = new Map(snapshot.pending);
  pending.delete(hostId);
  publish({ ...snapshot, pending });
};

export const usePendingWindowOpens = (setHosts: React.Dispatch<React.SetStateAction<DesktopHost[]>>) => {
  const { pending, refreshedSshHosts } = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const [appliedSshHosts, setAppliedSshHosts] = React.useState(refreshedSshHosts);
  if (appliedSshHosts !== refreshedSshHosts) {
    setAppliedSshHosts(refreshedSshHosts);
    setHosts((hosts) => hosts.map((host) => {
      const refreshed = refreshedSshHosts.get(host.id);
      return refreshed && refreshed !== appliedSshHosts.get(host.id) ? refreshed : host;
    }));
  }
  return pending;
};
