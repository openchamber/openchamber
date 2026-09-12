import { describe, expect, test } from 'bun:test';

import {
  RemoteSurfaceViewport,
  type RemoteSurfaceViewportCommand,
} from './remoteSurfaceViewport';

type ScheduledTask = {
  readonly callback: () => void;
  readonly delayMs: number;
  cancelled: boolean;
  readonly cancel: () => void;
};

const createHarness = () => {
  const commands: RemoteSurfaceViewportCommand[] = [];
  const tasks: ScheduledTask[] = [];
  let sequence = 0;
  const viewport = new RemoteSurfaceViewport({
    send: (command) => {
      commands.push(command);
      return true;
    },
    nextRequestId: () => `request-${++sequence}`,
    schedule: (callback, delayMs) => {
      const task: ScheduledTask = {
        callback,
        delayMs,
        cancelled: false,
        cancel: () => { task.cancelled = true; },
      };
      tasks.push(task);
      return task;
    },
  });
  const flushAuto = () => {
    const queued = tasks.filter((task) => task.delayMs <= 150);
    const deferred = tasks.filter((task) => task.delayMs > 150);
    tasks.splice(0, tasks.length, ...deferred);
    for (const task of queued) {
      if (!task.cancelled) task.callback();
    }
  };
  const flushRequest = () => {
    const requests = tasks.filter((task) => task.delayMs > 150);
    const remaining = tasks.filter((task) => task.delayMs <= 150);
    tasks.splice(0, tasks.length, ...remaining);
    for (const task of requests) {
      if (!task.cancelled) task.callback();
    }
  };
  const attachment = { tabId: 'sc:tab-1', attachmentRequestId: 'attachment-1' } as const;
  return { viewport, commands, flushAuto, flushRequest, attachment };
};

