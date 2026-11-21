import { describe, expect, test } from 'bun:test'
import type { Message, Part } from '@/lib/opencode/model'

import { shouldFetchSessionForRenderableSync, hasUserMessage } from './use-sync'
import { confirmedOptimisticIDs } from './optimistic'
import { materializeSessionSnapshots } from './materialization'

describe('shouldFetchSessionForRenderableSync', () => {
  test('fetches full session detail when a lightweight list session is opened', () => {
    expect(shouldFetchSessionForRenderableSync({
      hasSession: true,
      shouldLoadMessages: true,
      force: false,
    })).toBe(true)
  })

  test('skips session detail fetch when session and messages are already ready', () => {
    expect(shouldFetchSessionForRenderableSync({
      hasSession: true,
      shouldLoadMessages: false,
      force: false,
    })).toBe(false)
  })

  test('fetches when the session record is missing', () => {
    expect(shouldFetchSessionForRenderableSync({
      hasSession: false,
      shouldLoadMessages: false,
      force: false,
    })).toBe(true)
  })
})

// --- loadMessages incremental commit (#2084) ---------------------------------
// loadMessages is a React hook callback and cannot be unit-tested in isolation.
// These tests cover the three invariants the refactor relies on:
//   1. hasUserMessage gates the first store commit (assistant-only tails defer
//      to the expansion loop so the skeleton stays instead of an empty chat).
//   2. Incremental materialization of superset pages preserves references for
//      already-committed messages (no re-render churn, no reference breaks).
//   3. An optimistic record is confirmed only when the page holds it with all its parts.

function assistantMessage(id: string, created = 1): Message {
  return { id, sessionID: 'ses_1', role: 'assistant', time: { created } } as Message
}
function userMessage(id: string, created = 1): Message {
  return { id, sessionID: 'ses_1', role: 'user', time: { created } } as Message
}
function textPart(id: string, messageID: string): Part {
  return { id, messageID, sessionID: 'ses_1', type: 'text', text: id } as Part
}

describe('hasUserMessage', () => {
  test('returns true when a user message is present', () => {
    expect(hasUserMessage([assistantMessage('m_1'), userMessage('m_2')])).toBe(true)
  })

  test('returns false when only assistant messages are present', () => {
    expect(hasUserMessage([assistantMessage('m_1'), assistantMessage('m_2')])).toBe(false)
  })

  test('returns false for undefined', () => {
    expect(hasUserMessage(undefined)).toBe(false)
  })

  test('returns false for an empty array', () => {
    expect(hasUserMessage([])).toBe(false)
  })
})

