import { describe, expect, test } from 'bun:test'
import type { Session } from '@opencode-ai/sdk/v2'

import { stripSessionDiffSnapshots, stripSessionListDetails } from './sanitize'

describe('stripSessionDiffSnapshots', () => {
  test('removes oversized revert and summary diff payloads', () => {
    const session = {
      id: 'ses_1',
      slug: 'session-one',
      projectID: 'proj_1',
      directory: '/repo/app',
      title: 'Session',
      version: '1.0.0',
      time: { created: 1, updated: 2 },
      revert: {
        messageID: 'msg_2',
        partID: 'part_3',
        snapshot: 'gitsha',
        diff: 'diff --git a/file b/file',
      },
      summary: {
        additions: 2,
        deletions: 1,
        files: 1,
        diffs: [{ additions: 2, deletions: 1, before: 'a', after: 'b', patch: '@@ -1 +1 @@' }],
      },
    } as unknown as Session

    const next = stripSessionDiffSnapshots(session) as Session & {
      revert?: { messageID?: string; partID?: string; snapshot?: string; diff?: string }
      summary?: { diffs?: Array<{ before?: string; after?: string; patch?: string }> }
    }

    expect(next).not.toBe(session)
    expect(next.revert).toEqual({ messageID: 'msg_2', partID: 'part_3' })
    expect(next.summary?.diffs).toEqual([{ additions: 2, deletions: 1 }])
  })

  test('preserves object identity when nothing changes', () => {
    const session = {
      id: 'ses_1',
      slug: 'session-one',
      projectID: 'proj_1',
      directory: '/repo/app',
      title: 'Session',
      version: '1.0.0',
      time: { created: 1, updated: 2 },
      revert: { messageID: 'msg_2', partID: 'part_3' },
      summary: { additions: 2, deletions: 1, diffs: [{ additions: 2, deletions: 1 }] },
    } as unknown as Session

    expect(stripSessionDiffSnapshots(session)).toBe(session)
  })
})

describe('stripSessionListDetails', () => {
  test('removes detail-only fields from session list records', () => {
    const session = {
      id: 'ses_1',
      slug: 'session-one',
      projectID: 'proj_1',
      directory: '/repo/app',
      title: 'Session',
      time: { created: 1, updated: 2 },
      metadata: { huge: true },
      permission: [{ permission: 'todowrite' }],
      revert: {
        messageID: 'msg_2',
        partID: 'part_3',
        snapshot: 'gitsha',
        diff: 'diff --git a/file b/file',
      },
      summary: {
        additions: 2,
        deletions: 1,
        files: 1,
        diffs: [{ additions: 2, deletions: 1, patch: '@@ -1 +1 @@' }],
      },
    } as unknown as Session

    const next = stripSessionListDetails(session) as Session & {
      metadata?: unknown
      permission?: unknown
      revert?: { messageID?: string; partID?: string; snapshot?: string; diff?: string }
      summary?: { additions?: number; deletions?: number; files?: number; diffs?: unknown[] }
    }

    expect(next).not.toBe(session)
    expect(next.metadata).toBe(undefined)
    expect(next.permission).toBe(undefined)
    expect(next.revert).toEqual({ messageID: 'msg_2', partID: 'part_3' })
    expect(next.summary).toEqual({ additions: 2, deletions: 1, files: 1 })
  })

  test('preserves object identity for already lightweight records with revert markers', () => {
    const session = {
      id: 'ses_1',
      directory: '/repo/app',
      title: 'Session',
      time: { created: 1, updated: 2 },
      revert: { messageID: 'msg_2', partID: 'part_3' },
      summary: { additions: 2, deletions: 1, files: 1 },
    } as unknown as Session

    expect(stripSessionListDetails(session)).toBe(session)
  })
})
