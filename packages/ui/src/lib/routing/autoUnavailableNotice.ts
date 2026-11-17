import { toast } from 'sonner';
import { formatMessage, useI18nStore } from '@/lib/i18n';
import { useRoutingStore } from '@/stores/useRoutingStore';
import { useUIStore } from '@/stores/useUIStore';

const AUTO_UNAVAILABLE_TOAST_ID = 'auto-unavailable';

export const notifyAutoUnavailable = (): void => {
  const routing = useRoutingStore.getState();
  if (!routing.loaded || !routing.available || !routing.config?.enabled) return;
  if (routing.jevAvailable || routing.enterpriseMode) return;
  const dictionary = useI18nStore.getState().dictionary;
  toast.warning(formatMessage(dictionary, 'chat.auto.toast.unavailable.title'), {
    id: AUTO_UNAVAILABLE_TOAST_ID,
    description: formatMessage(dictionary, 'chat.auto.toast.unavailable.description'),
    action: {
      label: formatMessage(dictionary, 'chat.auto.toast.unavailable.action'),
      onClick: () => {
        const ui = useUIStore.getState();
        ui.setSettingsProvidersClassificationRequested(true);
        ui.openSettingsAt('providers', 'providers.classification');
      },
    },
  });
};
