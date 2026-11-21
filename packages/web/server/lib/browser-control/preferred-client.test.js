import { describe, expect, it } from 'vitest';

import { createPreferredBrowserClient } from './preferred-client.js';

const connection = (id, capable = true) => ({ openchamberConnectionId: id, openchamberBrowserCapable: capable });

const setup = (clients) => {
  const broadcasts = [];
  const preferred = createPreferredBrowserClient({
    getClients: () => clients,
    broadcast: (connectionId) => broadcasts.push(connectionId),
  });
  return { preferred, broadcasts };
};

describe('the preferred browser client', () => {
  it('becomes the window the user acted in last, and tells everyone once per change', () => {
    const { preferred, broadcasts } = setup(new Set([connection('mac'), connection('windows')]));

    preferred.markActive('mac');
    preferred.markActive('windows');
    preferred.markActive('windows');

    expect(preferred.current()).toBe('windows');
    expect(broadcasts).toEqual(['mac', 'windows']);
  });

  it('refuses a window that cannot drive a page', () => {
    const { preferred, broadcasts } = setup(new Set([connection('desktop'), connection('web-tab', false)]));
    preferred.markActive('desktop');

    expect(preferred.markActive('web-tab')).toBeNull();
    expect(preferred.current()).toBe('desktop');
    expect(broadcasts).toEqual(['desktop']);
  });

  it('refuses a connection that is not open', () => {
    const { preferred } = setup(new Set([connection('desktop')]));

    expect(preferred.markActive('gone')).toBeNull();
    expect(preferred.current()).toBeNull();
  });

  it('names nobody once the preferred window disconnects', () => {
    const windows = connection('windows');
    const clients = new Set([connection('mac'), windows]);
    const { preferred } = setup(clients);
    preferred.markActive('windows');

    clients.delete(windows);

    expect(preferred.current()).toBeNull();
  });

  it('gives a reconnecting window the preference back when nobody took it meanwhile', () => {
    const before = connection('windows-1');
    const clients = new Set([connection('mac'), before]);
    const { preferred } = setup(clients);
    preferred.markActive('windows-1');
    clients.delete(before);
    clients.add(connection('windows-2'));

    expect(preferred.markActive('windows-2', 'windows-1')).toBe('windows-2');
  });

  it('leaves the preference with the window the user moved to while another reconnected', () => {
    const before = connection('windows-1');
    const clients = new Set([connection('mac'), before]);
    const { preferred, broadcasts } = setup(clients);
    preferred.markActive('windows-1');
    clients.delete(before);
    preferred.markActive('mac');
    clients.add(connection('windows-2'));

    expect(preferred.markActive('windows-2', 'windows-1')).toBe('mac');
    expect(broadcasts).toEqual(['windows-1', 'mac']);
  });

  it('does not hand the preference back when the window the user moved to has disconnected too', () => {
    const before = connection('windows-1');
    const mac = connection('mac');
    const clients = new Set([mac, before]);
    const { preferred, broadcasts } = setup(clients);
    preferred.markActive('windows-1');
    clients.delete(before);
    preferred.markActive('mac');
    clients.delete(mac);
    clients.add(connection('windows-2'));

    expect(preferred.markActive('windows-2', 'windows-1')).toBeNull();
    expect(preferred.current()).toBeNull();
    expect(preferred.markActive('windows-2')).toBe('windows-2');
    expect(broadcasts).toEqual(['windows-1', 'mac', 'windows-2']);
  });
});
