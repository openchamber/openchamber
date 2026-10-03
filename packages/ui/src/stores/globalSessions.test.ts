import { ensureChatsRootDirectory } from '@/lib/chatDirectories';
import { opencodeClient } from '@/lib/opencode/client';
import { describe, expect, test } from 'bun:test'
import type { SessionListOptions, SessionPage } from '@/lib/opencode/client'
import type { Session } from '@/lib/opencode/model'
import { OpenCode } from '@opencode/client'

import {
  filterManagedChatsForRuntime,
  listGlobalSessionPages,
  splitGlobalSessionsByArchived,
  type SessionPageLister,
} from './globalSessions'

const makeSession = (session: Partial<Session> & { id: string }): Session => ({
  projectID: 'project',
  directory: '/repo',
  title: session.id,
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 },
  ...session,
})

const pager = (pages: SessionPage[], calls?: SessionListOptions[]): SessionPageLister => {
  let index = 0
  return async (options) => {
    calls?.push(options)
    const page = pages[Math.min(index, pages.length - 1)]
    index += 1
    if (!page) throw new Error('no page')
    return page
  }
}

describe('managed Chats runtime visibility', () => {
  const chat = makeSession({ id: 'chat', directory: '/home/user/.config/openchamber/chats/2026-08-21/session-a' })
  const project = makeSession({ id: 'project', directory: '/workspace/project' })

  test('VS Code rejects managed Chats before they enter global state', () => {
    expect(filterManagedChatsForRuntime([chat, project], true)).toEqual([project])
  })

  test('other runtimes retain managed Chats', () => {
    expect(filterManagedChatsForRuntime([chat, project], false)).toEqual([chat, project])
  })
})

describe('listGlobalSessionPages', () => {
  test('uses the next cursor from the SDK HTTP response rather than guessing from session timestamps', async () => {
    const cursors: Array<string | null> = []
    const apiClient = OpenCode.make({
      baseUrl: 'https://sessions.test',
      fetch: async (request) => {
        const url = new URL(request instanceof Request ? request.url : request.toString())
        const cursor = url.searchParams.get('cursor')
        cursors.push(cursor)
        return cursor === null
          ? Response.json({ data: [
            makeSession({ id: 'first', time: { created: 1, updated: 20 } }),
            makeSession({ id: 'second', time: { created: 1, updated: 10 } }),
          ], cursor: { next: 'opaque-8' } })
          : Response.json({ data: [makeSession({ id: 'last', time: { created: 1, updated: 5 } })], cursor: {} })
      },
    })
    const sessions = await listGlobalSessionPages(async ({ cursor, limit }) => {
      const response = await apiClient.session.list({ cursor, limit })
      return { sessions: response.data.map((session) => makeSession(session)), cursor: { next: response.cursor.next ?? undefined } }
    }, { pageSize: 2 })
    expect(cursors).toEqual([null, 'opaque-8'])
    expect(sessions.map((session) => session.id)).toEqual(['first', 'second', 'last'])
  })

  test('sanitizes session list records before returning them', async () => {
    const listPage = pager([
      {
        sessions: [
          makeSession({
            id: 'ses_1',
            directory: '/repo/app',
            title: 'Alpha',
            metadata: { openchamber: { kind: 'review', originalSessionID: 'ses_original' } },
            permissions: [{ action: 'edit', resource: '**', effect: 'ask' }],
            revert: { messageID: 'msg_1', snapshot: 'abc123', files: [{ file: 'x', patch: '@@', additions: 1, deletions: 0, status: 'modified' }] },
          }),
        ],
        cursor: {},
      },
    ])

    const sessions = await listGlobalSessionPages(listPage, { pageSize: 500 })

    expect(sessions[0]?.metadata).toEqual({
      openchamber: { kind: 'review', originalSessionID: 'ses_original' },
    })
    expect(sessions[0]?.permissions).toBe(undefined)
    expect(sessions[0]?.revert).toEqual({ messageID: 'msg_1' })
  })

  test('walks the cursor until the server stops offering one', async () => {
    const calls: SessionListOptions[] = []
    const listPage = pager([
      { sessions: [makeSession({ id: 'ses_root' }), makeSession({ id: 'ses_child_1' })], cursor: { next: 'c1' } },
      { sessions: [makeSession({ id: 'ses_child_2' })], cursor: {} },
    ], calls)

    const sessions = await listGlobalSessionPages(listPage, { directory: '/repo', pageSize: 2 })

    expect(calls).toEqual([
      { directory: '/repo', limit: 2 },
      { directory: '/repo', limit: 2, cursor: 'c1' },
    ])
    expect(sessions.map((session) => session.id)).toEqual(['ses_root', 'ses_child_1', 'ses_child_2'])
  })

  test('asks for every directory when no directory is given', async () => {
    const calls: SessionListOptions[] = []
    await listGlobalSessionPages(pager([{ sessions: [makeSession({ id: 'ses_1' })], cursor: {} }], calls), { pageSize: 50 })

    expect(calls).toEqual([{ global: true, limit: 50 }])
  })

  test('reports each page to onPage as it arrives', async () => {
    const pages: string[][] = []
    const listPage = pager([
      { sessions: [makeSession({ id: 'ses_1' })], cursor: { next: 'c1' } },
      { sessions: [makeSession({ id: 'ses_2' })], cursor: {} },
    ])

    await listGlobalSessionPages(listPage, {
      pageSize: 1,
      onPage: (sessions) => pages.push(sessions.map((session) => session.id)),
    })

    expect(pages).toEqual([['ses_1'], ['ses_2']])
  })

  test('dedupes by id and stops when a page repeats known ids', async () => {
    const calls: SessionListOptions[] = []
    const repeated = { sessions: [makeSession({ id: 'ses_1' }), makeSession({ id: 'ses_2' })], cursor: { next: 'c1' } }
    const listPage = pager([repeated, { ...repeated, cursor: { next: 'c2' } }], calls)

    const sessions = await listGlobalSessionPages(listPage, { pageSize: 2 })

    expect(calls).toHaveLength(2)
    expect(sessions.map((session) => session.id)).toEqual(['ses_1', 'ses_2'])
  })

  test('retries a failed page before treating the load as failed', async () => {
    let calls = 0
    const listPage: SessionPageLister = async () => {
      calls += 1
      if (calls === 1) throw new Error('warming up')
      return { sessions: [makeSession({ id: 'ses_1' })], cursor: {} }
    }

    const sessions = await listGlobalSessionPages(listPage, { pageSize: 500 })

    expect(calls).toBe(2)
    expect(sessions.map((session) => session.id)).toEqual(['ses_1'])
  })
})

describe('splitGlobalSessionsByArchived', () => {
  test('classifies restored (falsy archived) records as active', () => {
    const { active, archived } = splitGlobalSessionsByArchived([
      makeSession({ id: 'ses_active', time: { created: 1, updated: 20 } }),
      makeSession({ id: 'ses_archived', time: { created: 1, updated: 10, archived: 15 } }),
      makeSession({ id: 'ses_restored', time: { created: 1, updated: 5, archived: 0 } }),
    ])

    expect(active.map((session) => session.id)).toEqual(['ses_active', 'ses_restored'])
    expect(archived.map((session) => session.id)).toEqual(['ses_archived'])
  })
})

const originalHomeInfo = opencodeClient.getFilesystemHomeInfo;
opencodeClient.getFilesystemHomeInfo = async () => ({ home: '/home/user' });
await ensureChatsRootDirectory();
opencodeClient.getFilesystemHomeInfo = originalHomeInfo;
