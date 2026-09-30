import React from 'react';
import { SETTINGS_HELPER_CLASS } from '@/components/sections/shared/SettingsSection';
import { useI18n } from '@/lib/i18n';
import { useEnterpriseMode } from '@/stores/useEnterprisePolicyStore';
import { useRoutingStore } from '@/stores/useRoutingStore';
import { openClassificationProviders, useClassifierSourceName } from './classifierSources';

/** An inline link inside helper text or a tooltip. */
export const SettingsInlineLink: React.FC<{ onClick: () => void; children: React.ReactNode }> = ({ onClick, children }) => (
  <button
    type="button"
    onClick={onClick}
    className="cursor-pointer text-[var(--primary-text)] underline-offset-4 hover:underline focus-visible:underline focus-visible:outline-none"
  >
    {children}
  </button>
);

/**
 * One line next to a feature that decides through Jev (the safety net, Auto):
 * which classification provider answers, or that none does, with a link to
 * Settings → Providers → Classification providers. In enterprise mode
 * without an administrator's endpoint there is nothing to set up, so it says
 * so instead of linking to a page that offers only Off. Nothing without an
 * OpenChamber server (VS Code), where these features do not exist.
 */
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
