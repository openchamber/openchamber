import { expect, test } from 'bun:test';
import type { Session } from '@/lib/opencode/model';
import { rankConversationMetadata } from '@/lib/search/conversationSearch';
import { resolveSidebarSearchScope, sidebarSearchMetadata } from './sidebarConversationSearch';

test('a Windows chat known by its raw path is found by ID and by title', () => {
  const session: Session = {
    id: 'ses_0000000000aaWindowsChat01',
    projectID: 'chats',
    directory: String.raw`C:\Users\example\.config\openchamber\chats\2026-10-13\session-1a2b3c4d`,
    title: 'Quarterly Notes',
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 2 },
  };
  const scope = resolveSidebarSearchScope({
    projects: [], worktrees: new Map(), knownDirectories: new Set([session.directory]), isVSCode: false,
  });
  const metadata = sidebarSearchMetadata({
    sessions: [session], isAdmitted: scope.isAdmitted, owners: new Map(), projects: [], worktrees: new Map(),
  });

  expect(rankConversationMetadata(metadata, session.id).map((match) => match.sessionId)).toEqual([session.id]);
  expect(rankConversationMetadata(metadata, 'Quarterly').map((match) => match.sessionId)).toEqual([session.id]);
});
