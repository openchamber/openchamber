import React from 'react';
import { SETTINGS_HELPER_CLASS } from '@/components/sections/shared/SettingsSection';
import { useI18n } from '@/lib/i18n';
import { useEnterpriseMode } from '@/stores/useEnterprisePolicyStore';
import { useRoutingStore } from '@/stores/useRoutingStore';
import { openClassificationProviders, useClassifierSourceName } from './classifierSources';

/**
 * Every link in Settings: the text colour with an underline, no accent
 * (maintainer, 2026-11-12). The underline says it is a link; the accent is for
 * primary actions. Hover and focus bring the underline to full strength.
 */
export const SETTINGS_LINK_CLASS = 'cursor-pointer text-foreground underline decoration-[var(--muted-foreground)] underline-offset-4 hover:decoration-foreground focus-visible:decoration-foreground focus-visible:outline-none';

/** An inline link inside helper text or a tooltip. */
export const SettingsInlineLink: React.FC<{ onClick: () => void; children: React.ReactNode }> = ({ onClick, children }) => (
  <button
    type="button"
    onClick={onClick}
    className={SETTINGS_LINK_CLASS}
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
