import { describe, expect, it, vi } from 'vitest';

import { createGlobalMessageStreamHub } from './global-hub.js';

function createSseResponse({ blocks = [] } = {}) {
  const encoder = new TextEncoder();
  let index = 0;

  return {
    ok: true,
    body: {
      getReader() {
        return {
          async read() {
            if (index < blocks.length) {
              return { value: encoder.encode(blocks[index++]), done: false };
            }
            return { value: undefined, done: true };
          },
        };
      },
    },
  };
}

async function waitForAssertion(assertion) {
  const deadline = Date.now() + 1000;
  let lastError;

  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  throw lastError;
}

describe('createGlobalMessageStreamHub', () => {
  it('uses the configured upstream event path', async () => {
    const paths = [];
    const hub = createGlobalMessageStreamHub({
      buildOpenCodeUrl: (pathname) => {
        paths.push(pathname);
        return `http://127.0.0.1:4096${pathname}`;
      },
      getOpenCodeAuthHeaders: () => ({}),
      getOpenCodeProtocol: () => 'opencode2',
      upstreamReconnectDelayMs: 100,
      fetchImpl: async () => createSseResponse(),
    });

    try {
      hub.start();
      await waitForAssertion(() => {
        expect(paths[0]).toBe('/api/event');
      });
    } finally {
      hub.stop();
    }
  });

  it('normalizes real opencode2 execution and form events at the shared hub boundary', async () => {
    const received = [];
    const hub = createGlobalMessageStreamHub({
      buildOpenCodeUrl: (pathname) => `http://127.0.0.1:4096${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getOpenCodeProtocol: () => 'opencode2',
      upstreamReconnectDelayMs: 100,
      fetchImpl: async () => createSseResponse({
        blocks: [
          'data: {"id":"evt-v2","type":"session.execution.failed","data":{"sessionID":"ses-1","error":{"type":"unknown","message":"Agent failed"}},"location":{"directory":"/tmp/project"}}\n\n',
          'data: {"id":"evt-v2-next","type":"form.created","data":{"form":{"id":"form-1","sessionID":"ses-1","title":"Choose a target","fields":[{"key":"target","type":"string","title":"Target","description":"Where should this go?","options":[{"value":"prod","label":"Production"}]}]}},"location":{"directory":"/tmp/project"}}\n\n',
        ],
      }),
    });
    hub.subscribeEvent((event) => received.push(event));

    try {
      hub.start();
      await waitForAssertion(() => {
        expect(received[0]).toEqual({
          envelope: {
            eventId: undefined,
            directory: '/tmp/project',
            payload: {
              id: 'evt-v2',
              type: 'session.error',
              properties: {
                sessionID: 'ses-1',
                error: { name: 'UnknownError', data: { message: 'Agent failed' } },
                directory: '/tmp/project',
              },
            },
          },
          payload: {
            id: 'evt-v2',
            type: 'session.error',
            properties: {
              sessionID: 'ses-1',
              error: { name: 'UnknownError', data: { message: 'Agent failed' } },
              directory: '/tmp/project',
            },
          },
          directory: '/tmp/project',
          eventId: undefined,
        });
        expect(received[1]).toMatchObject({
          payload: {
            type: 'question.asked',
            properties: {
              id: 'form-1',
              sessionID: 'ses-1',
              questions: [{
                question: 'Where should this go?',
                header: 'Target',
                options: [{ label: 'Production', description: '' }],
              }],
              directory: '/tmp/project',
            },
          },
          directory: '/tmp/project',
          eventId: undefined,
        });
        expect(hub.replayAfter('evt-v2')).toEqual([]);
      });
    } finally {
      hub.stop();
    }
  });

  it('uses the upstream SSE cursor for replay while preserving the JSON event id', async () => {
    const received = [];
    const hub = createGlobalMessageStreamHub({
      buildOpenCodeUrl: (pathname) => `http://127.0.0.1:4096${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getOpenCodeProtocol: () => 'opencode2',
      upstreamReconnectDelayMs: 100,
      fetchImpl: async () => createSseResponse({
        blocks: [
          'id: cursor-1\ndata: {"id":"json-1","type":"server.connected","data":{}}\n\n',
        ],
      }),
    });
    hub.subscribeEvent((event) => received.push(event));

    try {
      hub.start();
      await waitForAssertion(() => expect(received).toHaveLength(1));
      expect(received[0].eventId).toBe('cursor-1');
      expect(received[0].payload.id).toBe('json-1');
      expect(hub.replayAfter('cursor-1')).toEqual([]);
    } finally {
      hub.stop();
    }
  });

  it('keeps session lineage while translating V2 session updates', async () => {
    const received = [];
    const hub = createGlobalMessageStreamHub({
      buildOpenCodeUrl: (pathname) => `http://127.0.0.1:4096${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getOpenCodeProtocol: () => 'opencode2',
      upstreamReconnectDelayMs: 100,
      fetchImpl: async () => createSseResponse({
        blocks: [
          'data: {"id":"evt-created","type":"session.created","created":1,"data":{"sessionID":"ses-1","projectID":"project-1","location":{"directory":"/tmp/project"},"parentID":"parent-1","slug":"session-1","title":"Original","version":"2"},"location":{"directory":"/tmp/project"}}\n\n',
          'data: {"id":"evt-renamed","type":"session.renamed","created":2,"data":{"sessionID":"ses-1","title":"Renamed"},"location":{"directory":"/tmp/project"}}\n\n',
          'data: {"id":"evt-model","type":"session.model.selected","created":3,"data":{"sessionID":"ses-1","model":{"id":"model-1","providerID":"provider-1","variant":"high"}},"location":{"directory":"/tmp/project"}}\n\n',
          'data: {"id":"evt-moved","type":"session.moved","created":4,"data":{"sessionID":"ses-1","projectID":"project-2","location":{"directory":"/tmp/other","workspaceID":"workspace-1"},"subpath":"nested"},"location":{"directory":"/tmp/other"}}\n\n',
        ],
      }),
    });
    hub.subscribeEvent((event) => received.push(event));

    try {
      hub.start();
      await waitForAssertion(() => expect(received).toHaveLength(4));

      expect(received[1].payload).toMatchObject({
        type: 'session.updated',
        properties: {
          info: {
            id: 'ses-1',
            parentID: 'parent-1',
            title: 'Renamed',
          },
        },
      });
      expect(received[2].payload.properties.info.model).toEqual({
        id: 'model-1',
        providerID: 'provider-1',
        variant: 'high',
      });
      expect(received[3].payload).toMatchObject({
        type: 'session.updated',
        properties: {
          directory: '/tmp/other',
          info: {
            directory: '/tmp/other',
            parentID: 'parent-1',
            projectID: 'project-2',
            path: 'nested',
            workspaceID: 'workspace-1',
          },
        },
      });
    } finally {
      hub.stop();
    }
  });

  it('continues fanout when an event subscriber throws', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const received = [];
    const hub = createGlobalMessageStreamHub({
      buildOpenCodeUrl: (pathname) => `http://127.0.0.1:4096${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      upstreamReconnectDelayMs: 100,
      fetchImpl: async () => createSseResponse({
        blocks: [
          'id: evt-1\ndata: {"type":"session.updated","properties":{}}\n\n',
        ],
      }),
    });

    hub.subscribeEvent(() => {
      throw new Error('subscriber failed');
    });
    hub.subscribeEvent((event) => {
      received.push(event.eventId);
    });

    try {
      hub.start();
      await waitForAssertion(() => {
        expect(received).toEqual(['evt-1']);
      });
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      hub.stop();
      warnSpy.mockRestore();
    }
  });

  it('continues status fanout when a status subscriber throws', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const received = [];
    const hub = createGlobalMessageStreamHub({
      buildOpenCodeUrl: (pathname) => `http://127.0.0.1:4096${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      upstreamReconnectDelayMs: 100,
      fetchImpl: async () => createSseResponse(),
    });

    hub.subscribeStatus(() => {
      throw new Error('status subscriber failed');
    });
    hub.subscribeStatus((status) => {
      received.push(status.type);
    });

    try {
      hub.start();
      await waitForAssertion(() => {
        expect(received).toContain('connect');
      });
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      hub.stop();
      warnSpy.mockRestore();
    }
  });

  it('continues fanout when an async event subscriber rejects', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const received = [];
    const hub = createGlobalMessageStreamHub({
      buildOpenCodeUrl: (pathname) => `http://127.0.0.1:4096${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      upstreamReconnectDelayMs: 100,
      fetchImpl: async () => createSseResponse({
        blocks: [
          'id: evt-1\ndata: {"type":"session.updated","properties":{}}\n\n',
        ],
      }),
    });

    hub.subscribeEvent(async () => {
      throw new Error('async subscriber failed');
    });
    hub.subscribeEvent((event) => {
      received.push(event.eventId);
    });

    try {
      hub.start();
      await waitForAssertion(() => {
        expect(received).toEqual(['evt-1']);
      });
      await waitForAssertion(() => {
        expect(warnSpy).toHaveBeenCalled();
      });
    } finally {
      hub.stop();
      warnSpy.mockRestore();
    }
  });
});
