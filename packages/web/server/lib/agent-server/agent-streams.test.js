import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAgentStreams } from './agent-streams.js';

const encoder = new TextEncoder();
const streams = [];
afterEach(async () => {
  await Promise.all(streams.splice(0).map((stream) => stream.close()));
});

const setup = (options = {}) => {
  const controls = new Map();
  const upstream = {
    buildUrl: (route) => `http://agent.test${route}`,
    fetch: vi.fn(async (url, { signal }) => new Response(new ReadableStream({
      start(controller) {
        controls.set(new URL(url).pathname, controller);
        signal.addEventListener('abort', () => controller.close(), { once: true });
      },
    }), { headers: { 'content-type': 'text/event-stream' } })),
  };
  const broadcastUiEvent = vi.fn();
  const broadcastGlobalUiEvent = vi.fn();
  const logger = { warn: vi.fn() };
  const stream = createAgentStreams({ upstream, broadcastUiEvent, broadcastGlobalUiEvent, logger, ...options });
  streams.push(stream);
  stream.start();
  const send = async (type, properties, source = 'control', extra = {}) => {
    await Promise.resolve();
    const route = source === 'control' ? '/api/openchamber/events' : '/api/notifications/stream';
    controls.get(route).enqueue(encoder.encode(`data: ${JSON.stringify({ type, properties, ...extra })}\n\n`));
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { stream, upstream, broadcastUiEvent, broadcastGlobalUiEvent, logger, send };
};
const context = { directory: '/work/repo', sessionId: 'ses_agent' };
const request = { requestId: 'browser-1', action: 'browser.open', parameters: { url: 'https://example.com/' }, context };

describe('agent server streams', () => {
  it('reports validated upstream control ids and clears them on disconnect without broadcasting ready', async () => {
    // Given a control-connection consumer.
    const onControlConnection = vi.fn();
    const { stream, send, broadcastUiEvent } = setup({ onControlConnection });
    // When ready frames arrive, then only valid control ids reach that consumer.
    await send('openchamber:event-stream-ready', { connectionId: 'agent-1', connectedAt: 1 });
    await send('openchamber:event-stream-ready', { connectionId: 'forged', connectedAt: 'invalid' });
    await send('openchamber:event-stream-ready', { connectionId: 'notification-id', connectedAt: 1 }, 'notifications');
    expect(onControlConnection).toHaveBeenCalledExactlyOnceWith('agent-1');
    expect(broadcastUiEvent).not.toHaveBeenCalled();
    await stream.close();
    expect(onControlConnection.mock.calls).toEqual([['agent-1'], [null]]);
  });
  it('refuses typed events claiming a session already owned by a Space', async () => {
    const { send, broadcastGlobalUiEvent } = setup({ isSpaceSession: (id) => id === 'ses_space' });
    await send('openchamber:session-activity', { sessionId: 'ses_space', phase: 'busy' }, 'notifications');
    await send('openchamber:session-activity', { sessionId: 'ses_agent', phase: 'busy' }, 'notifications');
    expect(broadcastGlobalUiEvent).toHaveBeenCalledOnce();
    expect(broadcastGlobalUiEvent.mock.calls[0][0].properties.sessionId).toBe('ses_agent');
  });
  it('owns two authenticated readers and stops each on close', async () => {
    const { stream, upstream } = setup();
    stream.start();
    await Promise.resolve();
    expect(upstream.fetch.mock.calls.map(([url]) => url)).toEqual([
      'http://agent.test/api/openchamber/events?browser=1', 'http://agent.test/api/notifications/stream',
    ]);
    expect(upstream.fetch.mock.calls.every(([, init]) => init.headers.Accept === 'text/event-stream')).toBe(true);
    await stream.close();
    expect(upstream.fetch.mock.calls.every(([, init]) => init.signal.aborted)).toBe(true);
  });

  it('reconstructs browser action parameters and stamps both provenance levels', async () => {
    const { send, broadcastUiEvent } = setup();
    await send('openchamber:browser-control-request', {
      ...request, origin: 'host', spaceId: 'claimed', settings: { password: 'private' },
      parameters: { ...request.parameters, origin: 'host', spaceId: 'claimed', action: 'system.shutdown', settings: { key: 'private' } },
      context: { ...context, origin: 'host', spaceId: 'claimed', hostd: 'operation' },
    }, 'control', { origin: 'space', spaceId: 'claimed', action: 'settings.write' });
    expect(broadcastUiEvent).toHaveBeenCalledExactlyOnceWith({
      type: 'openchamber:browser-control-request', origin: 'agent', spaceId: null,
      properties: { ...request, origin: 'agent', spaceId: null },
    });
  });

  it.each([
    { ...request, action: 'settings.write' },
    { ...request, parameters: { url: 'file:///private/data' } },
    { ...request, parameters: { url: 'https://example.com/', viewport: 'untyped' } },
    { ...request, context: { ...context, directory: '/spaces/123/repo' } },
    { ...request, context: { ...context, directory: '/work/../spaces/123/repo' } },
    { ...request, context: { ...context, sessionId: '/spaces/123/ses_1' } },
  ])('refuses invalid or space-claiming browser requests %#', async (properties) => {
    const { send, broadcastUiEvent, logger } = setup();
    await send('openchamber:browser-control-request', properties);
    expect(broadcastUiEvent).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith('[agent-streams] dropped openchamber:browser-control-request');
  });

  it('retains queue display fields while stripping nested provenance and unknown objects', async () => {
    const { send, broadcastUiEvent } = setup();
    await send('openchamber:message-queue.updated', {
      revision: 1, spaceId: 'claim', session: {
        ...context, origin: 'space', spaceId: 'claim', sendingId: null,
        items: [{ id: 'q1', content: 'go', text: 'go', createdAt: 1, attachments: [], sendConfig: { providerID: 'test', modelID: 'model', spaceId: 'claim' }, spaceId: 'claim', origin: { kind: 'pr-stack', id: 'r1', spaceId: 'claim' }, unknown: { spaceId: 'claim' } }],
      },
    });
    const event = broadcastUiEvent.mock.calls[0][0];
    expect(event.properties.session.items[0]).toEqual({
      id: 'q1', content: 'go', text: 'go', createdAt: 1, attachments: [], sendConfig: { providerID: 'test', modelID: 'model' }, origin: { kind: 'pr-stack', id: 'r1' },
    });
    expect(JSON.stringify(event)).not.toContain('claim');
  });

  it('accepts UI file, plan and page requests without executing their operations', async () => {
    const { send, broadcastUiEvent } = setup();
    await send('openchamber:file-open-request', { ...context, path: '/work/repo/result.html', run: 'open-as-host' });
    await send('openchamber:plan-open-request', { ...context, projectId: 'project', planId: 'plan', title: 'Read', settings: {} });
    await send('openchamber:page-waiting', { sessionID: 'ses_agent', directory: '/work/repo', page: { id: 'call1', title: 'Choose', spaceId: 'claim' } });
    expect(broadcastUiEvent.mock.calls.map(([event]) => event.type)).toEqual([
      'openchamber:file-open-request', 'openchamber:plan-open-request', 'openchamber:page-waiting',
    ]);
    expect(broadcastUiEvent.mock.calls.every(([event]) => event.origin === 'agent' && event.properties.origin === 'agent')).toBe(true);
    expect(JSON.stringify(broadcastUiEvent.mock.calls)).not.toMatch(/open-as-host|settings|claim/);
  });

  it('forwards a Bots change with its project only, so the Bots page refreshes behind the front door', async () => {
    const { send, broadcastUiEvent } = setup();

    await send('openchamber:bots-changed', { projectId: 'project-one', item: { id: 'item-one' }, spaceId: 'claim' });

    expect(broadcastUiEvent.mock.calls.map(([event]) => event)).toEqual([
      { type: 'openchamber:bots-changed', origin: 'agent', spaceId: null, properties: { projectId: 'project-one', origin: 'agent', spaceId: null } },
    ]);
  });

  it('takes duplicated notification and permission types from their owning stream only', async () => {
    const { send, broadcastUiEvent, broadcastGlobalUiEvent } = setup();
    const properties = { title: 'Done', sessionId: 'ses_agent', action: { type: 'system.shutdown' }, data: { url: '/api/config/settings' }, desktopNotificationDelivered: true };
    await send('openchamber:notification', properties);
    await send('openchamber:notification', properties, 'notifications');
    await send('openchamber:permission-auto-accept.updated', { revision: 1, modes: { ses_agent: 'ask', spaceId: 'auto' } }, 'notifications');
    expect(broadcastUiEvent).not.toHaveBeenCalled();
    expect(broadcastGlobalUiEvent.mock.calls[0][0]).toEqual({
      type: 'openchamber:notification', origin: 'agent', spaceId: null,
      properties: { title: 'Done', sessionId: 'ses_agent', desktopNotificationDelivered: false, desktopStdoutActive: false, origin: 'agent', spaceId: null },
    });
    expect(broadcastGlobalUiEvent.mock.calls[1][0].properties.modes).toEqual({ ses_agent: 'ask' });
  });

  it('reconstructs metadata and tracked-item states without carrying nested authority claims', async () => {
    const { send, broadcastUiEvent } = setup();
    await send('openchamber:session-metadata', { sessionID: 'ses_agent', metadata: {
      spaceId: 'claim', origin: 'host', settings: { password: 'private' },
      openchamber: { spaceId: 'claim', work: { state: 'open', openedAt: 1, spaceId: 'claim' }, unknown: { spaceId: 'claim' } },
    } });
    await send('openchamber:tracked-items.changed', { states: [{
      key: 'linear|ABC-1', item: { provider: 'linear', kind: 'work-item', identifier: 'ABC-1', spaceId: 'claim' },
      state: { identifier: 'ABC-1', title: 'Task', spaceId: 'claim', state: { name: 'Todo', category: 'todo', spaceId: 'claim' } },
      fetchedAt: 1, spaceId: 'claim',
    }] });
    expect(broadcastUiEvent.mock.calls[0][0].properties.metadata).toEqual({ openchamber: { work: { state: 'open', openedAt: 1 } } });
    expect(broadcastUiEvent).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(broadcastUiEvent.mock.calls)).not.toMatch(/claim|password|settings|unknown/);
  });

  it('drops unknown, settings-authority, render and secret actions and logs only bounded types', async () => {
    const { send, broadcastUiEvent, broadcastGlobalUiEvent, logger } = setup();
    for (const type of ['openchamber:themes-changed', 'openchamber:browser-provider-reset', 'openchamber:secret-request', 'openchamber:render-page', `unknown\n${'a'.repeat(500)}`]) {
      await send(type, { password: 'private-secret', spaceId: 'claimed' });
    }
    await send('openchamber:notification-stream-ready', { uiToken: 'private-secret' }, 'notifications');
    expect(broadcastUiEvent).not.toHaveBeenCalled();
    expect(broadcastGlobalUiEvent).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(5);
    expect(logger.warn.mock.calls.every(([line]) => line.length <= 153 && !line.includes('private-secret') && !line.includes('\n'))).toBe(true);
  });
});
