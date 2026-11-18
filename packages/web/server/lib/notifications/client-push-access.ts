import { isActiveClient } from '../client-auth/remote-clients.js';
import { clientSessionKeyFor, sessionKeyFor } from './session-key.js';
import type { BearerRequest, RemoteClient } from '../client-auth/contracts.js';

const isLocalOnlyClient = (client: RemoteClient) => client.localOnly === true;

interface ClientPushAccessDependencies {
  listClients: () => Promise<RemoteClient[]>;
  removeDevicesOfSessions: ((sessionKeys: string[], keep: Set<string>) => Promise<void>)[];
  authenticateBearerClient: (req: BearerRequest) => Promise<RemoteClient | null>;
}

export const createClientPushAccess = ({ listClients, removeDevicesOfSessions, authenticateBearerClient }: ClientPushAccessDependencies) => {
  const sessionKeysOf = (clients: RemoteClient[]) => clients.map((client) => clientSessionKeyFor(client.id));

  const invalidSessionKeys = async () => {
    const clients = await listClients();
    return new Set(sessionKeysOf(clients.filter((client) => !isActiveClient(client) || isLocalOnlyClient(client))));
  };

  const isLocalOnlySession = async (uiSessionToken: string) => {
    const sessionKey = sessionKeyFor(uiSessionToken);
    const clients = await listClients();
    return clients.some((client) => isLocalOnlyClient(client) && isActiveClient(client) && clientSessionKeyFor(client.id) === sessionKey);
  };

  const isLocalOnlyRequest = async (req: BearerRequest, uiSessionToken: string) => {
    const bearerClient = await authenticateBearerClient(req);
    return bearerClient ? isLocalOnlyClient(bearerClient) : isLocalOnlySession(uiSessionToken);
  };

  const removeDevicesOfClients = async (clientIds: string[]) => {
    const clients = await listClients();
    const keep = new Set(sessionKeysOf(clients.filter((client) => isActiveClient(client))));
    const sessionKeys = clientIds.map(clientSessionKeyFor);
    await Promise.all(removeDevicesOfSessions.map((remove) => remove(sessionKeys, keep)));
  };

  return { invalidSessionKeys, isLocalOnlyRequest, removeDevicesOfClients };
};
