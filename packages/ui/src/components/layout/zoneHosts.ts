import { create } from 'zustand';
import type { ContextZone } from '@/lib/workspace/zones';

type ZoneElements = { left: HTMLElement | null; right: HTMLElement | null; bottom: HTMLElement | null };

type ZoneHostsState = {
  body: ZoneElements;
  headerSlot: ZoneElements;
};

const EMPTY = { left: null, right: null, bottom: null } satisfies ZoneElements;

export const useZoneHostsStore = create<ZoneHostsState>(() => ({
  body: EMPTY,
  headerSlot: EMPTY,
}));

const setElement = (key: 'body' | 'headerSlot', zone: ContextZone, element: HTMLElement | null): void => {
  const current = useZoneHostsStore.getState()[key];
  if (current[zone] === element) return;
  useZoneHostsStore.setState({ [key]: { ...current, [zone]: element } });
};

export const setZoneBody = (zone: ContextZone, element: HTMLElement | null): void => setElement('body', zone, element);

export const setZoneHeaderSlot = (zone: ContextZone, element: HTMLElement | null): void => setElement('headerSlot', zone, element);
