import { describe, expect, it, vi } from 'vitest';

import { createNotificationEmitterRuntime } from './emitter-runtime.js';

const createRuntime = (overrides = {}) => createNotificationEmitterRuntime({
  process: { stdout: { write: vi.fn() } },
  getDesktopNotifyEnabled: () => true,
  desktopNotifyPrefix: '[desktop-notify]',
  getUiNotificationClients: () => new Set(),
  getBroadcastGlobalUiEvent: () => null,
  ...overrides,
});

describe('notification emitter runtime', () => {
  it('reports desktop delivery through the injected native callback', () => {
    const onDesktopNotification = vi.fn();
    const runtime = createRuntime({ onDesktopNotification });
    const payload = { title: 'Ready', body: 'Done' };

    expect(runtime.emitDesktopNotification(payload)).toBe(true);
    expect(onDesktopNotification).toHaveBeenCalledWith(payload);
  });

  it('reports stdout desktop delivery for legacy shells', () => {
    const write = vi.fn();
    const runtime = createRuntime({ process: { stdout: { write } } });

    expect(runtime.emitDesktopNotification({ title: 'Ready' })).toBe(true);
    expect(write).toHaveBeenCalledWith('[desktop-notify]{"title":"Ready"}\n');
  });

  it('marks UI broadcasts that were already delivered natively', () => {
    const broadcastGlobalUiEvent = vi.fn();
    const runtime = createRuntime({ getBroadcastGlobalUiEvent: () => broadcastGlobalUiEvent });

    runtime.broadcastUiNotification({ title: 'Ready' }, { desktopNotificationDelivered: true });

    expect(broadcastGlobalUiEvent).toHaveBeenCalledWith({
      type: 'openchamber:notification',
      properties: {
        title: 'Ready',
        desktopNotificationDelivered: true,
        desktopStdoutActive: true,
      },
    });
  });
});


describe('shared control notification delivery', () => {
  it('writes once to control SSE and once to the legacy/global broadcaster', () => {
    const control = { write: vi.fn() };
    const failed = { write: () => { throw new Error('closed'); } };
    const broadcastGlobalUiEvent = vi.fn();
    const runtime = createRuntime({
      getOpenChamberEventClients: () => new Set([failed, control]),
      getBroadcastGlobalUiEvent: () => broadcastGlobalUiEvent,
    });
    runtime.broadcastUiNotification({ title: 'Done', sessionId: 's1', kind: 'complete' });
    expect(control.write).toHaveBeenCalledTimes(1);
    expect(broadcastGlobalUiEvent).toHaveBeenCalledTimes(1);
    const envelope = broadcastGlobalUiEvent.mock.calls[0][0];
    expect(control.write).toHaveBeenCalledWith(`data: ${JSON.stringify(envelope)}\n\n`);
    expect(envelope.properties.sessionId).toBe('s1');
  });

  it('preserves legacy notification SSE without a global broadcaster', () => {
    const control = { write: vi.fn() };
    const legacy = { write: vi.fn() };
    const runtime = createRuntime({
      getOpenChamberEventClients: () => new Set([control]),
      getUiNotificationClients: () => new Set([legacy]),
    });
    runtime.broadcastUiNotification({ title: 'Done' });
    expect(control.write).toHaveBeenCalledTimes(1);
    expect(legacy.write).toHaveBeenCalledTimes(1);
    expect(control.write.mock.calls).toEqual(legacy.write.mock.calls);
  });
});
