import React from 'react';
import { SETTINGS_HELPER_CLASS } from '@/components/sections/shared/SettingsSection';
import { useI18n } from '@/lib/i18n';
import { useEnterpriseMode } from '@/stores/useEnterprisePolicyStore';
import { useRoutingStore } from '@/stores/useRoutingStore';
import { openClassificationProviders, useClassifierSourceName } from './classifierSources';

export const SETTINGS_LINK_CLASS = 'cursor-pointer text-foreground underline decoration-[var(--muted-foreground)] underline-offset-4 hover:decoration-foreground focus-visible:decoration-foreground focus-visible:outline-none';

export const SettingsInlineLink: React.FC<{ onClick: () => void; children: React.ReactNode }> = ({ onClick, children }) => (
  <button
    type="button"
    onClick={onClick}
    className={SETTINGS_LINK_CLASS}
  >
    {children}
  </button>
);

export const JevAccessNote: React.FC = () => {
  const { t } = useI18n();
  const available = useRoutingStore((state) => state.available);
  const jevAvailable = useRoutingStore((state) => state.jevAvailable);
  const effective = useRoutingStore((state) => state.classifier?.effective ?? null);
  const sourceName = useClassifierSourceName(effective);
  const enterpriseMode = useEnterpriseMode();

  if (!available) return null;
  if (enterpriseMode && !jevAvailable) {
    return <p className={SETTINGS_HELPER_CLASS}>{t('settings.jevAccess.enterprise')}</p>;
  }

  return (
    <p className={SETTINGS_HELPER_CLASS}>
      {jevAvailable && sourceName
        ? t('settings.jevAccess.via', { provider: sourceName })
        : t('settings.jevAccess.missing')}
      {' '}
      <SettingsInlineLink onClick={openClassificationProviders}>
        {jevAvailable ? t('settings.jevAccess.manage') : t('settings.jevAccess.setUp')}
      </SettingsInlineLink>
    </p>
  );
};
