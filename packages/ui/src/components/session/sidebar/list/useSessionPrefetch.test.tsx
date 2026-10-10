import { describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Session } from '@/lib/opencode/model';
import { useSessionPrefetch, type SessionHoverPrefetch } from './useSessionPrefetch';
import { installHookTestDom } from '../test-utils/testDom';

const session = (id: string): Session => ({
  id,
  projectID: 'project',
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  title: id,
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

  const renderHoverHarness = async (calls: string[]) => {
    const dom = installHookTestDom();
    const root = createRoot(dom.container);
    const current = session('current');
    let hover: SessionHoverPrefetch | null = null;
    const Harness = () => {
      hover = useSessionPrefetch({
        enabled: true,
        currentSessionId: current.id,
        // No neighbours: only hover demand can prefetch here.
        sortedSessions: [current],
        prefetchSession: async ({ sessionID }) => { calls.push(sessionID); },
      });
      return null;
    };
    await act(async () => root.render(React.createElement(Harness)));
    const api = (): SessionHoverPrefetch => {
      if (!hover) throw new Error('hook did not render');
      return hover;
    };
    const cleanup = async () => {
      await act(async () => root.unmount());
      dom.restore();
    };
    return { api, cleanup };
  };

  test('loads a hovered session after the hover delay, once for repeated hovers', async () => {
    const calls: string[] = [];
    const { api, cleanup } = await renderHoverHarness(calls);
    try {
      const hovered = session('hovered');
      const first = api();
      await act(async () => {
        first.schedule(hovered);
        first.schedule(hovered);
      });
      // The context value the rows read stays the same object.
      expect(api()).toBe(first);
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 400)); });
      expect(calls).toEqual(['hovered']);
    } finally {
      await cleanup();
    }
  });

  test('a hover that ends before the delay loads nothing', async () => {
    const calls: string[] = [];
    const { api, cleanup } = await renderHoverHarness(calls);
    try {
      const passing = session('passing');
      await act(async () => {
        api().schedule(passing);
        api().cancel(passing);
      });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 400)); });
      expect(calls).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  test('a hover passing over a pending neighbor prefetch leaves it in place', async () => {
    const dom = installHookTestDom();
    const root = createRoot(dom.container);
    const current = session('current');
    const nearby = session('nearby');
    const calls: string[] = [];
    let hover: SessionHoverPrefetch | null = null;
    const Harness = () => {
      hover = useSessionPrefetch({
        enabled: true,
        currentSessionId: current.id,
        sortedSessions: [current, nearby],
        prefetchSession: async ({ sessionID }) => { calls.push(sessionID); },
      });
      return null;
    };
    try {
      await act(async () => root.render(React.createElement(Harness)));
      // The neighbor timer is pending once the open session has settled (150 ms).
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 170)); });
      await act(async () => {
        hover?.schedule(nearby);
        hover?.cancel(nearby);
      });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 600)); });
      expect(calls).toEqual(['nearby']);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });
});
