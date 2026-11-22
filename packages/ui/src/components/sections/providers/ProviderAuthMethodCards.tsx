import React from 'react';
import type { IntegrationKeyMethod } from '@/lib/opencode/model';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import {
  IntegrationCatalogCard,
  type IntegrationCatalogStatusTone,
} from '@/components/sections/integrations/IntegrationCatalogCard';
import { useI18n } from '@/lib/i18n';
import { ProviderAccounts } from './ProviderAccounts';
import { ProviderApiKeyForm, type IntegrationKeyRequest } from './ProviderApiKeyForm';
import { ProviderOAuthMethods } from './ProviderOAuthMethods';
import { connectionNeedsAuth, type CredentialConnection, type SignInMethod } from './providerAuth';

type CredentialMethod = CredentialConnection['method'];

type MethodStatus = { label: string; tone: IntegrationCatalogStatusTone };

const METHOD_ICON = {
  key: 'key',
  oauth: 'user-3',
  external: 'terminal-box',
} satisfies Record<CredentialMethod, IconName>;

interface ProviderAuthAccounts {
  activeId: string | null;
  unusedIds: ReadonlySet<string>;
  busyId: string | null;
  canSwitch: boolean;
  showActive: boolean;
  onActivate: (account: CredentialConnection) => void;
  onRename: (account: CredentialConnection, label: string) => void;
  onRemove: (account: CredentialConnection) => void;
}

interface ProviderAuthMethodCardsProps {
  integrationId: string;
  showApiKey: boolean;
  keyMethod: IntegrationKeyMethod | undefined;
  signInIntegrationId: string;
  signInMethods: readonly SignInMethod[];
  credentials: readonly CredentialConnection[];
  accounts?: ProviderAuthAccounts;
  inUseWithoutCredential?: CredentialMethod | null;
  canAdd: boolean;
  connectKey: (request: IntegrationKeyRequest) => Promise<void>;
  onKeySaved: () => void;
  onSignedIn: () => void | Promise<void>;
}

export const ProviderAuthMethodCards: React.FC<ProviderAuthMethodCardsProps> = ({
  integrationId,
  showApiKey,
  keyMethod,
  signInIntegrationId,
  signInMethods,
  credentials,
  accounts,
  inUseWithoutCredential = null,
  canAdd,
  connectKey,
  onKeySaved,
  onSignedIn,
}) => {
  const { t } = useI18n();
  const oauthMethods = signInMethods.filter((method) => method.type === 'oauth');
  const externalMethods = signInMethods.filter((method) => method.type === 'external');
  const kinds = ([
    showApiKey ? 'key' : null,
    oauthMethods.length > 0 ? 'oauth' : null,
    externalMethods.length > 0 ? 'external' : null,
  ] satisfies Array<CredentialMethod | null>)
    .filter((kind): kind is CredentialMethod => kind !== null)
    .filter((kind) => canAdd || credentials.some((credential) => credential.method === kind));
  const inUseKind = inUseWithoutCredential !== null && !kinds.includes(inUseWithoutCredential) && kinds.includes('key')
    ? 'key'
    : inUseWithoutCredential;
  const [openKinds, setOpenKinds] = React.useState<ReadonlySet<CredentialMethod>>(
    () => new Set(kinds.length === 1 ? kinds : []),
  );
  const [addingKinds, setAddingKinds] = React.useState<ReadonlySet<CredentialMethod>>(() => new Set());
  const setOpen = (kind: CredentialMethod, open: boolean) => {
    setOpenKinds((previous) => {
      const next = new Set(previous);
      if (open) next.add(kind);
      else next.delete(kind);
      return next;
    });
    if (!open) stopAdding(kind);
  };

  const statusOf = (kind: CredentialMethod, stored: readonly CredentialConnection[]): MethodStatus => {
    if (stored.some(connectionNeedsAuth)) {
      return { label: t('settings.providers.card.status.reauthNeeded'), tone: 'warning' };
    }
    if (stored.some((credential) => credential.id === accounts?.activeId) || inUseKind === kind) {
      return { label: t('settings.providers.methods.status.inUse'), tone: 'success' };
    }
    if (stored.length > 0) return { label: t('settings.providers.methods.status.notInUse'), tone: 'neutral' };
    return { label: t('settings.providers.methods.status.notConnected'), tone: 'neutral' };
  };

  const stopAdding = (kind: CredentialMethod) => {
    setAddingKinds((previous) => {
      const next = new Set(previous);
      next.delete(kind);
      return next;
    });
  };

  const renderAddForm = (kind: CredentialMethod, hasAccounts: boolean) => {
    if (hasAccounts && !addingKinds.has(kind)) {
      return (
        <Button
          variant="outline"
          size="xs"
          className="!font-normal"
          onClick={() => setAddingKinds((previous) => new Set(previous).add(kind))}
        >
          <Icon name="add" className="size-3.5" />
          {t('settings.providers.accounts.add')}
        </Button>
      );
    }
    if (kind === 'key') {
      return (
        <ProviderApiKeyForm
          key={integrationId}
          integrationId={integrationId}
          keyMethod={keyMethod}
          connectKey={connectKey}
          onSaved={() => {
            stopAdding(kind);
            onKeySaved();
          }}
        />
      );
    }
    const methods = kind === 'oauth' ? oauthMethods : externalMethods;
    return (
      <ProviderOAuthMethods
        key={`${signInIntegrationId}:${kind}`}
        integrationId={signInIntegrationId}
        methods={methods}
        onConnected={() => {
          stopAdding(kind);
          return onSignedIn();
        }}
        showMethodLabels={methods.length > 1}
      />
    );
  };

  const nameOf = (kind: CredentialMethod) => {
    if (kind === 'key') return t('settings.providers.page.auth.apiKeyLabel');
    return (kind === 'oauth' ? oauthMethods : externalMethods)[0]?.label ?? '';
  };

  const descriptionOf = (kind: CredentialMethod) => {
    if (kind === 'key') return t('settings.providers.methods.key.description');
    if (kind === 'oauth') return t('settings.providers.methods.oauth.description');
    return t('settings.providers.methods.external.description');
  };

  return (
    <div className="space-y-3">
      {kinds.map((kind) => {
        const stored = credentials.filter((credential) => credential.method === kind);
        const status = statusOf(kind, stored);
        return (
          <IntegrationCatalogCard
            key={kind}
            logo={<Icon name={METHOD_ICON[kind]} className="size-5 text-foreground" />}
            name={nameOf(kind)}
            description={descriptionOf(kind)}
            keepDescriptionWhenNarrow
            status={status.label}
            statusTone={status.tone}
            open={openKinds.has(kind)}
            onOpenChange={(open) => setOpen(kind, open)}
          >
            <div className="space-y-3">
              {accounts && stored.length > 0 ? (
                <ProviderAccounts
                  connections={stored}
                  activeId={accounts.activeId}
                  unusedIds={accounts.unusedIds}
                  busyId={accounts.busyId}
                  canSwitch={accounts.canSwitch}
                  showActive={accounts.showActive}
                  onActivate={accounts.onActivate}
                  onRename={accounts.onRename}
                  onRemove={accounts.onRemove}
                />
              ) : null}
              {canAdd ? renderAddForm(kind, stored.length > 0) : null}
            </div>
          </IntegrationCatalogCard>
        );
      })}
    </div>
  );
};
