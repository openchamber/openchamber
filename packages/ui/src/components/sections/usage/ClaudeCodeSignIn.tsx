import React from 'react';
import type { IntegrationInfo } from '@opencode/client';
import { ProviderOAuthMethods } from '@/components/sections/providers/ProviderOAuthMethods';
import { findIntegrationForProvider, getSignInMethods } from '@/components/sections/providers/providerAuth';
import { loadIntegrationCatalog, peekIntegrationCatalog } from '@/lib/opencode/integration-catalog';
import { useI18n } from '@/lib/i18n';

/** The integration the opencode-claude plugin registers for Claude Code. */
const CLAUDE_CODE_INTEGRATION_ID = 'claude-code';
const SIGN_IN_COMMAND = 'claude auth login';

type Lookup =
  | { state: 'loading' }
  | { state: 'ready'; integration: IntegrationInfo | undefined };

const lookupFrom = (integrations: readonly IntegrationInfo[]): Lookup => ({
  state: 'ready',
  integration: findIntegrationForProvider(integrations, CLAUDE_CODE_INTEGRATION_ID),
});

interface ClaudeCodeSignInProps {
  /** Runs once Claude Code holds a login again, so the caller can re-read usage. */
  onSignedIn: () => void | Promise<void>;
}

/**
 * Claude usage reads the login Claude Code itself keeps, so the fix for a
 * missing one is signing Claude Code in again. With the opencode-claude plugin
 * installed this is the plugin's own sign-in, the same one Providers shows;
 * without it, or when the list cannot be read, the user gets the terminal
 * command, which works either way.
 */
export const ClaudeCodeSignIn: React.FC<ClaudeCodeSignInProps> = ({ onSignedIn }) => {
  const { t } = useI18n();
  const [lookup, setLookup] = React.useState<Lookup>(() => {
    const cached = peekIntegrationCatalog();
    return cached ? lookupFrom(cached.integrations) : { state: 'loading' };
  });

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const catalog = await loadIntegrationCatalog();
        if (!cancelled) setLookup(lookupFrom(catalog.integrations));
      } catch (error) {
        console.error('Failed to load the Claude Code sign-in:', error);
        if (!cancelled) setLookup((current) => (current.state === 'loading' ? { state: 'ready', integration: undefined } : current));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (lookup.state === 'loading') return null;

  const methods = getSignInMethods(lookup.integration);
  if (!lookup.integration || methods.length === 0) {
    return (
      <div className="mt-1 space-y-1.5">
        <p className="typography-meta text-[var(--status-warning)]/80">{t('settings.usage.page.state.claudeSignInCommand')}</p>
        <code className="typography-code block whitespace-pre-wrap break-all rounded bg-muted/50 px-2 py-1.5 text-xs text-foreground">{SIGN_IN_COMMAND}</code>
      </div>
    );
  }

  return (
    <ProviderOAuthMethods
      key={lookup.integration.id}
      integrationId={lookup.integration.id}
      methods={methods}
      onConnected={onSignedIn}
      className="mt-3"
    />
  );
};
