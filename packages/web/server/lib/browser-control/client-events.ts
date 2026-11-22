import type { BrowserControlRequest } from './broker.js';
import { createPreferredBrowserClient, type BrowserEventClient } from './preferred-client.js';

export type BrowserClientEvent =
  | { type: 'openchamber:browser-control-preferred'; properties: { connectionId: string } }
  | {
    type: 'openchamber:browser-control-request';
    properties: BrowserControlRequest & { preferredConnectionId: string | null };
  };

const canDrivePage = (client: BrowserEventClient): boolean => client.openchamberBrowserCapable === true;
const anyClient = (): boolean => true;

export const createBrowserClientEvents = <Client extends BrowserEventClient>({ clients, writeEvent }: {
  clients: Set<Client>;
  writeEvent: (client: Client, event: BrowserClientEvent) => void;
}) => {
  const send = (event: BrowserClientEvent, accepts: (client: Client) => boolean): number => {
    let delivered = 0;
    for (const client of clients) {
      if (!accepts(client)) continue;
      try {
        writeEvent(client, event);
        delivered += 1;
      } catch {
        clients.delete(client);
      }
    }
    return delivered;
  };

  const preferredClient = createPreferredBrowserClient({
    getClients: () => clients,
    broadcast: (connectionId) => send(
      { type: 'openchamber:browser-control-preferred', properties: { connectionId } },
      canDrivePage,
    ),
  });

  const emitRequest = (request: BrowserControlRequest): number => send(
    {
      type: 'openchamber:browser-control-request',
      properties: {
        requestId: request.requestId,
        action: request.action,
        parameters: request.parameters,
        context: request.context,
        preferredConnectionId: preferredClient.current(),
      },
    },
    request.action === 'browser.open' ? anyClient : canDrivePage,
  );

  return { preferredClient, emitRequest };
};
