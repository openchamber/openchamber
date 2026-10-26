import React from 'react';
import type { IntegrationKeyMethod } from '@opencode/client';
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

/** The pill on one card. */
type MethodStatus = { label: string; tone: IntegrationCatalogStatusTone };

const METHOD_ICON = {
  key: 'key',
  oauth: 'user-3',
  external: 'terminal-box',
} satisfies Record<CredentialMethod, IconName>;

/** Account management for the cards of a connected provider. */
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
  /** The provider's own integration, which stores its API key. */
  integrationId: string;
  showApiKey: boolean;
  keyMethod: IntegrationKeyMethod | undefined;
  /** The integration whose sign-in methods serve the provider (`getSignInIntegrationId`). */
  signInIntegrationId: string;
  signInMethods: readonly SignInMethod[];
  /** The provider's stored credentials; environment connections are listed elsewhere. */
  credentials: readonly CredentialConnection[];
  /** Absent on the connect page, where nothing is stored yet. */
  accounts?: ProviderAuthAccounts;
  /**
   * A kind OpenCode uses without a stored credential of it: a key from an
   * environment variable or the config, or credentials on the server machine.
   */
  inUseWithoutCredential?: CredentialMethod | null;
  /** False in enterprise mode: stored accounts stay manageable, nothing new is added. */
  canAdd: boolean;
  connectKey: (request: IntegrationKeyRequest) => Promise<void>;
  onKeySaved: () => void;
  onSignedIn: () => void | Promise<void>;
}

/**
 * The ways to connect a provider, one collapsible card per kind of credential:
 * the API key, browser sign-in, and credentials on the server machine. Each
 * card holds the accounts of its kind and the form that adds another, and says
 * on its pill whether its kind is the one in use. A credential records its kind
 * but not the sign-in method that made it, so a provider with several sign-in
 * methods (OpenAI's ChatGPT and legacy Codex flows) offers them all in one card.
 *
 * Closing a card unmounts its body, which cancels a sign-in still waiting there.
 */
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
  // Credentials OpenCode uses without storing them mark their own card, or the
  // key card when the provider has no card of that kind.
  const inUseKind = inUseWithoutCredential !== null && !kinds.includes(inUseWithoutCredential) && kinds.includes('key')
    ? 'key'
    : inUseWithoutCredential;
  // A single way to connect has nothing to choose between, so it starts open.
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
    // Closing drops what was typed, so it reopens on Add account again.
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
    // Under a stored account an empty key field reads as "replace this key"
    // and a bare Connect as "reconnect", while both add another account that
    // becomes active; they wait behind Add account.
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
