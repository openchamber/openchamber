import React from 'react';
import { SettingsCheckboxRow } from '@/components/sections/shared/SettingsSection';
import { useI18n } from '@/lib/i18n';
import { loadDesktopSettings, updateDesktopSettings } from '@/lib/persistence';

interface ProviderAccountSwitchToggleProps {
  providerId: string;
  /** Stored accounts requests can go through; switching needs two. */
  accountCount: number;
}

/**
 * Opt-in, per provider, to moving every session to the next account when the
 * active one hits its usage limit. The server reads the list when a limit
 * error arrives (`lib/limit-failover`), so a change applies to the next one.
 * Off by default: a second account can be a work account kept apart on purpose.
 */
export const ProviderAccountSwitchToggle: React.FC<ProviderAccountSwitchToggleProps> = ({ providerId, accountCount }) => {
  const { t } = useI18n();
  const [providers, setProviders] = React.useState<string[] | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    void loadDesktopSettings()
      .then((settings) => {
        if (!cancelled) setProviders(settings?.accountSwitchProviders ?? []);
      })
      .catch(() => {
        if (!cancelled) setProviders([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (providers === null) return null;

  const canSwitch = accountCount > 1;
  const withChoice = (list: string[], checked: boolean) => (checked
    ? Array.from(new Set([...list, providerId]))
    : list.filter((id) => id !== providerId));
  // The list is shared by every provider page and every window, so the write
  // starts from the stored list, not the one read when this page opened.
  const handleChange = async (checked: boolean) => {
    setProviders(withChoice(providers, checked));
    const stored = await loadDesktopSettings()
      .then((settings) => settings?.accountSwitchProviders ?? [])
      .catch(() => providers);
    const next = withChoice(stored, checked);
    setProviders(next);
    const result = await updateDesktopSettings({ accountSwitchProviders: next });
    if (!result.ok) setProviders(stored);
  };

  return (
    <SettingsCheckboxRow
      checked={canSwitch && providers.includes(providerId)}
      onChange={(checked) => void handleChange(checked)}
      disabled={!canSwitch}
      label={t('settings.providers.accounts.switchOnLimit')}
      ariaLabel={t('settings.providers.accounts.switchOnLimit')}
      info={t('settings.providers.accounts.switchOnLimitInfo')}
      description={canSwitch ? undefined : t('settings.providers.accounts.switchOnLimitNeedsAccounts')}
    />
  );
};
