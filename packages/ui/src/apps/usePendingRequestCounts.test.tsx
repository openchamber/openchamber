import { describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { applyGlobalBlockingRequestEvents, resetGlobalBlockingRequests } from '@/sync/global-blocking-requests';
import { installHookTestDom } from '@/components/session/sidebar/test-utils/testDom';
import { usePendingRequestCounts, type PendingRequestCounts } from './usePendingRequestCounts';

const FAMILY = ['parent', 'child'] as const;

describe('usePendingRequestCounts', () => {
  test('counts the whole family, ignores other sessions, and clears on reply', async () => {
    const dom = installHookTestDom();
    const root = createRoot(dom.container);
    type CountsCapture = { renders: number; counts: PendingRequestCounts | null };
    const capture: CountsCapture = { renders: 0, counts: null };
    const Harness = () => {
      capture.renders += 1;
      capture.counts = usePendingRequestCounts(FAMILY);
      return null;
    };
    try {
      await act(async () => root.render(React.createElement(Harness)));
      expect(capture.counts).toEqual({ permissionCount: 0, formCount: 0 });

      // A request in an unrelated session neither counts nor re-renders the row.
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
      expect(capture.counts).toEqual({ permissionCount: 1, formCount: 1 });

      await act(async () => applyGlobalBlockingRequestEvents('/workspace', [
        { type: 'permission.replied', properties: { sessionID: 'child', requestID: 'p1' } },
        { type: 'form.settled', properties: { sessionID: 'parent', formID: 'q1' } },
      ]));
      expect(capture.counts).toEqual({ permissionCount: 0, formCount: 0 });
    } finally {
      await act(async () => root.unmount());
      resetGlobalBlockingRequests();
      dom.restore();
    }
  });
});
