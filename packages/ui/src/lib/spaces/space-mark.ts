
import { useI18n } from '@/lib/i18n';
import { spaceIdOfDirectory } from './space-route';
import { useSpacesStore } from './spaces-store';

export const useSpaceMarkLabel = (directory: string | null | undefined): string | null => {
  const { t } = useI18n();
  const spaceId = spaceIdOfDirectory(directory);
  const entry = useSpacesStore((state) => (spaceId ? state.journey?.get(spaceId) : undefined));
  if (spaceId === null) return null;
  if (!entry) return t('contextPanel.browser.spaceAddress');
  const place = entry.machine ?? (entry.placeId === 'docker' ? t('spaces.create.place.localDocker') : entry.placeId);
  return `${entry.name} · ${place}`;
};
