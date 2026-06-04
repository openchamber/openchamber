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
                metadata: { huge: true },
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

    expect(session.metadata).toBe(undefined)
    expect(session.permission).toBe(undefined)
    expect(session.revert).toEqual({ messageID: 'msg_1' })
    expect(session.summary).toEqual({ additions: 5, deletions: 3, files: 2 })
  })
})
