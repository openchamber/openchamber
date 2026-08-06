import React from 'react';
import { MessengerSection } from '@/components/sections/openchamber-agent-settings/MessengerSection';
import { JiraSection } from '@/components/sections/integrations/JiraSection';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { useI18n } from '@/lib/i18n';

/**
 * Settings → Integrations.
 *
 * Hosts external integrations (the Discord messenger bridge and the Jira
 * issue-to-session integration), letting users find them alongside other
 * configuration in the Settings menu.
 */
export const IntegrationsPage: React.FC = () => {
  const { t } = useI18n();
  return (
    <ScrollableOverlay outerClassName="h-full" className="w-full">
      <div className="mx-auto w-full max-w-3xl px-3 py-6 sm:px-6 sm:pt-8 space-y-6">
        <div>
          <h2 className="typography-ui-header font-semibold text-foreground">
            {t('settings.page.integrations.title')}
          </h2>
          <p className="typography-meta text-muted-foreground">
            {t('settings.integrations.page.description')}
          </p>
        </div>

        <MessengerSection />

        <div className="border-t border-border pt-6">
          <JiraSection />
        </div>
      </div>
    </ScrollableOverlay>
  );
};
