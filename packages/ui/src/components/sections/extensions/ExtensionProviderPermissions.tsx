import { SETTINGS_HELPER_CLASS } from '@/components/sections/shared/SettingsSection';
import type { InstalledGuest } from '@/lib/guests/types';
import { useI18n } from '@/lib/i18n';

export function ExtensionProviderPermissions({ guest }: { guest: InstalledGuest }) {
  const { t } = useI18n();
  return (
    <>
      {guest.quota ? (
        <p className="typography-meta text-foreground">
          {guest.quota.providers.length > 0
            ? t('settings.extensions.service.providesQuota', { list: guest.quota.providers.join(', ') })
            : t('settings.extensions.service.providesQuota.none')}
        </p>
      ) : null}
      {guest.capabilities.requested.includes('opencode') ? (
        <p className="typography-meta text-foreground">{t('settings.extensions.capability.opencode.detail')}</p>
      ) : null}
      {guest.capabilities.requested.includes('providerAccounts') && guest.capabilities.granted.includes('providerAccounts') ? (
        <div>
          <p className="typography-ui-label text-foreground">{t('settings.extensions.capability.providerAccounts')}</p>
          <p className={SETTINGS_HELPER_CLASS}>{t('settings.extensions.capability.providerAccounts.detail')}</p>
        </div>
      ) : null}
    </>
  );
}
