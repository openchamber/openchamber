// The words behind the container mark the browser panel puts on a space's servers and pages:
// the space's name and where it lives, "preview · On this computer (Docker)". Read from the
// journey list this window already holds; a space it does not know yet gets the plain words.

import { useI18n } from '@/lib/i18n';
import { spaceIdOfDirectory } from './space-route';
import { useSpacesStore } from './spaces-store';

export const useSpaceMarkLabel = (directory: string | null | undefined): string | null => {
  const { t } = useI18n();
  const spaceId = spaceIdOfDirectory(directory);
  const entry = useSpacesStore((state) => (spaceId ? state.journey?.get(spaceId) : undefined));
  if (spaceId === null) return null;
  if (!entry) return t('contextPanel.browser.spaceAddress');
  const place = entry.placeId === 'docker' ? t('spaces.create.place.localDocker') : entry.placeId;
  return `${entry.name} · ${place}`;
};
