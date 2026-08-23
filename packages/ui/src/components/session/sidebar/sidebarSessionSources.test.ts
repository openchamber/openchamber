import { describe, expect, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';

import { mergeSidebarSessionSources } from './sidebarSessionSources';

const session = (id: string, title: string): Session => ({
  id,
  slug: id,
  title,
  directory: `/home/.config/openchamber/chats/2026-08-21/${id}`,
  projectID: 'managed-chats',
  version: '1',
  time: { created: 1, updated: 1 },
});

describe('sidebar session source merge', () => {
  test('shows one row when the same cached global chat also exists live', () => {
    const live = session('session-a', 'Live title');
    const cached = session('session-a', 'Cached title');

    expect(mergeSidebarSessionSources([cached], [live])).toEqual([cached]);
  });

  test('prefers global authority over live fallback', () => {
    const global = session('session-a', 'Global title');
    expect(mergeSidebarSessionSources([global], [session('session-a', 'Live title')])).toEqual([global]);
  });
});
