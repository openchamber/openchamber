import { z } from 'zod';

import { readKeyCredentials, readLaunchEnvironment, readOpenCodeProviders } from '../opencode/auth.js';
import { hasProviderServerGrant, isProviderServerApproved, keyIdOf, speechServerOrigin } from './voice-keys.js';

const ENV_REFERENCE = /^\{env:([^}]+)\}$/;

const text = z.string().trim().min(1);

const resolveEnvReference = (configured: string | undefined, environment: NodeJS.ProcessEnv | null) => {
  const name = configured?.match(ENV_REFERENCE)?.[1]?.trim();
  return name === undefined ? configured : text.safeParse(environment?.[name]).data;
};

export interface KeyProvider {
  id: string;
  name: string;
  origin: string | null;
  key: string;
  credentialID?: string | undefined;
}

const HEADER_SAFE_KEY = /^[\x21-\x7e]([\x20-\x7e]*[\x21-\x7e])?$/;
const warnedUnsafe = new Set<string>();

export const readKeyProviders = async (): Promise<KeyProvider[]> => {
  const providers = await readOpenCodeProviders();
  const credentials = await readKeyCredentials();
  const environment = readLaunchEnvironment();
  const result: KeyProvider[] = [];
  for (const provider of providers) {
    const stored = credentials[provider.integrationID ?? provider.id];
    const fromStore = stored?.credentialID === undefined ? undefined : stored;
    const configured = provider.settings?.apiKey;
    const fromSettings = provider.id === 'opencode' && configured === 'public' ? undefined : text.safeParse(configured).data;
    const key = fromStore?.key ?? resolveEnvReference(fromSettings, environment) ?? stored?.key;
    if (key === undefined) continue;
    if (!HEADER_SAFE_KEY.test(key)) {
      if (!warnedUnsafe.has(provider.id)) {
        warnedUnsafe.add(provider.id);
        console.warn(`[voice] the key of provider ${provider.id} would change in an HTTP header, so it is not offered`);
      }
      continue;
    }
    result.push({
      id: provider.id,
      name: provider.name,
      origin: speechServerOrigin(text.safeParse(provider.settings?.baseURL).data),
      key,
      credentialID: fromStore?.credentialID,
    });
  }
  return result;
};

const readKeyProvidersOrNone = async () => {
  try {
    return await readKeyProviders();
  } catch (error) {
    console.warn('[voice] OpenCode providers are unreadable:', error instanceof Error ? error.message : error);
    return [];
  }
};

export const describeKeyProviders = async (address: string | undefined) => {
  const origin = speechServerOrigin(address);
  return (await readKeyProviders()).map((provider) => ({
    id: provider.id,
    name: provider.name,
    keyId: keyIdOf(provider.key),
    matches: origin !== null && provider.origin === origin,
    approved: origin !== null && isProviderServerApproved(provider, origin),
  }));
};

export const resolveProviderKey = async (choice: string | undefined, address: string) => {
  const origin = speechServerOrigin(address);
  if (choice === '' || origin === null) return null;
  const providers = await readKeyProvidersOrNone();
  const sameOrigin = providers.filter((provider) => provider.origin === origin);
  const provider = choice === undefined ? (sameOrigin.length === 1 ? sameOrigin[0] : undefined) : providers.find((candidate) => candidate.id === choice);
  if (provider === undefined) return null;
  return { provider, keyId: keyIdOf(provider.key), approvedKey: isProviderServerApproved(provider, origin) ? provider.key : undefined };
};

export const approvedProviderKey = async (choice: string | undefined, address: string | undefined) => {
  const origin = speechServerOrigin(address);
  if (choice === '' || origin === null || !hasProviderServerGrant(origin, choice)) return undefined;
  return (await resolveProviderKey(choice, origin))?.approvedKey;
};

export const findKeyProvider = async (id: string) => (await readKeyProviders()).find((provider) => provider.id === id);
