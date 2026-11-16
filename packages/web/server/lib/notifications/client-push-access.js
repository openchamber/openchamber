import { isActiveClient } from '../client-auth/remote-clients.js';
import { clientSessionKeyFor } from './session-key.js';

export const createClientPushAccess = ({ listClients, removeDevicesOfSessions }) => {
  const sessionKeysOf = (clients) => clients.map((client) => clientSessionKeyFor(client.id));

  const invalidSessionKeys = async () => {
    const clients = await listClients();
    return new Set(sessionKeysOf(clients.filter((client) => !isActiveClient(client))));
  };

  const removeDevicesOfClients = async (clientIds) => {
    const clients = await listClients();
    const keep = new Set(sessionKeysOf(clients.filter((client) => isActiveClient(client))));
    const sessionKeys = clientIds.map(clientSessionKeyFor);
    await Promise.all(removeDevicesOfSessions.map((remove) => remove(sessionKeys, keep)));
  };

  return { invalidSessionKeys, removeDevicesOfClients };
};
