import { describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Session } from '@opencode-ai/sdk/v2';
import { useSessionPrefetch } from './useSessionPrefetch';
import { installHookTestDom } from '../test-utils/testDom';

const session = (id: string): Session => ({
  id,
  slug: id,
  projectID: 'project',
  title: id,
  version: '1',
  directory: '/workspace',
  time: { created: 1, updated: 1 },
});

describe('session prefetch demand', () => {
  test('deduplicates the same nearby session from project and Recent projections', async () => {
    const dom = installHookTestDom();
    const root = createRoot(dom.container);
    const current = session('current');
    const nearby = session('nearby');
    const calls: string[] = [];
    const Harness = () => {
      useSessionPrefetch({
        enabled: true,
        currentSessionId: current.id,
        sortedSessions: [current, nearby],
        recentSessions: [current, nearby],
        prefetchSession: async ({ sessionID }) => { calls.push(sessionID); },
      });
      return null;
    };
    try {
      await act(async () => root.render(React.createElement(Harness)));
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 850)); });
      expect(calls).toEqual(['nearby']);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });
});
