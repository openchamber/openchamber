import { describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { applyGlobalBlockingRequestEvents, resetGlobalBlockingRequests } from '@/sync/global-blocking-requests';
import { installHookTestDom } from '@/components/session/sidebar/test-utils/testDom';
import { usePendingRequests, type PendingRequests } from './usePendingRequests';

const FAMILY = ['parent', 'child'] as const;

describe('usePendingRequests', () => {
  test('covers the whole family, ignores other sessions, and clears on reply', async () => {
    const dom = installHookTestDom();
    const root = createRoot(dom.container);
    type PendingCapture = { renders: number; pending: PendingRequests | null };
    const capture: PendingCapture = { renders: 0, pending: null };
    const Harness = () => {
      capture.renders += 1;
      capture.pending = usePendingRequests(FAMILY);
      return null;
    };
    try {
      await act(async () => root.render(React.createElement(Harness)));
      expect(capture.pending).toEqual({ hasPermission: false, hasForm: false });

      // A request in an unrelated session neither shows nor re-renders the row.
      const idleRenders = capture.renders;
      await act(async () => applyGlobalBlockingRequestEvents('/other', [{
        type: 'permission.asked', properties: { id: 'p-other', sessionID: 'unrelated', action: 'bash', resources: [] },
      }]));
      expect(capture.renders).toBe(idleRenders);

      // A subagent's permission and the parent's question both land on the row.
      await act(async () => applyGlobalBlockingRequestEvents('/workspace', [
        { type: 'permission.asked', properties: { id: 'p1', sessionID: 'child', action: 'bash', resources: [] } },
        { type: 'form.created', properties: { form: { id: 'q1', sessionID: 'parent', title: 'Pick', fields: [{ key: 'answer', type: 'boolean' }] } } },
      ]));
      expect(capture.pending).toEqual({ hasPermission: true, hasForm: true });

      // A second request of the same kind changes nothing the row shows.
      const pendingRenders = capture.renders;
      await act(async () => applyGlobalBlockingRequestEvents('/workspace', [
        { type: 'permission.asked', properties: { id: 'p2', sessionID: 'parent', action: 'bash', resources: [] } },
      ]));
      expect(capture.renders).toBe(pendingRenders);

      await act(async () => applyGlobalBlockingRequestEvents('/workspace', [
        { type: 'permission.replied', properties: { sessionID: 'child', requestID: 'p1' } },
        { type: 'permission.replied', properties: { sessionID: 'parent', requestID: 'p2' } },
        { type: 'form.settled', properties: { sessionID: 'parent', formID: 'q1' } },
      ]));
      expect(capture.pending).toEqual({ hasPermission: false, hasForm: false });
    } finally {
      await act(async () => root.unmount());
      resetGlobalBlockingRequests();
      dom.restore();
    }
  });
});
