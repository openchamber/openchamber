import { describe, expect, test } from 'bun:test'
import type { Message, Part } from '@opencode-ai/sdk/v2/client'

import { Binary } from './binary'
import {
  compareMessages,
  findMessageByID,
  isAfterMessage,
  isAtOrAfterMessage,
  isBeforeMessage,
  sortMessages,
  getMessageCreatedAt,
} from './messageOrder'
import { mergeMessages, mergeOptimisticPage, type OptimisticItem } from './optimistic'
import { materializeSessionSnapshots } from './materialization'

const wrapOldMessage = (): Message => ({
  // Created before the 2026-08-14 OpenCode ID wrap boundary: 48-bit hex
  // timestamp prefix near the top of the space (ffff…).
  id: 'msg_fffc192a8001AAAAAAAAAAAA',
  sessionID: 'ses_1',
  role: 'user',
  time: { created: 1_784_000_000_000 },
} as Message)

const wrapNewMessage = (): Message => ({
  // Created after the wrap boundary: the prefix wraps to near-zero (0000…),
  // so lexicographic id order would place this message BEFORE all older ones.
  id: 'msg_000851681002BBBBBBBBBBBB',
  sessionID: 'ses_1',
  role: 'assistant',
  time: { created: 1_784_000_100_000 },
} as Message)

const message = (id: string, created: number): Message => ({
  id,
  sessionID: 'ses_1',
  role: 'user',
  time: { created },
} as Message)

describe('getMessageCreatedAt', () => {
  test('returns time.created when present', () => {
    expect(getMessageCreatedAt(message('m_1', 42))).toBe(42)
  })

  test('returns 0 when time is missing or malformed', () => {
    expect(getMessageCreatedAt({ id: 'm_1' })).toBe(0)
    const malformed = { id: 'm_1', time: { created: 'nope' } } as unknown as Message
    expect(getMessageCreatedAt(malformed)).toBe(0)
  })
})

describe('compareMessages / sortMessages', () => {
  test('orders by time.created first, ignoring the id lexicographic order', () => {
    // This is the regression case: after the OpenCode ID wrap boundary the
    // newer message's id (0000…) sorts BEFORE the older id (ffff…) when
    // compared as strings, but it is still newer in time.
    const oldMsg = wrapOldMessage()
    const newMsg = wrapNewMessage()
    expect(compareMessages(newMsg, oldMsg)).toBeGreaterThan(0)
    expect(compareMessages(oldMsg, newMsg)).toBeLessThan(0)
    expect(sortMessages([newMsg, oldMsg]).map((m) => m.id)).toEqual([oldMsg.id, newMsg.id])
  })

  test('breaks ties by id', () => {
    const a = message('msg_b', 5)
    const b = message('msg_a', 5)
    expect(sortMessages([a, b]).map((m) => m.id)).toEqual(['msg_a', 'msg_b'])
  })

  test('messages without a created time sort first (treated as created=0)', () => {
    const noTime = { id: 'msg_z' } as Message
    const withTime = message('msg_a', 10)
    expect(compareMessages(noTime, withTime)).toBeLessThan(0)
  })
})

describe('Binary.searchBy', () => {
  test('finds existing messages by chronological position', () => {
    const messages = [wrapOldMessage(), wrapNewMessage()]
    const result = Binary.searchBy(messages, wrapNewMessage(), compareMessages)
    expect(result.found).toBe(true)
    expect(result.index).toBe(1)
  })

  test('returns the insertion index for a new message', () => {
    const messages = [wrapOldMessage(), wrapNewMessage()]
    const middle = message('msg_middle', 1_784_000_050_000)
    const result = Binary.searchBy(messages, middle, compareMessages)
    expect(result.found).toBe(false)
    expect(result.index).toBe(1)
  })
})

describe('mergeMessages', () => {
  test('keeps chronological order across the ID wrap boundary', () => {
    const oldMsg = wrapOldMessage()
    const newMsg = wrapNewMessage()
    const merged = mergeMessages([], [oldMsg, newMsg])
    expect(merged.map((m) => m.id)).toEqual([oldMsg.id, newMsg.id])
  })

  test('deduplicates by id and preserves order', () => {
    const oldMsg = wrapOldMessage()
    const merged = mergeMessages([oldMsg], [oldMsg, wrapNewMessage()])
    expect(merged.map((m) => m.id)).toEqual([oldMsg.id, wrapNewMessage().id])
  })
})

describe('mergeOptimisticPage', () => {
  test('inserts an optimistic message created after the wrap at the end, not the top', () => {
    const oldMsg = wrapOldMessage()
    const optimistic: OptimisticItem = {
      message: wrapNewMessage(),
      parts: [] as Part[],
    }
    const page = {
      session: [oldMsg],
      part: [{ id: oldMsg.id, part: [] as Part[] }],
      cursor: undefined,
      complete: true,
    }
    const merged = mergeOptimisticPage(page, [optimistic])
    expect(merged.session.map((m) => m.id)).toEqual([oldMsg.id, optimistic.message.id])
  })
})

describe('materializeSessionSnapshots', () => {
  test('orders materialized messages chronologically across the wrap boundary', () => {
    const oldMsg = wrapOldMessage()
    const newMsg = wrapNewMessage()
    const state = { message: {}, part: {} }
    const result = materializeSessionSnapshots(state, 'ses_1', [
      { info: newMsg, parts: [] },
      { info: oldMsg, parts: [] },
    ])
    expect(result.messages.map((m) => m.id)).toEqual([oldMsg.id, newMsg.id])
    expect(result.message['ses_1'].map((m) => m.id)).toEqual([oldMsg.id, newMsg.id])
  })
})

describe('revert helpers', () => {
  const anchor = wrapOldMessage()
  const after = message('msg_z_big_id', 1_784_000_100_000)
  const before = message('msg_a_small_id', 1_783_000_000_000)

  test('isBeforeMessage compares against the anchor chronologically', () => {
    expect(isBeforeMessage(before, anchor, anchor.id)).toBe(true)
    expect(isBeforeMessage(after, anchor, anchor.id)).toBe(false)
    expect(isBeforeMessage(anchor, anchor, anchor.id)).toBe(false)
  })

  test('isAtOrAfterMessage includes the anchor itself', () => {
    expect(isAtOrAfterMessage(after, anchor, anchor.id)).toBe(true)
    expect(isAtOrAfterMessage(anchor, anchor, anchor.id)).toBe(true)
    expect(isAtOrAfterMessage(before, anchor, anchor.id)).toBe(false)
  })

  test('isAfterMessage excludes the anchor itself', () => {
    expect(isAfterMessage(after, anchor, anchor.id)).toBe(true)
    expect(isAfterMessage(anchor, anchor, anchor.id)).toBe(false)
  })

  test('falls back to raw id comparison when the anchor is absent', () => {
    // Without the anchor the id tiebreaker of compareMessages cannot be
    // applied; behavior matches the historical id-based filter.
    expect(isBeforeMessage(before, undefined, anchor.id)).toBe(true)
    expect(isBeforeMessage(after, undefined, anchor.id)).toBe(false)
  })

  test('findMessageByID locates the anchor linearly', () => {
    expect(findMessageByID([after, before, anchor], anchor.id)).toBe(anchor)
    expect(findMessageByID([after, before], anchor.id)).toBeNull()
  })
})
