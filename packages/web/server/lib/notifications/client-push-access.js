import { isActiveClient } from '../client-auth/remote-clients.js';
import { clientSessionKeyFor, sessionKeyFor } from './session-key.js';

const isLocalOnlyClient = (client) => client.localOnly === true;

export const createClientPushAccess = ({ listClients, removeDevicesOfSessions, authenticateBearerClient }) => {
  const sessionKeysOf = (clients) => clients.map((client) => clientSessionKeyFor(client.id));

  const invalidSessionKeys = async () => {
    const clients = await listClients();
    return new Set(sessionKeysOf(clients.filter((client) => !isActiveClient(client) || isLocalOnlyClient(client))));
  };

  const isLocalOnlySession = async (uiSessionToken) => {
    const sessionKey = sessionKeyFor(uiSessionToken);
    const clients = await listClients();
    return clients.some((client) => isLocalOnlyClient(client) && isActiveClient(client) && clientSessionKeyFor(client.id) === sessionKey);
  };

  const isLocalOnlyRequest = async (req, uiSessionToken) => {
    const bearerClient = await authenticateBearerClient(req);
    return bearerClient ? isLocalOnlyClient(bearerClient) : isLocalOnlySession(uiSessionToken);
  };

  const removeDevicesOfClients = async (clientIds) => {
    const clients = await listClients();
    const keep = new Set(sessionKeysOf(clients.filter((client) => isActiveClient(client))));
    const sessionKeys = clientIds.map(clientSessionKeyFor);
    await Promise.all(removeDevicesOfSessions.map((remove) => remove(sessionKeys, keep)));
  };

  return { invalidSessionKeys, isLocalOnlyRequest, removeDevicesOfClients };
};