describe('incremental materialization of superset pages (#2084)', () => {
  const SKIP_PARTS = new Set(['patch', 'step-start', 'step-finish'])

  test('preserves authoritative part order across the part ID rollover', () => {
    const msg = assistantMessage('msg_1')
    const legacy = textPart('prt_ffffffffffffLegacy', msg.id)
    const current = textPart('prt_000000000000Current', msg.id)

    const result = materializeSessionSnapshots(
      { message: {}, part: {} },
      'ses_1',
      [{ info: msg, parts: [legacy, current] }],
      { skipPartTypes: SKIP_PARTS },
    )

    expect(result.part[msg.id]).toEqual([legacy, current])
  })

  test('preserves message references for already-committed messages', () => {
    // Simulate expansion: commit 50 (assistant-only), then 100 (with user), then 150.
    // Pages are supersets: the 100-page includes all 50 from the first page,
    // the 150-page includes all 100 from the second.
    // Messages are chronological in the store,
    // so look them up by id rather than positional index.
    const a1 = assistantMessage('a_1')
    const a2 = assistantMessage('a_2')
    const u1 = userMessage('u_1')
    const u0 = userMessage('u_0')
    const a3 = assistantMessage('a_3')
    const page50 = [a1, a2]
    const page100 = [u1, a1, a2]
    const page150 = [u0, u1, a1, a2, a3]

    const partsFor = (msgs: Message[]): { info: Message; parts: Part[] }[] =>
      msgs.map((info) => ({
        info,
        parts: info.role === 'assistant' ? [textPart(`p_${info.id}`, info.id)] : [],
      }))

    let state = { message: {} as Record<string, Message[]>, part: {} as Record<string, Part[]> }

    // Commit 1: assistant-only page (skeleton stays — no user message).
    // But materialization itself is valid; we test the reference property here.
    const m1 = materializeSessionSnapshots(state, 'ses_1', partsFor(page50), { skipPartTypes: SKIP_PARTS })
    state = { message: m1.message, part: m1.part }
    const afterFirst = state.message.ses_1
    expect(afterFirst.find((m) => m.id === 'a_1')).toBe(a1)
    expect(afterFirst.find((m) => m.id === 'a_2')).toBe(a2)

    // Commit 2: 100-message superset.
    const m2 = materializeSessionSnapshots(state, 'ses_1', partsFor(page100), { skipPartTypes: SKIP_PARTS })
    state = { message: m2.message, part: m2.part }
    const afterSecond = state.message.ses_1
    expect(afterSecond.find((m) => m.id === 'a_1')).toBe(a1)
    expect(afterSecond.find((m) => m.id === 'a_2')).toBe(a2)
    expect(afterSecond.find((m) => m.id === 'u_1')).toBe(u1)

    // Commit 3: 150-message superset.
    const m3 = materializeSessionSnapshots(state, 'ses_1', partsFor(page150), { skipPartTypes: SKIP_PARTS })
    const afterThird = m3.message.ses_1
    // All previously-committed messages keep their references.
    expect(afterThird.find((m) => m.id === 'a_1')).toBe(a1)
    expect(afterThird.find((m) => m.id === 'a_2')).toBe(a2)
    expect(afterThird.find((m) => m.id === 'u_1')).toBe(u1)
    // New messages from the 150-page are present.
    expect(afterThird.find((m) => m.id === 'u_0')).toBe(u0)
    expect(afterThird.find((m) => m.id === 'a_3')).toBe(a3)
  })

  test('preserves part references for unchanged assistant messages', () => {
    const msg = assistantMessage('a_1')
    const prt = textPart('p_a_1', 'a_1')
    const state = {
      message: { ses_1: [msg] } as Record<string, Message[]>,
      part: { a_1: [prt] } as Record<string, Part[]>,
    }

    // Re-materialize with the same message + part (superset adds a new message).
    const m = materializeSessionSnapshots(state, 'ses_1', [
      { info: msg, parts: [prt] },
      { info: userMessage('u_1'), parts: [] },
    ], { skipPartTypes: new Set(['patch', 'step-start', 'step-finish']) })

    // The existing part array reference is preserved (equivalent snapshot).
    expect(m.part.a_1).toBe(state.part.a_1)
    expect(m.partsChanged).toBe(false) // user message has no parts → no part change
  })

  test('does not create a no-op store update when re-committing the same page', () => {
    const msg = userMessage('u_1')
    const state = {
      message: { ses_1: [msg] } as Record<string, Message[]>,
      part: {} as Record<string, Part[]>,
    }

    const m = materializeSessionSnapshots(state, 'ses_1', [
      { info: msg, parts: [] },
    ], { skipPartTypes: new Set(['patch', 'step-start', 'step-finish']) })

    expect(m.messagesChanged).toBe(false)
    expect(m.partsChanged).toBe(false)
    expect(m.message).toBe(state.message)
    expect(m.part).toBe(state.part)
  })
})

describe('confirmedOptimisticIDs', () => {
  test('confirms an optimistic record once the page returns it with every optimistic part', () => {
    const optimistic = { message: userMessage('opt_1'), parts: [textPart('p_opt_1', 'opt_1')] }
    const page = (parts: Part[]) => ({ session: [userMessage('u_1'), userMessage('opt_1')], partsByMessageID: new Map([['opt_1', parts]]) })

    expect(confirmedOptimisticIDs(page([]), [optimistic])).toEqual([])
    expect(confirmedOptimisticIDs(page([textPart('p_opt_1', 'opt_1')]), [optimistic])).toEqual(['opt_1'])
  })

  test('leaves a record the page does not hold outstanding', () => {
    const page = { session: [userMessage('u_1')], partsByMessageID: new Map([['u_1', [] as Part[]]]) }
    expect(confirmedOptimisticIDs(page, [{ message: userMessage('opt_1'), parts: [] }])).toEqual([])
  })
})

describe('first-commit gating invariant (#2084)', () => {
  // The loadMessages refactor gates the first store commit on hasUserMessage.
  // When the first page is assistant-only, it defers to the expansion loop
  // and keeps the skeleton. This test verifies the gate condition itself:
  // hasUserMessage(page.session) must be false for an assistant-only page.
  test('assistant-only page does not trigger an early commit', () => {
    const assistantOnlyPage = [assistantMessage('a_1'), assistantMessage('a_2')]
    expect(hasUserMessage(assistantOnlyPage)).toBe(false)
  })

  test('page with a user message triggers an early commit', () => {
    const pageWithUser = [assistantMessage('a_1'), userMessage('u_1')]
    expect(hasUserMessage(pageWithUser)).toBe(true)
  })

})
