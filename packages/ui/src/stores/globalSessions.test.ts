import { describe, expect, test } from 'bun:test'
import type { OpencodeClient } from '@opencode-ai/sdk/v2'

import { listGlobalSessionPages } from './globalSessions'

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
