import { describe, expect, test } from 'bun:test'
import type { OpencodeClient } from '@opencode-ai/sdk/v2'

import { listGlobalSessionPages, splitGlobalSessionsByArchived } from './globalSessions'

describe('listGlobalSessionPages', () => {
  test('sanitizes session list records before returning them', async () => {
    const apiClient = {
      experimental: {
        session: {
          list: async () => ({
            data: [
              {
                id: 'ses_1',
                directory: '/repo/app',
                title: 'Alpha',
                time: { created: 1, updated: 2 },
                metadata: {
                  openchamber: {
                    kind: 'review',
                    originalSessionID: 'ses_original',
                  },
                },
                permission: [{ permission: 'todowrite' }],
                revert: { messageID: 'msg_1', snapshot: 'abc123', diff: 'diff --git a/x b/x' },
                summary: {
                  additions: 5,
                  deletions: 3,
                  files: 2,
                  diffs: [{ patch: '@@ -1 +1 @@', additions: 5, deletions: 3 }],
                },
              },
            ],
            response: { headers: new Headers() },
          }),
        },
      },
    } as unknown as OpencodeClient

    const sessions = await listGlobalSessionPages(apiClient, { archived: false, pageSize: 500 })
    const session = sessions[0] as typeof sessions[number] & {
      metadata?: unknown
      permission?: unknown
      revert?: { messageID?: string; snapshot?: string; diff?: string }
      summary?: { additions?: number; deletions?: number; files?: number; diffs?: unknown[] }
    }

    expect(session.metadata).toEqual({
      openchamber: {
        kind: 'review',
        originalSessionID: 'ses_original',
      },
    })
    expect(session.permission).toBe(undefined)
    expect(session.revert).toEqual({ messageID: 'msg_1' })
    expect(session.summary).toEqual({ additions: 5, deletions: 3, files: 2 })
  })

  test('paginates through all session-list pages', async () => {
    const calls: Array<Record<string, unknown>> = []
    const apiClient = {
      experimental: {
        session: {
          list: async (options: Record<string, unknown>) => {
            calls.push(options)
            if (options.cursor === undefined) {
              return {
                data: [
                  { id: 'ses_root', time: { updated: 20 } },
                  { id: 'ses_child_1', time: { updated: 10 } },
                ],
                response: { headers: new Headers({ 'x-next-cursor': '10' }) },
              }
            }
            return {
              data: [
                { id: 'ses_child_2', time: { updated: 5 } },
              ],
              response: { headers: new Headers() },
            }
          },
        },
      },
    } as unknown as OpencodeClient

    const sessions = await listGlobalSessionPages(apiClient, {
      directory: '/repo',
      archived: false,
      roots: false,
      pageSize: 2,
    })

    expect(calls).toHaveLength(2)
    expect(calls[0]).toEqual({ directory: '/repo', archived: false, roots: false, limit: 2 })
    expect(calls[1]).toEqual({ directory: '/repo', archived: false, roots: false, limit: 2, cursor: 10 })
    expect(sessions.map((session) => session.id)).toEqual(['ses_root', 'ses_child_1', 'ses_child_2'])
  })

  test('returns only archived sessions when archived pages are requested', async () => {
    const apiClient = {
      experimental: {
        session: {
          list: async () => ({
            // The server treats `archived: true` as "include archived", so the
            // response mixes active and archived records.
            data: [
              { id: 'ses_active', time: { created: 1, updated: 20 } },
              { id: 'ses_archived', time: { created: 1, updated: 10, archived: 15 } },
            ],
            response: { headers: new Headers() },
          }),
        },
      },
    } as unknown as OpencodeClient

    const sessions = await listGlobalSessionPages(apiClient, { archived: true, pageSize: 500 })

    expect(sessions.map((session) => session.id)).toEqual(['ses_archived'])
  })

  test('keeps every record when active pages are requested', async () => {
    const apiClient = {
      experimental: {
        session: {
          list: async () => ({
            data: [
              { id: 'ses_active_1', time: { updated: 20 } },
              { id: 'ses_active_2', time: { updated: 10 } },
            ],
            response: { headers: new Headers() },
          }),
        },
      },
    } as unknown as OpencodeClient

    const sessions = await listGlobalSessionPages(apiClient, { archived: false, pageSize: 500 })

    expect(sessions.map((session) => session.id)).toEqual(['ses_active_1', 'ses_active_2'])
  })

  test('returns the inclusive response unfiltered when narrowing is disabled', async () => {
    const apiClient = {
      experimental: {
        session: {
          list: async () => ({
            data: [
              { id: 'ses_active', time: { created: 1, updated: 20 } },
              { id: 'ses_archived', time: { created: 1, updated: 10, archived: 15 } },
              { id: 'ses_restored', time: { created: 1, updated: 5, archived: 0 } },
            ],
            response: { headers: new Headers() },
          }),
        },
      },
    } as unknown as OpencodeClient

    const sessions = await listGlobalSessionPages(apiClient, { archived: true, narrowToArchived: false, pageSize: 500 })

    expect(sessions.map((session) => session.id)).toEqual(['ses_active', 'ses_archived', 'ses_restored'])
  })

  test('keeps paginating archived pages that are full of non-archived records', async () => {
    const calls: Array<Record<string, unknown>> = []
    const apiClient = {
      experimental: {
        session: {
          list: async (options: Record<string, unknown>) => {
            calls.push(options)
            if (options.cursor === undefined) {
              return {
                data: [
                  { id: 'ses_active_1', time: { updated: 30 } },
                  { id: 'ses_active_2', time: { updated: 20 } },
                ],
                response: { headers: new Headers({ 'x-next-cursor': '20' }) },
              }
            }
            return {
              data: [
                { id: 'ses_archived', time: { updated: 10, archived: 12 } },
              ],
              response: { headers: new Headers() },
            }
          },
        },
      },
    } as unknown as OpencodeClient

    const sessions = await listGlobalSessionPages(apiClient, { archived: true, pageSize: 2 })

    // A page that is full upstream but fully filtered out here must not be
    // mistaken for the last page: pagination progress is measured on the raw
    // response, not on the accepted records.
    expect(calls).toHaveLength(2)
    expect(sessions.map((session) => session.id)).toEqual(['ses_archived'])
  })

  test('reports only accepted records to onPage for archived pages', async () => {
    const pages: string[][] = []
    const apiClient = {
      experimental: {
        session: {
          list: async () => ({
            data: [
              { id: 'ses_active', time: { updated: 20 } },
              { id: 'ses_archived', time: { updated: 10, archived: 12 } },
            ],
            response: { headers: new Headers() },
          }),
        },
      },
    } as unknown as OpencodeClient

    await listGlobalSessionPages(apiClient, {
      archived: true,
      pageSize: 500,
      onPage: (sessions) => pages.push(sessions.map((session) => session.id)),
    })

    expect(pages).toEqual([['ses_archived']])
  })

  test('does not notify onPage for an archived page with no archived records', async () => {
    const pages: string[][] = []
    const apiClient = {
      experimental: {
        session: {
          list: async () => ({
            data: [{ id: 'ses_active', time: { updated: 20 } }],
            response: { headers: new Headers() },
          }),
        },
      },
    } as unknown as OpencodeClient

    const sessions = await listGlobalSessionPages(apiClient, {
      archived: true,
      pageSize: 500,
      onPage: (page) => pages.push(page.map((session) => session.id)),
    })

    expect(sessions).toEqual([])
    expect(pages).toEqual([])
  })

  test('dedupes archived records by id and stops when a page repeats known ids', async () => {
    const calls: Array<Record<string, unknown>> = []
    const page = [
      { id: 'ses_archived_1', time: { updated: 30, archived: 31 } },
      { id: 'ses_archived_2', time: { updated: 20, archived: 21 } },
    ]
    const apiClient = {
      experimental: {
        session: {
          list: async (options: Record<string, unknown>) => {
            calls.push(options)
            return {
              data: page,
              response: {
                headers: new Headers({
                  'x-next-cursor': options.cursor === undefined ? '20' : '10',
                }),
              },
            }
          },
        },
      },
    } as unknown as OpencodeClient

    const sessions = await listGlobalSessionPages(apiClient, { archived: true, pageSize: 2 })

    // The second page repeats ids already seen, so the dedupe guard stops the
    // loop and no record is returned twice.
    expect(calls).toHaveLength(2)
    expect(sessions.map((session) => session.id)).toEqual(['ses_archived_1', 'ses_archived_2'])
  })

  test('retries SDK error responses before treating the load as failed', async () => {
    let calls = 0
    const apiClient = {
      experimental: {
        session: {
          list: async () => {
            calls += 1
            if (calls === 1) {
              return { error: { message: 'warming up' }, response: { status: 503 } }
            }
            return {
              data: [{ id: 'ses_1', time: { updated: 1 } }],
              response: { headers: new Headers() },
            }
          },
        },
      },
    } as unknown as OpencodeClient

    const sessions = await listGlobalSessionPages(apiClient, { archived: false, pageSize: 500 })

    expect(calls).toBe(2)
    expect(sessions.map((session) => session.id)).toEqual(['ses_1'])
  })
})

describe('splitGlobalSessionsByArchived', () => {
  test('classifies restored (falsy archived) records as active', () => {
    const { active, archived } = splitGlobalSessionsByArchived([
      { id: 'ses_active', time: { created: 1, updated: 20 } },
      { id: 'ses_archived', time: { created: 1, updated: 10, archived: 15 } },
      { id: 'ses_restored', time: { created: 1, updated: 5, archived: 0 } },
    ] as unknown as Parameters<typeof splitGlobalSessionsByArchived>[0])

    expect(active.map((session) => session.id)).toEqual(['ses_active', 'ses_restored'])
    expect(archived.map((session) => session.id)).toEqual(['ses_archived'])
  })
})
