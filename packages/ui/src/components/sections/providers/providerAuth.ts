
import type {
  ConnectionInfo,
  IntegrationExternalMethod,
  IntegrationInfo,
  IntegrationKeyMethod,
  IntegrationOAuthMethod,
} from '@opencode/client';
import { z } from 'zod';
import type { Provider } from '@/lib/opencode/model';

export type CredentialConnection = Extract<ConnectionInfo, { type: 'credential' }>;

const providerApiKeySetting = z.string();
export const readProviderApiKeySetting = (provider: Pick<Provider, 'settings'> | undefined): string | null =>
  providerApiKeySetting.safeParse(provider?.settings?.apiKey).data ?? null;

// external: https://cloud.google.com/docs/authentication/application-default-credentials Vertex uses server-machine credentials; OpenCode reports a resolved project instead of a stored connection.
const vertexProjectSetting = z.string().min(1);
export const usesMachineCredentials = (provider: Pick<Provider, 'id' | 'package' | 'settings'> | undefined): boolean =>
  provider !== undefined
  && (provider.id === 'google-vertex' || provider.package.startsWith('@opencode/ai/providers/google-vertex'))
  && vertexProjectSetting.safeParse(provider.settings?.project).success;

export const findIntegrationForProvider = (
  integrations: readonly IntegrationInfo[],
  providerId: string,
): IntegrationInfo | undefined => integrations.find((integration) => integration.id === providerId);

export const getSignInIntegrationId = (providerId: string): string =>
  providerId === 'opencode-go' ? 'opencode' : providerId;

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

export type SignInMethod = IntegrationOAuthMethod | IntegrationExternalMethod;

export const getSignInMethods = (
  integration: IntegrationInfo | undefined,
): SignInMethod[] =>
  (integration?.methods ?? []).filter((method): method is SignInMethod => method.type === 'oauth' || method.type === 'external');

export const getKeyMethod = (
  integration: IntegrationInfo | undefined,
): IntegrationKeyMethod | undefined =>
  (integration?.methods ?? []).find((method): method is IntegrationKeyMethod => method.type === 'key');

export const shouldShowApiKeyAuth = (integration: IntegrationInfo | undefined): boolean =>
  integration === undefined || getKeyMethod(integration) !== undefined;

export const getCredentialConnections = (
  integration: IntegrationInfo | undefined,
): CredentialConnection[] =>
  (integration?.connections ?? []).filter(
    (connection): connection is CredentialConnection => connection.type === 'credential',
  );

export const providerHoldsStoredLogin = (
  integrations: readonly IntegrationInfo[] | null,
  provider: Pick<Provider, 'id' | 'integrationID'>,
): boolean => {
  if (integrations === null) return false;
  const listed = getProviderConnections(integrations, provider.id) ?? [];
  return getCredentialConnections(findIntegrationForProvider(integrations, provider.integrationID ?? provider.id))
    .some((credential) => listed.includes(credential));
};

interface ProviderCredentialInput {
  connections?: readonly ConnectionInfo[];
  optionsApiKey?: string | null;
  machineCredentials?: boolean;
}

export const providerHasCredentials = (input: ProviderCredentialInput): boolean => {
  if ((input.connections?.length ?? 0) > 0 || input.machineCredentials) {
    return true;
  }
  return typeof input.optionsApiKey === 'string' && input.optionsApiKey.trim().length > 0;
};

export const connectionNeedsAuth = (connection: ConnectionInfo): boolean =>
  connection.status?.status === 'needs_auth';

export type ProviderCardStatus =
  | { kind: 'reauthNeeded' }
  | { kind: 'accounts'; count: number }
  | { kind: 'connected' }
  | { kind: 'noModels' }
  | { kind: 'environment' }
  | { kind: 'signInNeeded' };

export const getProviderCardStatus = (input: {
  integrations: readonly IntegrationInfo[] | null;
  providerId: string;
  optionsApiKey?: string | null;
  machineCredentials?: boolean;
  noModels?: boolean;
}): ProviderCardStatus | null => {
  if (input.integrations === null) return null;
  const connections = getProviderConnections(input.integrations, input.providerId);
  if ((connections ?? []).some(connectionNeedsAuth)) return { kind: 'reauthNeeded' };
  if (input.noModels) return { kind: 'noModels' };
  const credentialCount = (connections ?? []).filter((connection) => connection.type === 'credential').length;
  if (credentialCount > 1) return { kind: 'accounts', count: credentialCount };
  if (credentialCount === 1 || (input.optionsApiKey?.trim().length ?? 0) > 0) return { kind: 'connected' };
  if (input.machineCredentials || (connections ?? []).some((connection) => connection.type === 'env')) return { kind: 'environment' };
  return connections === undefined ? null : { kind: 'signInNeeded' };
};

export const getAccountSwitching = (connections: readonly ConnectionInfo[], unusedIds: ReadonlySet<string>) => {
  const credentials = connections.filter((connection) => connection.type === 'credential');
  return {
    canSwitch: credentials.filter((connection) => !unusedIds.has(connection.id)).length > 1,
    showActive: credentials.length > 1,
  };
};

export const shouldShowModelsSection = (input: {
  modelCount: number;
  integrationsLoaded: boolean;
  hasCredentials: boolean;
  isEditableCustomProvider?: boolean;
}): boolean =>
  input.modelCount > 0 &&
  (!input.integrationsLoaded || input.hasCredentials || Boolean(input.isEditableCustomProvider));
