export interface BrowserEventClient {
  readonly openchamberConnectionId?: string;
  readonly openchamberBrowserCapable?: boolean;
}

export const createPreferredBrowserClient = ({ getClients, broadcast }: {
  getClients: () => Iterable<BrowserEventClient>;
  broadcast: (connectionId: string) => void;
}) => {
  let preferredId: string | null = null;

  const isCapableConnection = (connectionId: string): boolean => {
    for (const client of getClients()) {
      if (client.openchamberConnectionId === connectionId) return client.openchamberBrowserCapable === true;
    }
    return false;
  };

  const current = (): string | null => (preferredId && isCapableConnection(preferredId) ? preferredId : null);

  return {
    current,

    markActive(connectionId: string, previousConnectionId: string | null = null): string | null {
      if (!isCapableConnection(connectionId)) return null;
      const takesOver = previousConnectionId === null || preferredId === null || preferredId === previousConnectionId;
      if (takesOver && preferredId !== connectionId) {
        preferredId = connectionId;
        broadcast(connectionId);
      }
      return current();
    },
  };
};

export type PreferredBrowserClient = ReturnType<typeof createPreferredBrowserClient>;
