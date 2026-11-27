import { getIntegrationClient } from '@/lib/opencode/integration-catalog';
import { opencodeClient } from '@/lib/opencode/client';
import type { Integration } from '@/lib/opencode/model';
import { findIntegrationForProvider, getCredentialConnections } from './providerAuth';

type KeyRequest = { integrationID: string; key: string };

export async function removeProviderCredentials(integrations: readonly Integration[] | null, providerId: string): Promise<void> {
  const sdk = opencodeClient.getSdkClient();
  for (const credential of getCredentialConnections(findIntegrationForProvider(integrations ?? [], providerId))) {
    await sdk.credential.remove({ credentialID: credential.id });
  }
}

const KEY_RETRY_FIRST_DELAYS_MS = [250, 500];
const KEY_RETRY_INTERVAL_MS = 1_000;
const KEY_RETRY_LIMIT_MS = 30_000;

export async function connectProviderKey(directory: string | null, request: KeyRequest): Promise<void> {
  await getIntegrationClient(directory).integration.connect.key(request);
}

export async function storeKeyAfterConfigWrite(
  connectKey: () => Promise<unknown>,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<void> {
  for (let attempt = 0, waited = 0; ; attempt += 1) {
    try {
      await connectKey();
      return;
    } catch (error) {
      const notRegisteredYet = error instanceof Error && /integration not found/i.test(error.message);
      if (!notRegisteredYet || waited >= KEY_RETRY_LIMIT_MS) throw error;
      const delay = KEY_RETRY_FIRST_DELAYS_MS[attempt] ?? KEY_RETRY_INTERVAL_MS;
      waited += delay;
      await wait(delay);
    }
  }
}

export function storeCustomProviderKey(directory: string | null, request: KeyRequest): Promise<void> {
  return storeKeyAfterConfigWrite(() => connectProviderKey(directory, request));
}
