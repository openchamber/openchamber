import type { I18nKey } from '@/lib/i18n';
import type { SpaceEntry, SpacePlace } from './spaces-api';

export const isRootPlace = (place: SpacePlace): boolean => place.kind === 'host-root' || place.id === 'host-root';

const PLACE_ORDER = { host: 0, docker: 1, 'host-root': 2 } as const;
export const orderedSpacePlaces = (places: readonly SpacePlace[]): SpacePlace[] =>
  [...places].sort((a, b) => (isRootPlace(a) ? 2 : PLACE_ORDER[a.kind]) - (isRootPlace(b) ? 2 : PLACE_ORDER[b.kind]));

/** A root place requires a deliberate pick, including when every isolated place is down. */
export const selectedSpacePlace = (places: readonly SpacePlace[], selectedId: string | null): SpacePlace | null => {
  if (selectedId !== null) return places.find((place) => place.id === selectedId) ?? null;
  const ordinary = orderedSpacePlaces(places).filter((place) => !isRootPlace(place));
  return ordinary.find((place) => place.available) ?? ordinary[0] ?? null;
};

export const rootPlaceAvailable = (place: SpacePlace): boolean => place.available && place.rootActivation?.available === true;

export const spacePlaceName = (t: (key: I18nKey) => string, place: Pick<SpaceEntry, 'kind' | 'machine'>): string => {
  switch (place.kind) {
    case 'host': return t('spaces.place.host');
    case 'host-root': return t('spaces.place.root');
    case 'docker': return place.machine ?? t('spaces.place.docker');
    default: { const unhandled: never = place.kind; return unhandled; }
  }
};
