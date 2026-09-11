import React from 'react';
import { resolveAttachMode, type AttachMode } from '@openchamber/sdk';

import type { IconName } from '@/components/icon/icons';
import { isVSCodeRuntime } from '@/lib/desktop';
import { isMobileSurfaceRuntime } from '@/lib/runtimeSurface';
import { guestActionEntries, type GuestActionEntry } from '@/lib/guests/actions';
import { isGuestActive } from '@/lib/guests/capabilities';
import { guestCommandEntries, type GuestCommandEntry } from '@/lib/guests/commands';
import { guestPackageIconSrc, resolveGuestIconName } from '@/lib/guests/icon';
import { enabledGuestSurfaces } from '@/lib/guests/surfaces';
import { loadGuestCatalog } from '@/lib/guests/load-catalog';
import { useGuestsStore } from '@/lib/guests/store';
import { getRuntimeUrlResolver } from '@/lib/runtime-url';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import type { ContextSurfaceDescriptor } from '@/lib/surfaces/registry';

export type GuestAttachItem = {
  id: string;
  name: string;
  icon: IconName;
  iconSrc?: string;
  mode: AttachMode;
};

const EMPTY_ACTIONS: GuestActionEntry[] = [];
const EMPTY_COMMANDS: GuestCommandEntry[] = [];

/** The catalog, loaded on mount and reloaded on a runtime switch. */
const useGuestCatalog = () => {
  const guests = useGuestsStore((state) => state.guests);
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
  }, [guests, runtimeKey]);
};

/**
 * Message and session menu entries from active guests. Empty on VS Code and
 * mobile, which never mount guests. Reads the store only: every transcript
 * row and sidebar row calls this, and the rail (`useGuestSurfaces`) already
 * owns loading the catalog and following runtime switches. The store is
 * emptied on a switch, so a memo on `guests` alone stays current.
 */
export const useGuestActions = (): GuestActionEntry[] => {
  const guests = useGuestsStore((state) => state.guests);

  return React.useMemo(() => {
    if (isVSCodeRuntime() || isMobileSurfaceRuntime()) return EMPTY_ACTIONS;
    const entries = guestActionEntries(guests, getRuntimeUrlResolver().authenticatedAsset);
    return entries.length > 0 ? entries : EMPTY_ACTIONS;
  }, [guests]);
};

/**
 * Slash commands from active guests, minus any name in `reservedNames` (the
 * composer's own commands, OpenCode commands, skills). Empty on VS Code and
 * mobile. Store read only, like `useGuestActions`.
 */
export const useGuestCommands = (reservedNames: ReadonlySet<string>): GuestCommandEntry[] => {
  const guests = useGuestsStore((state) => state.guests);

  return React.useMemo(() => {
    if (isVSCodeRuntime() || isMobileSurfaceRuntime()) return EMPTY_COMMANDS;
    const entries = guestCommandEntries(guests, reservedNames);
    return entries.length > 0 ? entries : EMPTY_COMMANDS;
  }, [guests, reservedNames]);
};

export const useGuestAttachItems = (): GuestAttachItem[] => {
  const { guests, runtimeKey } = useGuestCatalog();

  return React.useMemo(() => {
    if (isVSCodeRuntime() || isMobileSurfaceRuntime()) return [];
    const authenticatedAsset = getRuntimeUrlResolver().authenticatedAsset;
    const items: GuestAttachItem[] = [];
    for (const guest of guests) {
      if (!isGuestActive(guest)) continue;
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
  }, [guests, runtimeKey]);
};
