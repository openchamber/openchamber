import React from 'react';
import { MessengerSection } from '@/components/sections/otto-settings/MessengerSection';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';

/**
 * Settings → Integrations.
 *
 * Hosts external integrations (currently the Discord messenger bridge),
 * letting users find them alongside other configuration in the Settings menu.
 */
export const IntegrationsPage: React.FC = () => {
  return (
    <ScrollableOverlay outerClassName="h-full" className="w-full">
      <div className="mx-auto w-full max-w-3xl px-3 py-6 sm:px-6 sm:pt-8 space-y-6">
        <div>
          <h2 className="typography-ui-header font-semibold text-foreground">Integrations</h2>
          <p className="typography-meta text-muted-foreground">
            Connect external messengers to chat with your assistant.
          </p>
        </div>

        <MessengerSection />
      </div>
    </ScrollableOverlay>
  );
};
