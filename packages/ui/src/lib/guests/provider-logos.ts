import { useRuntimeObjectUrl, type RuntimeObjectUrl } from '@/lib/runtimeObjectUrl';

import { isGuestActive } from './capabilities.ts';
import { useGuestsStore } from './store.ts';
import type { InstalledGuest } from './types.ts';

type GuestProviderLogo = {
  path: string;
  isSvg: boolean;
  version: string;
};

const NO_LOGOS: ReadonlyMap<string, GuestProviderLogo> = new Map();

export const compileGuestProviderLogos = (guests: readonly InstalledGuest[]): ReadonlyMap<string, GuestProviderLogo> => {
  const logos = new Map<string, GuestProviderLogo>();
  for (const guest of guests) {
    if (!isGuestActive(guest) || !guest.providerLogos) continue;
    for (const [providerId, file] of Object.entries(guest.providerLogos)) {
      if (logos.has(providerId)) continue;
      logos.set(providerId, {
        path: `/api/guests/${guest.id}/${file.split('/').map(encodeURIComponent).join('/')}`,
        isSvg: file.toLowerCase().endsWith('.svg'),
        version: `${guest.version ?? ''}.${guest.revision ?? 0}`,
      });
    }
  }
  return logos.size > 0 ? logos : NO_LOGOS;
};

let cachedGuests: readonly InstalledGuest[] | null = null;
let cachedLogos = NO_LOGOS;

const logosForCatalog = (guests: readonly InstalledGuest[]): ReadonlyMap<string, GuestProviderLogo> => {
  if (guests !== cachedGuests) {
    cachedGuests = guests;
    cachedLogos = compileGuestProviderLogos(guests);
  }
  return cachedLogos;
};

const firstLogo = (guests: readonly InstalledGuest[], ids: readonly string[]): GuestProviderLogo | null => {
  const logos = logosForCatalog(guests);
  for (const id of ids) {
    const logo = logos.get(id);
    if (logo) return logo;
  }
  return null;
};

export const guestProviderLogoOf = (ids: readonly string[]): GuestProviderLogo | null => (
  firstLogo(useGuestsStore.getState().guests, ids)
);

export const useGuestProviderLogo = (ids: readonly string[]): GuestProviderLogo | null => (
  useGuestsStore((state) => firstLogo(state.guests, ids))
);

export const useGuestProviderLogoUrl = (logo: GuestProviderLogo | null, themeVariant: 'light' | 'dark'): RuntimeObjectUrl => {
  const query = logo
    ? new URLSearchParams(logo.isSvg ? { v: logo.version, theme: themeVariant } : { v: logo.version }).toString()
    : '';
  return useRuntimeObjectUrl(logo?.path ?? null, query);
};