describe('RemoteSurfaceViewport', () => {
  test('Given a stale viewport result, when a newer attachment is current, then it preserves the newer attachment state', () => {
    const harness = createHarness();
    harness.viewport.setAttachment(harness.attachment);
    harness.viewport.updateStage(900, 600);
    harness.flushAuto();
    const command = harness.commands[0];
    expect(command).toBeDefined();

    harness.viewport.setAttachment({ tabId: 'sc:tab-2', attachmentRequestId: 'attachment-2' });
    harness.viewport.receive(JSON.stringify({
      type: 'viewportResult',
      requestId: command?.requestId,
      tabId: 'sc:tab-1',
      attachmentRequestId: 'attachment-1',
      status: 'applied',
      viewport: {
        width: 900,
        height: 600,
        mode: 'auto',
        source: 'viewer',
        mobile: false,
        deviceScaleFactor: 1,
        observed: {
          layoutWidth: 900,
          layoutHeight: 600,
          visualWidth: 900,
          visualHeight: 600,
          visualScale: 1,
        },
        revision: 1,
        autoAllowed: true,
      },
    }));

    const snapshot = harness.viewport.getSnapshot();
    expect(snapshot.attachment).toEqual({ tabId: 'sc:tab-2', attachmentRequestId: 'attachment-2' });
    expect(snapshot.viewport).toBeNull();
    expect(snapshot.pending).toBeNull();
  });

  test('Given a newer authoritative revision, when an older viewport state arrives, then it does not replace the confirmed viewport', () => {
    const harness = createHarness();
    harness.viewport.setAttachment(harness.attachment);
    harness.viewport.receive(JSON.stringify({
      type: 'viewportState',
      tabId: harness.attachment.tabId,
      attachmentRequestId: harness.attachment.attachmentRequestId,
      viewport: {
        revision: 3,
        width: 1440,
        height: 900,
        mode: 'fixed',
        source: 'agent',
        mobile: false,
        deviceScaleFactor: 1,
        observed: { layoutWidth: 1440, layoutHeight: 900, visualWidth: 1440, visualHeight: 900, visualScale: 1 },
        autoAllowed: false,
      },
    }));
    harness.viewport.receive(JSON.stringify({
      type: 'viewportState',
      tabId: harness.attachment.tabId,
      attachmentRequestId: harness.attachment.attachmentRequestId,
      viewport: {
        revision: 2,
        width: 800,
        height: 600,
        mode: 'auto',
        source: 'viewer',
        mobile: false,
        deviceScaleFactor: 1,
        observed: { layoutWidth: 800, layoutHeight: 600, visualWidth: 800, visualHeight: 600, visualScale: 1 },
        autoAllowed: true,
      },
    }));

    expect(harness.viewport.getSnapshot().viewport?.revision).toBe(3);
    expect(harness.viewport.getSnapshot().viewport?.width).toBe(1440);
  });

  test('Given rapid stage changes, when auto is allowed, then it sends only the newest bounded size after the debounce', () => {
    const harness = createHarness();
    harness.viewport.setAttachment(harness.attachment);
    harness.viewport.updateStage(400.4, 300.4);
    harness.viewport.updateStage(800.4, 600.4);
    harness.viewport.updateStage(1200.4, 900.4);
    harness.viewport.receive(JSON.stringify({
      type: 'viewportState',
      tabId: harness.attachment.tabId,
      attachmentRequestId: harness.attachment.attachmentRequestId,
      viewport: {
        revision: 0,
        width: 1200.4,
        height: 900.4,
        mode: 'external',
        source: 'external',
        mobile: null,
        deviceScaleFactor: null,
        observed: { layoutWidth: 1200.4, layoutHeight: 900.4, visualWidth: 1200.4, visualHeight: 900.4, visualScale: 1 },
        autoAllowed: true,
      },
    }));
    harness.flushAuto();

    expect(harness.commands).toEqual([{
      type: 'viewportSet',
      requestId: 'request-1',
      tabId: harness.attachment.tabId,
      attachmentRequestId: harness.attachment.attachmentRequestId,
      width: 1200,
      height: 900,
      mode: 'auto',
      mobile: false,
      takeover: false,
    }]);
  });

  for (const { label, next } of [
    { label: 'Auto', next: { width: 1200, height: 900, mode: 'auto' as const, mobile: false } },
    { label: 'a second fixed size', next: { width: 390, height: 844, mode: 'fixed' as const, mobile: true } },
  ]) {
    test(`Given rapid fixed then ${label} selections, when an older state arrives before the first result, then it sends the newest explicit choice`, () => {
      const harness = createHarness();
      harness.viewport.setAttachment(harness.attachment);
      expect(harness.viewport.selectViewport({ width: 800, height: 600, mode: 'fixed', mobile: false })).toBe(true);
      const first = harness.commands[0];
      expect(first).toBeDefined();

      expect(harness.viewport.selectViewport(next)).toBe(true);
      expect(harness.commands).toHaveLength(1);

      harness.viewport.receive(JSON.stringify({
        type: 'viewportState',
        tabId: harness.attachment.tabId,
        attachmentRequestId: harness.attachment.attachmentRequestId,
        viewport: {
          revision: 1,
          width: 800,
          height: 600,
          mode: 'external',
          source: 'external',
          mobile: null,
          deviceScaleFactor: null,
          observed: { layoutWidth: 800, layoutHeight: 600, visualWidth: 800, visualHeight: 600, visualScale: 1 },
          autoAllowed: true,
        },
      }));

      harness.viewport.receive(JSON.stringify({
        type: 'viewportResult',
        requestId: first?.requestId,
        tabId: harness.attachment.tabId,
        attachmentRequestId: harness.attachment.attachmentRequestId,
        status: 'applied',
        viewport: {
          revision: 1,
          width: 800,
          height: 600,
          mode: 'fixed',
          source: 'viewer',
          mobile: false,
          deviceScaleFactor: 1,
          observed: { layoutWidth: 800, layoutHeight: 600, visualWidth: 800, visualHeight: 600, visualScale: 1 },
          autoAllowed: true,
        },
      }));
      expect(harness.commands).toHaveLength(2);
      expect(harness.commands[1]).toEqual({
        type: 'viewportSet',
        requestId: 'request-2',
        tabId: harness.attachment.tabId,
        attachmentRequestId: harness.attachment.attachmentRequestId,
        ...next,
        takeover: true,
      });
    });
  }

  for (const completion of ['a server failure', 'a local timeout'] as const) {
    test(`Given a newer explicit selection, when its prior request has ${completion}, then it sends the queued choice`, () => {
      const harness = createHarness();
      harness.viewport.setAttachment(harness.attachment);
      expect(harness.viewport.selectViewport({ width: 800, height: 600, mode: 'fixed', mobile: false })).toBe(true);
      const first = harness.commands[0];
      expect(first).toBeDefined();

      expect(harness.viewport.selectViewport({ width: 1200, height: 900, mode: 'auto', mobile: false })).toBe(true);
      if (completion === 'a server failure') {
        harness.viewport.receive(JSON.stringify({
          type: 'viewportError',
          requestId: first?.requestId,
          tabId: harness.attachment.tabId,
          attachmentRequestId: harness.attachment.attachmentRequestId,
          code: 'RESIZE_FAILED',
          message: 'resize failed',
        }));
      } else {
        harness.flushRequest();
      }

      expect(harness.commands[1]).toEqual({
        type: 'viewportSet',
        requestId: 'request-2',
        tabId: harness.attachment.tabId,
        attachmentRequestId: harness.attachment.attachmentRequestId,
        width: 1200,
        height: 900,
        mode: 'auto',
        mobile: false,
        takeover: true,
      });
    });
  }

  test('Given an agent lease, when the stage changes, then automatic resize does not send or take control', () => {
    const harness = createHarness();
    harness.viewport.setAttachment(harness.attachment);
    harness.viewport.setAgentControlling(true);
    harness.viewport.updateStage(900, 600);
    harness.flushAuto();

    expect(harness.commands).toEqual([]);
  });

  test('Given a not-owner reply, when no new user action occurs, then it preserves the viewport without retrying', () => {
    const harness = createHarness();
    harness.viewport.setAttachment(harness.attachment);
    harness.viewport.updateStage(900, 600);
    harness.flushAuto();
    const request = harness.commands[0];
    expect(request).toBeDefined();

    harness.viewport.receive(JSON.stringify({
      type: 'viewportResult',
      requestId: request?.requestId,
      tabId: harness.attachment.tabId,
      attachmentRequestId: harness.attachment.attachmentRequestId,
      status: 'not-owner',
      viewport: {
        revision: 1,
        width: 1440,
        height: 900,
        mode: 'external',
        source: 'external',
        mobile: null,
        deviceScaleFactor: null,
        observed: { layoutWidth: 1440, layoutHeight: 900, visualWidth: 1440, visualHeight: 900, visualScale: 1 },
        autoAllowed: false,
      },
    }));
    harness.flushAuto();

    expect(harness.commands).toHaveLength(1);
    expect(harness.viewport.getSnapshot().viewport?.width).toBe(1440);
    expect(harness.viewport.getSnapshot().pending).toBeNull();
  });

  test('Given authoritative external sizing, when the stage changes, then only an explicit Auto choice may take over', () => {
    const harness = createHarness();
    harness.viewport.setAttachment(harness.attachment);
    harness.viewport.receive(JSON.stringify({
      type: 'viewportState',
      tabId: harness.attachment.tabId,
      attachmentRequestId: harness.attachment.attachmentRequestId,
      viewport: {
        revision: 2,
        width: 4001.5,
        height: 900.5,
        mode: 'external',
        source: 'external',
        mobile: null,
        deviceScaleFactor: null,
        observed: { layoutWidth: 4001.5, layoutHeight: 900.5, visualWidth: 4001.5, visualHeight: 900.5, visualScale: 1 },
        autoAllowed: false,
      },
    }));
    harness.viewport.updateStage(900, 600);
    harness.flushAuto();
    expect(harness.viewport.getSnapshot().viewport?.width).toBe(4001.5);
    expect(harness.commands).toEqual([]);

    expect(harness.viewport.selectViewport({ width: 900, height: 600, mode: 'auto', mobile: false })).toBe(true);
    expect(harness.commands).toHaveLength(1);
    expect(harness.commands[0]?.mode).toBe('auto');
    expect(harness.commands[0]?.takeover).toBe(true);
  });

  test('Given a hidden or zero-sized stage, when auto measures it, then it never sends an invalid viewport', () => {
    const harness = createHarness();
    harness.viewport.setAttachment(harness.attachment);
    harness.viewport.updateStage(0, 600);
    harness.viewport.updateStage(900, 0);
    harness.viewport.setVisible(false);
    harness.viewport.updateStage(900, 600);
    harness.flushAuto();

    expect(harness.commands).toEqual([]);
  });
});
