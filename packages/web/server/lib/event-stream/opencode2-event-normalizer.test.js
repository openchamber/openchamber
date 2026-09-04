import { describe, expect, it } from 'vitest';

import { createOpenCode2EventNormalizer } from './opencode2-event-normalizer.js';

describe('createOpenCode2EventNormalizer', () => {
  it('normalizes direct, wrapped, and legacy-shaped envelopes without reusing JSON ids as SSE cursors', () => {
    const normalizer = createOpenCode2EventNormalizer();

    const delta = normalizer.normalize({
      envelope: { eventId: 'cursor-1', directory: '/tmp/project' },
      payload: {
        id: 'json-1',
        type: 'session.next.text.delta',
        properties: {
          timestamp: 42,
          sessionID: 'ses-1',
          assistantMessageID: 'msg-1',
          textID: 'text-1',
          delta: 'hello',
        },
      },
    });

    expect(delta).toEqual({
      envelope: {
        eventId: 'cursor-1',
        directory: '/tmp/project',
        payload: {
          id: 'json-1',
          type: 'message.part.delta',
          properties: {
            sessionID: 'ses-1',
            messageID: 'msg-1',
            partID: 'text-1',
            field: 'text',
            delta: 'hello',
            directory: '/tmp/project',
          },
        },
      },
      payload: {
        id: 'json-1',
        type: 'message.part.delta',
        properties: {
          sessionID: 'ses-1',
          messageID: 'msg-1',
          partID: 'text-1',
          field: 'text',
          delta: 'hello',
          directory: '/tmp/project',
        },
      },
      directory: '/tmp/project',
      eventId: 'cursor-1',
    });

    const legacy = normalizer.normalize({
      envelope: { eventId: 'cursor-2', directory: '/tmp/project' },
      payload: {
        id: 'json-2',
        type: 'session.updated',
        properties: {
          sessionID: 'ses-1',
          info: { id: 'ses-1', title: 'Existing' },
        },
      },
    });

    expect(legacy.payload).toEqual({
      id: 'json-2',
      type: 'session.updated',
      properties: {
        sessionID: 'ses-1',
        info: { id: 'ses-1', title: 'Existing' },
        directory: '/tmp/project',
      },
    });
    expect(legacy.eventId).toBe('cursor-2');

    const wrapped = normalizer.normalize({
      envelope: { eventId: 'cursor-3', directory: '/tmp/project' },
      payload: {
        payload: {
          id: 'json-3',
          type: 'server.connected',
          properties: {},
        },
      },
    });

    expect(wrapped.payload).toEqual({
      id: 'json-3',
      type: 'server.connected',
      properties: { directory: '/tmp/project' },
    });
    expect(wrapped.eventId).toBe('cursor-3');
  });

  it('normalizes V2 aliases and drops durable sync markers', () => {
    const normalizer = createOpenCode2EventNormalizer();

    const permission = normalizer.normalize({
      envelope: { directory: '/tmp/project' },
      payload: {
        id: 'json-permission',
        type: 'permission.asked',
        properties: {
          id: 'perm-1',
          sessionID: 'ses-1',
          action: 'file.write',
          resources: ['src/index.ts'],
          source: { id: 'call-1', messageID: 'msg-1' },
        },
      },
    });

    expect(permission.payload).toMatchObject({
      id: 'json-permission',
      type: 'permission.asked',
      properties: {
        id: 'perm-1',
        sessionID: 'ses-1',
        permission: 'file.write',
        patterns: ['src/index.ts'],
        tool: { messageID: 'msg-1', callID: 'call-1' },
      },
    });

    expect(normalizer.normalize({
      envelope: { eventId: 'cursor-sync' },
      payload: {
        payload: {
          type: 'sync',
          syncEvent: { id: 'json-sync', type: 'session.next.text.delta.1', seq: 1 },
        },
      },
    })).toBeNull();
  });

  it('keeps an unsupported V2 data event shallow and preserves its JSON id', () => {
    const normalizer = createOpenCode2EventNormalizer();
    const result = normalizer.normalize({
      envelope: { eventId: 'cursor-unknown', directory: '/tmp/project' },
      payload: {
        id: 'json-unknown',
        type: 'session.instructions.updated',
        data: { sessionID: 'ses-1', instructions: ['one'] },
        location: { directory: '/tmp/project' },
      },
    });

    expect(result).toEqual({
      envelope: {
        eventId: 'cursor-unknown',
        directory: '/tmp/project',
        payload: {
          id: 'json-unknown',
          type: 'session.instructions.updated',
          data: { sessionID: 'ses-1', instructions: ['one'] },
          location: { directory: '/tmp/project' },
        },
      },
      payload: {
        id: 'json-unknown',
        type: 'session.instructions.updated',
        data: { sessionID: 'ses-1', instructions: ['one'] },
        location: { directory: '/tmp/project' },
      },
      directory: '/tmp/project',
      eventId: 'cursor-unknown',
    });
  });
});
