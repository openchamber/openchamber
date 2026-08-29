import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { createMessageQueueTarget, useMessageQueueStore } from '@/stores/messageQueueStore'
import { getRuntimeKey } from '@/lib/runtime-switch'

const fetchCalls: unknown[][] = []
let responses: Array<Response | Promise<Response>> = []

mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: mock(async (...args: unknown[]) => {
    fetchCalls.push(args)
    return responses.shift() ?? Response.json({ data: [], hasMore: false })
  }),
}))

import {
  applyDurableQueueEvent,
  replayDurableQueueHistory,
  resetDurableQueueCursors,
} from './durable-queue-events'
import { cleanupPersistedSessionState } from './session-deletion-cleanup'

const target = createMessageQueueTarget('ses-1', '/repo', 'runtime-a')!
const otherDirectoryTarget = createMessageQueueTarget('ses-1', '/other', 'runtime-a')!

const admitted = (messageID: string, sequence: number, text: string) => ({
  type: 'session.next.prompt.admitted.1',
  data: {
    messageID,
    sessionID: 'ses-1',
    admittedSeq: sequence,
    prompt: { text },
    timestamp: Date.now() + sequence,
    delivery: 'queue',
  },
  durable: { aggregateID: 'ses-1', seq: sequence, version: 1 },
})

beforeEach(() => {
  useMessageQueueStore.setState({ queuedMessages: {}, quarantinedLegacyMessages: {}, sendingIds: {}, durableTombstones: {} })
  fetchCalls.length = 0
  responses = []
  resetDurableQueueCursors()
})

