// The words behind the container mark the browser panel puts on a space's servers and pages:
// the space's name and where it lives, "preview · On this computer (Docker)". Read from the
// journey list this window already holds; a space it does not know yet gets the plain words.

import { useI18n } from '@/lib/i18n';
import { spaceIdOfDirectory } from './space-route';
import { useSpacesStore } from './spaces-store';
import { spacePlaceName } from './space-places';

export const useSpaceMarkLabel = (directory: string | null | undefined): string | null => {
  const { t } = useI18n();
  const spaceId = spaceIdOfDirectory(directory);
  const entry = useSpacesStore((state) => (spaceId ? state.journey?.get(spaceId) : undefined));
  if (spaceId === null) return null;
  if (!entry) return t('contextPanel.browser.spaceAddress');
  // The place by the name the user knows it: this computer, or the machine as they wrote it.
  const place = spacePlaceName(t, entry);
  return `${entry.name} · ${place}`;
};
