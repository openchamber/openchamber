import React from 'react';
import { useI18n } from '@/lib/i18n';
import { ProviderAuthMethodCards } from './ProviderAuthMethodCards';

const NO_CREDENTIALS: [] = [];
const ignore = () => {};
const ignoreKey = async () => {};

export const ProviderAuthMethodsLoading: React.FC<{ integrationId: string; canAdd: boolean }> = ({ integrationId, canAdd }) => {
  const { t } = useI18n();
  return (
    <div className="grid">
      <div className="invisible col-start-1 row-start-1 min-w-0" aria-hidden="true" inert data-reserved-space>
        <ProviderAuthMethodCards
          integrationId={integrationId}
          showApiKey
          keyMethod={undefined}
          signInIntegrationId={integrationId}
          signInMethods={NO_CREDENTIALS}
          credentials={NO_CREDENTIALS}
          canAdd={canAdd}
          directory={null}
          connectKey={ignoreKey}
          onKeySaved={ignore}
          onSignedIn={ignore}
        />
      </div>
      <p className="col-start-1 row-start-1 py-1.5 typography-meta text-muted-foreground">
        {t('settings.providers.page.auth.loadingMethods')}
      </p>
    </div>
  );
};
