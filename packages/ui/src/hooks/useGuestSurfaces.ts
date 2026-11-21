import React from 'react';
import { hasGuestPage, resolveAttachMode, type AttachMode } from '@openchamber/sdk';

import type { IconName } from '@/components/icon/icons';
import { isVSCodeRuntime } from '@/lib/desktop';
import { isMobileSurfaceRuntime } from '@/lib/runtimeSurface';
import { guestActionEntries, type GuestActionEntry } from '@/lib/guests/actions';
import { isGuestActive } from '@/lib/guests/capabilities';
import { guestCommandEntries, type GuestCommandEntry } from '@/lib/guests/commands';
import { guestPackageIconSrc, resolveGuestIconName } from '@/lib/guests/icon';
import { enabledGuestSurfaces } from '@/lib/guests/surfaces';
import { guestPanelOpensHere, mayGuestShowOnPhone, phoneGuestPanelModes } from '@/lib/guests/phone';
import { guestsInScope, isGuestInFolders, isGuestTabHidden, toGuestScopePaths, useGuestScopeStore } from '@/lib/guests/folders';
import { loadGuestCatalog } from '@/lib/guests/load-catalog';
import { useGuestsStore } from '@/lib/guests/store';
import type { InstalledGuest } from '@/lib/guests/types';
import { getRuntimeUrlResolver } from '@/lib/runtime-url';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import type { ContextSurfaceDescriptor } from '@/lib/surfaces/registry';
import { isPluginContextPanelMode, pluginIdFromMode, type PluginContextPanelMode } from '@/lib/surfaces/modes';
import type { ContextPanelDirectoryState } from '@/stores/ui/types';

export type GuestAttachItem = {
  id: string;
  name: string;
  icon: IconName;
  iconSrc?: string;
  mode: AttachMode;
};

const EMPTY_ACTIONS: GuestActionEntry[] = [];
const EMPTY_COMMANDS: GuestCommandEntry[] = [];

type GuestScope = ReadonlyArray<string | null | undefined>;

const useScopedGuests = (scope?: GuestScope): InstalledGuest[] => {
  const guests = useGuestsStore((state) => state.guests);
  const openScope = useGuestScopeStore((state) => state.paths);
  const ownScope = scope ? toGuestScopePaths(scope).join('\n') : null;
  return React.useMemo(() => (ownScope === null
    ? guestsInScope(guests, openScope)
    : guests.filter((guest) => isGuestInFolders(guest, ownScope ? ownScope.split('\n') : []))
  ), [guests, openScope, ownScope]);
};

const useGuestCatalog = (scope?: GuestScope) => {
  const guests = useScopedGuests(scope);
  const [runtimeKey, setRuntimeKey] = React.useState(getRuntimeKey);

  React.useEffect(() => {
    void loadGuestCatalog();
    return subscribeRuntimeEndpointChanged((detail) => {
      setRuntimeKey(detail.runtimeKey);
      void loadGuestCatalog();
    });
  }, []);

  return { guests, runtimeKey };
};

export const useGuestSurfaces = (): ContextSurfaceDescriptor[] => {
  const { guests, runtimeKey } = useGuestCatalog();

  return React.useMemo(() => {
    return enabledGuestSurfaces(guests, getRuntimeUrlResolver().authenticatedAsset);
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [guests, runtimeKey]);
};

export const useGuestPages = () => {
  const guests = useScopedGuests();
  return React.useMemo(() => {
    if (isVSCodeRuntime()) return [];
    const phone = isMobileSurfaceRuntime();
    return guests.filter((guest) => guest.pageEntry && isGuestActive(guest) && (!phone || mayGuestShowOnPhone(guest, 'page')));
  }, [guests]);
};

const NO_PHONE_PANELS: PluginContextPanelMode[] = [];

export const usePhoneGuestPanelModes = (): PluginContextPanelMode[] => {
  const key = phoneGuestPanelModes(useScopedGuests()).join('\n');
  return React.useMemo(() => (key ? key.split('\n').filter(isPluginContextPanelMode) : NO_PHONE_PANELS), [key]);
};

const EMPTY_STATUS_SECTIONS: InstalledGuest[] = [];

export const useGuestStatusSections = (): InstalledGuest[] => {
  const guests = useScopedGuests();
  return React.useMemo(() => {
    if (isVSCodeRuntime()) return EMPTY_STATUS_SECTIONS;
    const sections = guests.filter((guest) => (guest.statusEntry || guest.statusSource) && isGuestActive(guest));
    return sections.length > 0 ? sections : EMPTY_STATUS_SECTIONS;
  }, [guests]);
};

export const useGuestActions = (scope?: GuestScope): GuestActionEntry[] => {
  const guests = useScopedGuests(scope);

  return React.useMemo(() => {
    if (isVSCodeRuntime()) return EMPTY_ACTIONS;
    const entries = guestActionEntries(guests, getRuntimeUrlResolver().authenticatedAsset)
      .filter((entry) => entry.action.mode === 'background' || guestPanelOpensHere(entry.guest));
    return entries.length > 0 ? entries : EMPTY_ACTIONS;
  }, [guests]);
};

export const useGuestCommands = (reservedNames: ReadonlySet<string>): GuestCommandEntry[] => {
  const guests = useScopedGuests();

  return React.useMemo(() => {
    if (isVSCodeRuntime()) return EMPTY_COMMANDS;
    const entries = guestCommandEntries(guests, reservedNames);
    return entries.length > 0 ? entries : EMPTY_COMMANDS;
  }, [guests, reservedNames]);
};

export const useGuestAttachItems = (scope?: GuestScope): GuestAttachItem[] => {
  const { guests, runtimeKey } = useGuestCatalog(scope);

  return React.useMemo(() => {
    if (isVSCodeRuntime()) return [];
    const authenticatedAsset = getRuntimeUrlResolver().authenticatedAsset;
    const items: GuestAttachItem[] = [];
    for (const guest of guests) {
      if (!isGuestActive(guest) || !hasGuestPage({ panel: guest }) || !guestPanelOpensHere(guest)) continue;
      const mode = resolveAttachMode(guest.attach);
      if (!mode) continue;
      items.push({
        id: guest.id,
        name: guest.name,
        icon: resolveGuestIconName(guest.icon),
        iconSrc: guestPackageIconSrc(guest.id, guest.icon, authenticatedAsset),
        mode,
      });
    }
    return items;
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [guests, runtimeKey]);
};

export const useGuestTabsInScope = (panel: ContextPanelDirectoryState | undefined): ContextPanelDirectoryState | undefined => {
  const status = useGuestsStore((state) => state.status);
  const guests = useGuestsStore((state) => state.guests);
  const paths = useGuestScopeStore((state) => state.paths);
  return React.useMemo(() => {
    if (!panel) return panel;
    const catalog = { loaded: status !== 'idle' && status !== 'loading', guests };
    const tabs = panel.tabs.filter((tab) => !isPluginContextPanelMode(tab.mode) || !isGuestTabHidden(pluginIdFromMode(tab.mode), catalog, paths));
    return tabs.length === panel.tabs.length ? panel : { ...panel, tabs };
  }, [guests, panel, paths, status]);
};
