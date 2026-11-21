import { describe, expect, it } from 'vitest';

import { createBrowserClientEvents } from './client-events.js';

const client = (id, capable, broken = false) => ({ openchamberConnectionId: id, openchamberBrowserCapable: capable, broken });

const setup = (...connected) => {
  const clients = new Set(connected);
  const written = [];
  const events = createBrowserClientEvents({
    clients,
    writeEvent: (target, event) => {
      if (target.broken) throw new Error('stream closed');
      written.push({ to: target.openchamberConnectionId, type: event.type, properties: event.properties });
    },
  });
  return { clients, written, events };
};

const request = (action) => ({ requestId: 'req-1', action, parameters: {}, context: { directory: null, sessionId: null } });

describe('browser control events to clients', () => {
  it('offers a new page to every window, and the rest only to windows that can drive a page', () => {
    const { written, events } = setup(client('desktop', true), client('web-tab', false));

    expect(events.emitRequest(request('browser.open'))).toBe(2);
    expect(events.emitRequest(request('browser.click'))).toBe(1);
    expect(written.map((entry) => entry.to)).toEqual(['desktop', 'web-tab', 'desktop']);
  });

  it('drops a client whose stream fails and does not count it', () => {
    const broken = client('gone', true, true);
    const { clients, events } = setup(client('desktop', true), broken);

    expect(events.emitRequest(request('browser.click'))).toBe(1);
    expect(clients.has(broken)).toBe(false);
  });

  it('names the preferred window in each request, and tells only page-driving windows when it changes', () => {
    const { written, events } = setup(client('desktop', true), client('web-tab', false));

    events.preferredClient.markActive('desktop');
    events.emitRequest(request('browser.open'));

    expect(written.filter((entry) => entry.type === 'openchamber:browser-control-preferred'))
      .toEqual([{ to: 'desktop', type: 'openchamber:browser-control-preferred', properties: { connectionId: 'desktop' } }]);
    expect(written.filter((entry) => entry.type === 'openchamber:browser-control-request').map((entry) => entry.properties.preferredConnectionId))
      .toEqual(['desktop', 'desktop']);
  });
});
