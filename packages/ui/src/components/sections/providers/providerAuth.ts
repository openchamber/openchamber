/**
 * Provider credential helpers.
 *
 * OpenCode v2 moved provider sign-in behind *integrations*: `GET /api/integration`
 * lists, per integration, the methods it accepts (`oauth`, `key`, `command`,
 * `env`) and the connections that are already live (a stored credential, or an
 * environment variable the server can see). There is no `auth.json` any more,
 * so "does this provider have credentials" is answered by its integration's
 * connections rather than by a local file.
 */

import type { ConnectionInfo, IntegrationInfo, IntegrationKeyMethod, IntegrationOAuthMethod } from '@opencode/client';

export type ProviderIntegration = IntegrationInfo;

/** Integrations are keyed by their own id; a provider matches on the same id. */
export const findIntegrationForProvider = (
  integrations: readonly IntegrationInfo[],
  providerId: string,
): IntegrationInfo | undefined => integrations.find((integration) => integration.id === providerId);

/**
 * OpenCode Go bills through the OpenCode Console, so it signs in through the
 * Console's `opencode` integration; its own integration only accepts a
 * service-account key. OpenCode's own connect dialog makes the same mapping.
 * Returns the integration whose OAuth methods sign a provider in.
 */
export const getSignInIntegrationId = (providerId: string): string =>
  providerId === 'opencode-go' ? 'opencode' : providerId;

/**
 * Connections that give a provider credentials: its own, plus the sign-in
 * integration's when the provider signs in elsewhere.
 */
export const getProviderConnections = (
  integrations: readonly IntegrationInfo[],
  providerId: string,
): ConnectionInfo[] | undefined => {
  const own = findIntegrationForProvider(integrations, providerId)?.connections;
  const signInId = getSignInIntegrationId(providerId);
  if (signInId === providerId) return own;
  const signIn = findIntegrationForProvider(integrations, signInId)?.connections;
  if (!own && !signIn) return undefined;
  return [...(own ?? []), ...(signIn ?? [])];
};

export const getOAuthMethods = (
  integration: IntegrationInfo | undefined,
): IntegrationOAuthMethod[] =>
  (integration?.methods ?? []).filter((method): method is IntegrationOAuthMethod => method.type === 'oauth');

export const getKeyMethod = (
  integration: IntegrationInfo | undefined,
): IntegrationKeyMethod | undefined =>
  (integration?.methods ?? []).find((method): method is IntegrationKeyMethod => method.type === 'key');

/**
 * Show the API key form when the integration accepts a key, or when the
 * integration is unknown — a provider OpenCode has no integration for (a custom
 * one from opencode.json) is still keyed by an API key. OAuth-only integrations
 * must not get an API key prompt.
 */
export const shouldShowApiKeyAuth = (integration: IntegrationInfo | undefined): boolean =>
  integration === undefined || getKeyMethod(integration) !== undefined;

/** Stored credentials, which are the only connections the user can remove. */
export const getCredentialConnections = (
  integration: IntegrationInfo | undefined,
): Extract<ConnectionInfo, { type: 'credential' }>[] =>
  (integration?.connections ?? []).filter(
    (connection): connection is Extract<ConnectionInfo, { type: 'credential' }> => connection.type === 'credential',
  );

export interface ProviderCredentialInput {
  /**
   * Connections the provider's integration reports. A stored credential or a
   * resolved environment variable both count as a usable login.
   */
  connections?: readonly ConnectionInfo[];
  /**
   * Provider.options is shipped to the client for config-defined providers, so
   * a custom provider whose key is written straight into opencode.json has no
   * integration connection but is still logged in.
   */
  optionsApiKey?: string | null;
}

/**
 * Prefer authoritative credential signals: the server either reports a
 * connection for the integration or it does not. An inline `options.apiKey` is
 * the one case the server cannot see as a connection.
 */
export const providerHasCredentials = (input: ProviderCredentialInput): boolean => {
  if ((input.connections?.length ?? 0) > 0) {
    return true;
  }
  return typeof input.optionsApiKey === 'string' && input.optionsApiKey.trim().length > 0;
};

export const shouldShowModelsSection = (input: {
  modelCount: number;
  /** False while the integration list is still loading. */
  integrationsLoaded: boolean;
  hasCredentials: boolean;
  /**
   * Config-defined custom providers (providerSources.custom present and parsed
   * via `isConfigDefinedCustomProvider`) are user-editable in place, so a
   * stale `Credentials missing` signal must not hide their models section.
   */
  isEditableCustomProvider?: boolean;
}): boolean =>
  input.modelCount > 0 &&
  (!input.integrationsLoaded || input.hasCredentials || Boolean(input.isEditableCustomProvider));

export const shouldAutoOpenAuthPanel = (input: {
  integrationsLoaded: boolean;
  hasCredentials: boolean;
  userDismissed: boolean;
  /**
   * Config-defined custom providers do not auto-open the auth panel: the
   * provider is editable directly in the form, and a stale `Credentials
   * missing` summary would be misleading.
   */
  isEditableCustomProvider?: boolean;
}): boolean =>
  input.integrationsLoaded &&
  !input.hasCredentials &&
  !input.userDismissed &&
  !input.isEditableCustomProvider;
