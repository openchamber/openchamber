import { isActiveClient } from '../client-auth/remote-clients.js';
import { clientSessionKeyFor } from './session-key.js';

// Connects the paired-device list to the push stores: a device whose client
// was revoked or expired gets no notification.
export const createClientPushAccess = ({ listClients, removeDevicesOfSessions }) => {
  const sessionKeysOf = (clients) => clients.map((client) => clientSessionKeyFor(client.id));

  // Read before every send, so a registration that outlived its cleanup, or one
  // left by a build without it, still gets nothing while its client is listed.
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
