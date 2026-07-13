import { describe, expect, test } from 'bun:test';
import { normalizeHostEvent } from '../event-normalizer';
import type { HostId } from '../../types';
import type { MonitorEventFrame } from '../types';

const hostId = 'host_test_1' as HostId;

function makeFrame(type: string, properties: Record<string, unknown> = {}): MonitorEventFrame {
  return {
    directory: '/test/dir',
    payload: {
      id: `evt_${Date.now()}`,
      type,
      properties,
    },
  };
}

describe('normalizeHostEvent', () => {
  test('normalizes session.created with complete info', () => {
    const frame = makeFrame('session.created', {
      sessionID: 'sess_1',
      info: {
        id: 'sess_1',
        title: 'Test Session',
        directory: '/test/dir',
        projectID: 'proj_1',
        time: { created: 1000, updated: 2000 },
      },
    });

    const events = normalizeHostEvent(hostId, frame);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: 'session-upsert',
      hostId,
      session: {
        id: 'sess_1',
        title: 'Test Session',
        directory: '/test/dir',
        projectId: 'proj_1',
        createdAt: 1000,
        updatedAt: 2000,
      },
    });
  });

  test('normalizes session.updated with complete info', () => {
    const frame = makeFrame('session.updated', {
      sessionID: 'sess_1',
      info: {
        id: 'sess_1',
        title: 'Updated',
        directory: '/dir',
        projectID: 'proj_1',
        time: { created: 1000, updated: 3000 },
      },
    });

    const events = normalizeHostEvent(hostId, frame);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('session-upsert');
  });

  test('returns host-refresh-required for session.created with missing info', () => {
    const frame = makeFrame('session.created', {
      sessionID: 'sess_1',
    });

    const events = normalizeHostEvent(hostId, frame);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: 'host-refresh-required', hostId });
  });

  test('returns host-refresh-required for session.created with no id in info', () => {
    const frame = makeFrame('session.created', {
      info: {
        title: 'No ID',
      },
    });

    const events = normalizeHostEvent(hostId, frame);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: 'host-refresh-required', hostId });
  });

  test('normalizes session.deleted', () => {
    const frame = makeFrame('session.deleted', {
      sessionID: 'sess_1',
      info: { id: 'sess_1' },
    });

    const events = normalizeHostEvent(hostId, frame);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: 'session-remove',
      hostId,
      sessionId: 'sess_1',
    });
  });

  test('normalizes session.status with busy', () => {
    const frame = makeFrame('session.status', {
      sessionID: 'sess_1',
      status: { type: 'busy' },
    });

    const events = normalizeHostEvent(hostId, frame);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: 'session-status',
      hostId,
      sessionId: 'sess_1',
      status: 'busy',
    });
  });

  test('normalizes session.status with retry', () => {
    const frame = makeFrame('session.status', {
      sessionID: 'sess_1',
      status: { type: 'retry', attempt: 1, message: 'fail', next: 5000 },
    });

    const events = normalizeHostEvent(hostId, frame);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: 'session-status',
      hostId,
      sessionId: 'sess_1',
      status: 'retry',
    });
  });

  test('normalizes session.status with idle', () => {
    const frame = makeFrame('session.status', {
      sessionID: 'sess_1',
      status: { type: 'idle' },
    });

    const events = normalizeHostEvent(hostId, frame);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: 'session-status',
      hostId,
      sessionId: 'sess_1',
      status: 'idle',
    });
  });

  test('normalizes session.idle', () => {
    const frame = makeFrame('session.idle', {
      sessionID: 'sess_1',
    });

    const events = normalizeHostEvent(hostId, frame);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: 'session-status',
      hostId,
      sessionId: 'sess_1',
      status: 'idle',
    });
  });

  test('normalizes session.error to idle', () => {
    const frame = makeFrame('session.error', {
      sessionID: 'sess_1',
    });

    const events = normalizeHostEvent(hostId, frame);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: 'session-status',
      hostId,
      sessionId: 'sess_1',
      status: 'idle',
    });
  });

  test('returns empty for high-frequency irrelevant events', () => {
    const irrelevantTypes = [
      'message.part.delta',
      'message.part.updated',
      'message.part.removed',
      'message.updated',
      'session.diff',
      'lsp.updated',
      'vcs.branch.updated',
      'session.next.step.started',
      'session.next.tool.called',
      'session.next.text.delta',
    ];

    for (const type of irrelevantTypes) {
      const frame = makeFrame(type, { sessionID: 'sess_1' });
      const events = normalizeHostEvent(hostId, frame);
      expect(events).toEqual([]);
    }
  });

  test('strips trailing .N suffix from event types', () => {
    const frame = makeFrame('session.status.1', {
      sessionID: 'sess_1',
      status: { type: 'busy' },
    });

    const events = normalizeHostEvent(hostId, frame);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('session-status');
  });

  test('normalizes permission.asked without creating session', () => {
    const frame = makeFrame('permission.asked', {
      sessionID: 'sess_1',
      id: 'perm_1',
    });

    const events = normalizeHostEvent(hostId, frame);
    expect(events).toEqual([]);
  });

  test('normalizes question.asked without creating session', () => {
    const frame = makeFrame('question.asked', {
      sessionID: 'sess_1',
    });

    const events = normalizeHostEvent(hostId, frame);
    expect(events).toEqual([]);
  });

  test('returns host-refresh-required for session.deleted with no sessionID', () => {
    const frame = makeFrame('session.deleted', {});

    const events = normalizeHostEvent(hostId, frame);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: 'host-refresh-required', hostId });
  });

  test('returns host-refresh-required for session.status with no sessionID', () => {
    const frame = makeFrame('session.status', {
      status: { type: 'busy' },
    });

    const events = normalizeHostEvent(hostId, frame);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: 'host-refresh-required', hostId });
  });

  test('handles session.created with missing optional fields gracefully', () => {
    const frame = makeFrame('session.created', {
      info: {
        id: 'sess_1',
      },
    });

    const events = normalizeHostEvent(hostId, frame);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: 'session-upsert',
      hostId,
      session: {
        id: 'sess_1',
        title: undefined,
        directory: undefined,
        projectId: undefined,
        createdAt: undefined,
        updatedAt: undefined,
      },
    });
  });
});
