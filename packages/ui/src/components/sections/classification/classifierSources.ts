import { useI18n } from '@/lib/i18n';
import type { ClassifierSource } from '@/lib/routing/routingApi';
import { useUIStore } from '@/stores/useUIStore';

/** The name a classification provider goes by in Settings, or null for none. */
export const useClassifierSourceName = (source: ClassifierSource | null): string | null => {
  const { t } = useI18n();
  if (source === 'zen-promo') return t('settings.classification.source.zenPromo.name');
  if (source === 'zen-key') return t('settings.classification.source.zenKey.name');
  if (source === 'typesafe') return t('settings.classification.source.typesafe.name');
  return null;
};

/** Opens Settings → Providers → Classification providers. */
export const openClassificationProviders = (): void => {
  const ui = useUIStore.getState();
  ui.setSettingsProvidersClassificationRequested(true);
  ui.requestSettingsJump('providers', 'providers.classification');
};