describe('durable queue event reconciliation', () => {
  test('accepts the OpenCode v2 sync envelope and plain durable form', () => {
    applyDurableQueueEvent(target, {
      type: 'sync',
      syncEvent: {
        type: 'session.next.prompt.admitted.1',
        seq: 11,
        aggregateID: 'ses-1',
        data: { timestamp: Date.now(), sessionID: 'ses-1', messageID: 'msg_sync', prompt: { text: 'sync' }, delivery: 'queue' },
      },
    })
    applyDurableQueueEvent(target, {
      type: 'session.next.prompt.admitted.1',
      durable: { seq: 12, aggregateID: 'ses-1' },
      data: { timestamp: Date.now(), sessionID: 'ses-1', messageID: 'msg_plain', prompt: { text: 'plain' }, delivery: 'queue' },
    })
    expect(useMessageQueueStore.getState().getQueueForTarget(target).map((item) => item.clientMessageId)).toEqual(['msg_sync', 'msg_plain'])
  })

  test('ignores non-queue deliveries', () => {
    applyDurableQueueEvent(target, { ...admitted('msg_steer', 2, 'steer'), data: { ...admitted('msg_steer', 2, 'steer').data, delivery: 'steer' } })
    expect(useMessageQueueStore.getState().getQueueForTarget(target)).toHaveLength(0)
  })

  test('prompted before admitted and stale admitted replay cannot resurrect', () => {
    applyDurableQueueEvent(target, { type: 'session.next.prompted.1', data: { messageID: 'msg_late', sessionID: 'ses-1', delivery: 'queue' }, durable: { seq: 20 } })
    applyDurableQueueEvent(target, admitted('msg_late', 19, 'late'))
    expect(useMessageQueueStore.getState().getQueueForTarget(target)).toHaveLength(0)
  })

  test('late local completion cannot downgrade an authoritative admission', () => {
    applyDurableQueueEvent(target, admitted('msg_authoritative', 20, 'server'))
    const item = useMessageQueueStore.getState().getQueueForTarget(target)[0]!

    useMessageQueueStore.getState().markAdmissionLocal(target, item.id)
    useMessageQueueStore.getState().markAdmissionFailed(target, item.id)
    useMessageQueueStore.getState().markAdmissionUnknown(target, item.id)

    expect(useMessageQueueStore.getState().getQueueForTarget(target)[0]?.admissionState).toBe('admitted')
    expect(useMessageQueueStore.getState().getSendableQueue(target)).toHaveLength(0)
  })

  test('preserves local recovery data when an event races admission', () => {
    const attachment = { id: 'race-file', file: new File([], 'race.txt'), dataUrl: 'data:text/plain;base64,race', mimeType: 'text/plain', filename: 'race.txt', size: 4, source: 'local' as const }
    const queuedId = useMessageQueueStore.getState().addToQueue(target, {
      content: 'recover me', admissionState: 'pending-admission', clientMessageId: 'msg_race',
      attachments: [attachment], sendConfig: { providerID: 'provider', modelID: 'model' },
    })

    applyDurableQueueEvent(target, admitted('msg_race', 21, 'recover me'))
    const item = useMessageQueueStore.getState().getQueueForTarget(target).find((message) => message.id === queuedId)
    expect(item?.admissionState).toBe('admitted')
    expect(item?.attachments).toBe(undefined)
    expect(item?.sendConfig).toBe(undefined)
    expect(useMessageQueueStore.getState().getSendableQueue(target)).toHaveLength(0)
  })

  test('an older replayed admission cannot replace newer live data', () => {
    applyDurableQueueEvent(target, admitted('msg_ordered', 12, 'new'))
    applyDurableQueueEvent(target, admitted('msg_ordered', 11, 'old'))

    expect(useMessageQueueStore.getState().getQueueForTarget(target)[0]?.content).toBe('new')
  })

  test('does not let a live cursor skip an in-flight history page', async () => {
    responses = [Response.json({ data: [admitted('msg_page', 8, 'page')], hasMore: false })]
    const replay = replayDurableQueueHistory(target)
    applyDurableQueueEvent(target, admitted('msg_live', 9, 'live'))
    await replay
    // The live admission was already observed, so replay must not reorder it;
    // the important property is that the older page is not skipped.
    expect(useMessageQueueStore.getState().getQueueForTarget(target).map((item) => item.clientMessageId)).toEqual(['msg_live', 'msg_page'])
  })

  test('starts the first history replay at sequence zero even when live arrives first', async () => {
    let resolve!: (response: Response) => void
    responses = [new Promise<Response>((r) => { resolve = r })]
    const replay = replayDurableQueueHistory(target)
    applyDurableQueueEvent(target, admitted('msg_live_zero', 4, 'live'))
    resolve(Response.json({ data: [admitted('msg_zero', 0, 'zero')], hasMore: false }))
    await replay

    expect((fetchCalls[0]?.[1] as { query?: unknown }).query).toEqual({ directory: '/repo' })
    expect(useMessageQueueStore.getState().getQueueForTarget(target).map((item) => item.clientMessageId)).toEqual(['msg_live_zero', 'msg_zero'])
  })

  test('session deletion cancels an in-flight stale admission replay', async () => {
    let resolve!: (response: Response) => void
    responses = [new Promise<Response>((r) => { resolve = r })]
    const activeTarget = createMessageQueueTarget('ses-1', '/repo', getRuntimeKey())!
    const replay = replayDurableQueueHistory(activeTarget)

    cleanupPersistedSessionState({ runtimeKey: getRuntimeKey(), directory: '/repo', sessionId: 'ses-1' })
    resolve(Response.json({ data: [admitted('deleted-msg', 3, 'stale')], hasMore: false }))
    await replay

    expect(useMessageQueueStore.getState().getQueueForTarget(activeTarget)).toEqual([])
  })

  test('does not replay an already-cancelled target', async () => {
    const controller = new AbortController()
    controller.abort()

    await replayDurableQueueHistory(target, controller.signal)

    expect(fetchCalls).toHaveLength(0)
    expect(useMessageQueueStore.getState().getQueueForTarget(target)).toEqual([])
  })

  test('starts a fresh replay after an aborted caller switches away and back', async () => {
    let resolveFirst!: (response: Response) => void
    const controller = new AbortController()
    responses = [
      new Promise<Response>((resolve) => { resolveFirst = resolve }),
      Response.json({ data: [admitted('msg_fresh', 1, 'fresh')], hasMore: false }),
    ]

    const staleReplay = replayDurableQueueHistory(target, controller.signal)
    controller.abort()
    const freshReplay = replayDurableQueueHistory(target)
    resolveFirst(Response.json({ data: [admitted('msg_stale', 1, 'stale')], hasMore: false }))
    await Promise.all([staleReplay, freshReplay])

    expect(fetchCalls).toHaveLength(2)
    expect(useMessageQueueStore.getState().getQueueForTarget(target).map((item) => item.clientMessageId)).toEqual(['msg_fresh'])
  })
  test('upserts and deduplicates by the exact messageID', () => {
    applyDurableQueueEvent(target, admitted('msg_exact', 4, 'first'))
    applyDurableQueueEvent(target, admitted('msg_exact', 4, 'first'))

    const queue = useMessageQueueStore.getState().getQueueForTarget(target)
    expect(queue).toHaveLength(1)
    expect(queue[0]?.clientMessageId).toBe('msg_exact')
    expect(queue[0]?.content).toBe('first')
  })

  test('prompted removes only the matching admitted item', () => {
    applyDurableQueueEvent(target, admitted('msg_a', 1, 'A'))
    applyDurableQueueEvent(target, admitted('msg_b', 2, 'B'))
    applyDurableQueueEvent(target, {
      type: 'session.next.prompted.1',
      data: { messageID: 'msg_a', sessionID: 'ses-1', prompt: { text: 'A' }, delivery: 'queue' },
      durable: { aggregateID: 'ses-1', seq: 3, version: 1 },
    })

    expect(useMessageQueueStore.getState().getQueueForTarget(target).map((item) => item.clientMessageId)).toEqual(['msg_b'])
  })

  test('does not reconcile an unknown exact ID by prompt content', () => {
    applyDurableQueueEvent(target, admitted('msg_known', 1, 'same text'))
    applyDurableQueueEvent(target, {
      type: 'session.next.prompted.1',
      data: { messageID: 'msg_unknown', sessionID: 'ses-1', prompt: { text: 'same text' }, delivery: 'queue' },
      durable: { seq: 2 },
    })
    expect(useMessageQueueStore.getState().getQueueForTarget(target).map((item) => item.clientMessageId)).toEqual(['msg_known'])
  })

  test('keeps identical session IDs isolated by directory', () => {
    applyDurableQueueEvent(target, admitted('msg_repo', 1, 'repo'))
    applyDurableQueueEvent(otherDirectoryTarget, admitted('msg_other', 1, 'other'))
    expect(useMessageQueueStore.getState().getQueueForTarget(target).map((item) => item.clientMessageId)).toEqual(['msg_repo'])
    expect(useMessageQueueStore.getState().getQueueForTarget(otherDirectoryTarget).map((item) => item.clientMessageId)).toEqual(['msg_other'])
  })

  test('evicts another cursor and its initialized-history marker at capacity', async () => {
    const targets = Array.from({ length: 100 }, (_, index) => createMessageQueueTarget(`ses-${index}`, '/repo', 'runtime-a')!)
    responses = [Response.json({ data: [admitted('msg-initial', 1, 'initial')], hasMore: false })]
    await replayDurableQueueHistory(targets[0]!)
    for (const [index, cursorTarget] of targets.slice(1).entries()) {
      applyDurableQueueEvent(cursorTarget, admitted(`msg-${index}`, index + 2, `${index}`))
    }
    const nextTarget = createMessageQueueTarget('ses-next', '/repo', 'runtime-a')!
    applyDurableQueueEvent(nextTarget, admitted('msg-next', 102, 'next'))
    // The initialized target was evicted from the bounded cursor map. Its
    // initialized marker must leave with it, so the next replay starts at zero.
    applyDurableQueueEvent(targets[0]!, admitted('msg-oldest', 101, 'updated'))

    responses = [Response.json({ data: [], hasMore: false })]
    await replayDurableQueueHistory(targets[0]!)
    expect((fetchCalls[1]?.[1] as { query?: unknown }).query).toEqual({ directory: '/repo' })
  })

  test('preserves richer admission metadata when a durable update omits it', () => {
    applyDurableQueueEvent(target, {
      ...admitted('msg-metadata', 10, 'original'),
      data: { ...admitted('msg-metadata', 10, 'original').data, admittedSeq: 10 },
    })
    applyDurableQueueEvent(target, {
      type: 'session.next.prompt.admitted.1',
      data: { messageID: 'msg-metadata', sessionID: 'ses-1', delivery: 'queue' },
      durable: { seq: 11 },
    })

    const item = useMessageQueueStore.getState().getQueueForTarget(target)[0]
    expect(item?.content).toBe('original')
    expect(item?.admissionAck?.admittedSeq).toBe(10)
    expect(item?.admissionAck?.timeCreated).toBeDefined()
  })

  test('replaces a raced local item without changing its FIFO index', () => {
    const first = useMessageQueueStore.getState().addToQueue(target, { content: 'first' })
    const raced = useMessageQueueStore.getState().addToQueue(target, { content: 'raced', clientMessageId: 'msg_fifo' })
    const last = useMessageQueueStore.getState().addToQueue(target, { content: 'last' })
    applyDurableQueueEvent(target, admitted('msg_fifo', 5, 'raced'))
    expect(useMessageQueueStore.getState().getQueueForTarget(target).map((item) => item.id)).toEqual([first, raced, last])
  })

  test('prompted without a cursor still removes the exact ID', () => {
    applyDurableQueueEvent(target, admitted('msg_no_seq', 10, 'A'))
    applyDurableQueueEvent(target, {
      type: 'session.next.prompted.1',
      data: { messageID: 'msg_no_seq', sessionID: 'ses-1', delivery: 'queue' },
    })
    expect(useMessageQueueStore.getState().getQueueForTarget(target)).toHaveLength(0)
  })

  test('prompted without a cursor prevents a later admission from resurrecting the ID', () => {
    applyDurableQueueEvent(target, {
      type: 'session.next.prompted.1',
      data: { messageID: 'msg_no_seq_late', sessionID: 'ses-1', delivery: 'queue' },
    })
    applyDurableQueueEvent(target, admitted('msg_no_seq_late', 1, 'late'))
    expect(useMessageQueueStore.getState().getQueueForTarget(target)).toHaveLength(0)
  })

  test('replays history after the last observed cursor and follows pagination', async () => {
    applyDurableQueueEvent(target, admitted('msg_old', 7, 'old'))
    responses = [
      Response.json({ data: [admitted('msg_new', 8, 'new')], hasMore: true }),
      Response.json({ data: [admitted('msg_last', 9, 'last')], hasMore: false }),
    ]

    await replayDurableQueueHistory(target)

    expect((fetchCalls[0]?.[1] as { query?: unknown }).query).toEqual({ directory: '/repo' })
    expect((fetchCalls[1]?.[1] as { query?: unknown }).query).toEqual({ directory: '/repo', after: '8' })
    expect(useMessageQueueStore.getState().getQueueForTarget(target).map((item) => item.clientMessageId)).toEqual([
      'msg_old', 'msg_new', 'msg_last',
    ])
  })

  test('removes an admitted item when its prompted event passes the admitted sequence', () => {
    const id = useMessageQueueStore.getState().addToQueue(target, {
      content: 'ordered', admissionState: 'pending-admission', clientMessageId: 'msg-sequence-contract',
    })
    useMessageQueueStore.getState().markAdmissionAdmitted(target, id, { admittedSeq: 17, timeCreated: 1 })

    // The upstream contract emits a prompted sequence after the admission
    // sequence. This test exercises the boundary comparison, not that contract.
    applyDurableQueueEvent(target, {
      type: 'session.next.prompted.1',
      data: { messageID: 'msg-sequence-contract', sessionID: 'ses-1', delivery: 'queue' },
      durable: { seq: 18 },
    })

    expect(useMessageQueueStore.getState().getQueueForTarget(target)).toEqual([])
  })

  test('retries a non-ok first replay from sequence zero', async () => {
    responses = [new Response('unavailable', { status: 503 }), Response.json({ data: [], hasMore: false })]
    await replayDurableQueueHistory(target)
    await replayDurableQueueHistory(target)
    expect((fetchCalls[0]?.[1] as { query?: unknown }).query).toEqual({ directory: '/repo' })
    expect((fetchCalls[1]?.[1] as { query?: unknown }).query).toEqual({ directory: '/repo' })
  })

  test('retries a thrown first replay from sequence zero', async () => {
    responses = [Promise.reject(new Error('connection lost')), Response.json({ data: [], hasMore: false })]
    await replayDurableQueueHistory(target)
    await replayDurableQueueHistory(target)
    expect((fetchCalls[0]?.[1] as { query?: unknown }).query).toEqual({ directory: '/repo' })
    expect((fetchCalls[1]?.[1] as { query?: unknown }).query).toEqual({ directory: '/repo' })
  })

  test('retries an aborted first replay from sequence zero', async () => {
    const controller = new AbortController()
    responses = [Response.json({ data: [], hasMore: false }), Response.json({ data: [], hasMore: false })]
    const first = replayDurableQueueHistory(target, controller.signal)
    controller.abort()
    await first
    await replayDurableQueueHistory(target)
    expect((fetchCalls[0]?.[1] as { query?: unknown }).query).toEqual({ directory: '/repo' })
    expect((fetchCalls[1]?.[1] as { query?: unknown }).query).toEqual({ directory: '/repo' })
  })

  test('caches an explicitly unsupported history route per runtime, expires it, and resets on runtime change', async () => {
    const originalNow = Date.now
    let now = 1_000
    Date.now = () => now
    try {
      responses = [new Response('not implemented', { status: 501 }), Response.json({ data: [], hasMore: false })]
      await replayDurableQueueHistory(target)
      await replayDurableQueueHistory(target)
      expect(fetchCalls).toHaveLength(1)

      const otherRuntime = createMessageQueueTarget('ses-1', '/repo', 'runtime-b')!
      await replayDurableQueueHistory(otherRuntime)
      expect(fetchCalls).toHaveLength(2)

      now += 5 * 60 * 1000
      responses = [Response.json({ data: [], hasMore: false })]
      await replayDurableQueueHistory(target)
      expect(fetchCalls).toHaveLength(3)

      resetDurableQueueCursors()
      responses = [Response.json({ data: [], hasMore: false })]
      await replayDurableQueueHistory(target)
      expect(fetchCalls).toHaveLength(4)
    } finally {
      Date.now = originalNow
    }
  })

})
