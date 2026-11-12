import { describe, expect, test } from 'bun:test'
import type { FileDiffInfo } from '@opencode/client'
import type { Session } from '@/lib/opencode/model'

import { stripSessionDiffSnapshots, stripSessionListDetails } from './sanitize'

const fileDiff = (file: string): FileDiffInfo => ({
  file,
  patch: `@@ -1 +1 @@\n-old\n+new`,
  additions: 1,
  deletions: 1,
  status: 'modified',
})

const session = (overrides: Partial<Session> = {}): Session => ({
  id: 'ses_1',
  projectID: 'proj_1',
  directory: '/repo/app',
  title: 'Session',
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 2 },
  ...overrides,
})

describe('stripSessionDiffSnapshots', () => {
  test('keeps the revert marker and drops its snapshot and file diffs', () => {
    const original = session({
      revert: {
        messageID: 'msg_2',
        partID: 'part_3',
        snapshot: 'gitsha',
        files: [fileDiff('src/app.ts'), fileDiff('src/other.ts')],
      },
    })

    const next = stripSessionDiffSnapshots(original)

    expect(next).not.toBe(original)
    expect(next.revert).toEqual({ messageID: 'msg_2', partID: 'part_3' })
  })

  test('preserves object identity when the revert is already a bare marker', () => {
    const original = session({ revert: { messageID: 'msg_2', partID: 'part_3' } })

    expect(stripSessionDiffSnapshots(original)).toBe(original)
  })

  test('preserves object identity when there is no revert at all', () => {
    const original = session()

    expect(stripSessionDiffSnapshots(original)).toBe(original)
  })
})

describe('stripSessionListDetails', () => {
  test('removes session permission rules and revert detail from list records', () => {
    const original = session({
      metadata: { openchamber: { kind: 'review', originalSessionID: 'ses_original' } },
      permissions: [{ action: 'edit', resource: '**', effect: 'ask' }],
      revert: { messageID: 'msg_2', partID: 'part_3', snapshot: 'gitsha', files: [fileDiff('src/app.ts')] },
    })

    const next = stripSessionListDetails(original)

    expect(next).not.toBe(original)
    expect(next.permissions).toBe(undefined)
    expect(next.revert).toEqual({ messageID: 'msg_2', partID: 'part_3' })
    // Metadata is what the sidebar renders review/btw badges from, so it stays.
    expect(next.metadata).toEqual({ openchamber: { kind: 'review', originalSessionID: 'ses_original' } })
  })

  test('preserves metadata extension fields in session list records', () => {
    const original = session({ metadata: { custom: { value: 'kept' } }, permissions: [{ action: 'edit', resource: '**', effect: 'ask' }] })

    const next = stripSessionListDetails(original)

    expect(next).not.toBe(original)
    expect(next.metadata).toEqual({ custom: { value: 'kept' } })
  })

  test('preserves object identity for already lightweight records with revert markers', () => {
    const original = session({ revert: { messageID: 'msg_2', partID: 'part_3' } })

    expect(stripSessionListDetails(original)).toBe(original)
  })
})
