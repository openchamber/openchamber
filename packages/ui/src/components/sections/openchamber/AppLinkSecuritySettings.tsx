import React from 'react';

import { Button } from '@/components/ui/button';
import { SettingsSection } from '@/components/sections/shared/SettingsSection';
import { useI18n } from '@/lib/i18n';
import { useAppLinkTrustStore } from '@/stores/appLinkTrustStore';

/**
 * Security section for application deep links (obsidian://, notion://, ...)
 * that the user chose to always allow from chat. Removing a scheme restores
 * the confirmation dialog for it.
 */
export const AppLinkSecuritySettings: React.FC = () => {
  const { t } = useI18n();
  const trustedSchemes = useAppLinkTrustStore((state) => state.trustedSchemes);
  const removeTrustedScheme = useAppLinkTrustStore((state) => state.removeTrustedScheme);

  return (
    <SettingsSection
      title={t('settings.openchamber.appLinks.title')}
      description={t('settings.openchamber.appLinks.info')}
    >
      <div className="space-y-1" data-settings-item="general.app-links">
        {trustedSchemes.length === 0 ? (
          <p className="typography-meta text-muted-foreground">
            {t('settings.openchamber.appLinks.empty')}
          </p>
        ) : (
          trustedSchemes.map((scheme) => (
            <div key={scheme} className="flex items-center justify-between gap-2 py-0.5">
              <span className="min-w-0 truncate font-mono text-[13px]">{`${scheme}://`}</span>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => removeTrustedScheme(scheme)}
                className="!font-normal text-muted-foreground hover:text-foreground"
                aria-label={t('settings.openchamber.appLinks.removeAria', { scheme: `${scheme}://` })}
              >
                {t('settings.common.actions.delete')}
              </Button>
            </div>
          ))
        )}
      </div>
    </SettingsSection>
  );
};
