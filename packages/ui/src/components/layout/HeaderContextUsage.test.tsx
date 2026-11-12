import { beforeEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Session } from '@/lib/opencode/model';
import type { useCurrentContextReading } from './useCurrentContextReading';

let sessions: Session[] = [];
const reading: ReturnType<typeof useCurrentContextReading> = {
  sessionId: 'root', fill: { state: 'measured', totalTokens: 28_600 }, limit: 200_000,
};

mock.module('@/sync/sync-context', () => ({ useAllLiveSessions: () => sessions }));
mock.module('./useCurrentContextReading', () => ({ useCurrentContextReading: () => reading }));
mock.module('@/hooks/useEffectiveDirectory', () => ({ useEffectiveDirectory: () => null }));
mock.module('@/stores/useUIStore', () => ({
  normalizeContextPanelDirectoryKey: (directory: string) => directory,
  useUIStore: <T,>(selector: (state: { openContextSurface: () => void }) => T): T => selector({ openContextSurface: () => {} }),
}));
mock.module('@/lib/i18n', () => ({
  getCurrentIntlLocale: () => 'en-US',
  useI18n: () => ({ t: (key: string) => key }),
}));
mock.module('./ContextRailUsage', () => ({ ContextRing: () => null, ContextRailTooltipDetails: () => null }));
mock.module('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
}));

const { HeaderContextUsage } = await import('./HeaderContextUsage');

const session = (id: string, cost: number, parentID?: string): Session => ({
  id, cost, parentID, projectID: 'project', directory: '/repo', title: id,
  time: { created: 0, updated: 0 },
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
});

const text = () => renderToStaticMarkup(<HeaderContextUsage buttonClassName="header-button" />).replace(/<[^>]*>/g, '');

describe('HeaderContextUsage cost', () => {
  beforeEach(() => {
    sessions = [session('root', 4.1593)];
    reading.sessionId = 'root';
    reading.fill = { state: 'measured', totalTokens: 28_600 };
  });

  test('shows only the session cost when there are no subagents', () => {
    expect(text()).toBe('14.3% - $4.1593');
  });

  test('shows the total and the recursive session/subagent split using panel precision', () => {
    sessions.push(session('child', 0.5, 'root'), session('grandchild', 0.1827, 'child'));
    expect(text()).toBe('14.3% - $4.842 ($4.1593 + $0.6827)');
  });

  test('does not include unrelated sessions', () => {
    sessions.push(session('other', 50), session('other-child', 10, 'other'));
    expect(text()).toBe('14.3% - $4.1593');
  });

  test('keeps zero-cost subagents in the breakdown', () => {
    sessions.push(session('child', 0, 'root'));
    expect(text()).toBe('14.3% - $4.1593 ($4.1593 + $0)');
  });

  test('omits unavailable cost without hiding the context', () => {
    sessions = [];
    expect(text()).toBe('14.3%');
  });

  test('shows a known zero cost', () => {
    sessions = [session('root', 0)];
    expect(text()).toBe('14.3% - $0');
  });

  test('keeps the cost visible after compaction', () => {
    reading.fill = { state: 'compacted' };
    expect(text()).toBe('— - $4.1593');
  });

  test('shows nothing without a context reading', () => {
    reading.fill = null;
    expect(text()).toBe('');
  });

  test('shows nothing without a selected session', () => {
    reading.sessionId = null;
    expect(text()).toBe('');
  });
});
