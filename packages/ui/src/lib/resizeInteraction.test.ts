import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  beginResizeInteraction,
  cancelResizeInteraction,
  getResizeInteractionPhase,
  isResizeInteractionActive,
  isResizeSettling,
  notifyResizeFrame,
  registerResizeFinalizer,
  registerResizeFrameParticipant,
  registerResizeTransactionStartParticipant,
  releaseResizeInteraction,
  resetResizeFrameParticipantsForTests,
  resetResizeInteractionForTests,
  resetResizeSchedulerForTests,
  setResizeInteractionActive,
  setResizeSchedulerForTests,
  subscribeResizeInteraction,
  type ResizeScheduler,
} from './resizeInteraction'

/** Deterministic scheduler: timeouts and rAF callbacks are queued and only run
 *  when the test explicitly flushes them. */
class FakeScheduler implements ResizeScheduler {
  timeouts: Array<{ id: number; fn: () => void }> = []
  frames: Array<{ id: number; fn: () => void }> = []
  nextId = 1

  setTimeout(fn: () => void): number {
    const id = this.nextId++
    this.timeouts.push({ id, fn })
    return id
  }

  clearTimeout(id: unknown): void {
    this.timeouts = this.timeouts.filter((t) => t.id !== id)
  }

  requestAnimationFrame(fn: () => void): number {
    const id = this.nextId++
    this.frames.push({ id, fn })
    return id
  }

  cancelAnimationFrame(id: unknown): void {
    this.frames = this.frames.filter((f) => f.id !== id)
  }

  runTimeouts(): void {
    const pending = [...this.timeouts]
    this.timeouts = []
    for (const t of pending) t.fn()
  }

  runFrames(): void {
    const pending = [...this.frames]
    this.frames = []
    for (const f of pending) f.fn()
  }

  get pendingTimeoutCount(): number {
    return this.timeouts.length
  }

  get pendingFrameCount(): number {
    return this.frames.length
  }
}

const flushMicrotasks = (): Promise<void> =>
  new Promise<void>((resolve) => queueMicrotask(resolve))

let scheduler: FakeScheduler

beforeEach(() => {
  scheduler = new FakeScheduler()
  setResizeSchedulerForTests(scheduler)
  resetResizeInteractionForTests()
})

afterEach(() => {
  resetResizeSchedulerForTests()
})

describe('resize interaction state machine', () => {
  test('transitions idle -> dragging -> finalizing -> idle for a plain release', async () => {
    expect(getResizeInteractionPhase()).toBe('idle')
    expect(isResizeSettling()).toBe(false)

    const id = beginResizeInteraction('left-sidebar')
    expect(getResizeInteractionPhase()).toBe('dragging')
    expect(isResizeInteractionActive()).toBe(true)
    expect(isResizeSettling()).toBe(true)

    releaseResizeInteraction('left-sidebar', id)
    expect(getResizeInteractionPhase()).toBe('finalizing')
    expect(isResizeInteractionActive()).toBe(false)
    // Settling stays true through the finalizing window.
    expect(isResizeSettling()).toBe(true)

    // No visible list -> finalizes on the next frame, not on a settle timer.
    // The only pending timer is the 1000ms fail-safe, cleared on completion.
    expect(scheduler.pendingTimeoutCount).toBe(1)
    scheduler.runFrames()
    expect(getResizeInteractionPhase()).toBe('idle')
    expect(isResizeSettling()).toBe(false)
    expect(scheduler.pendingTimeoutCount).toBe(0)
  })

  test('runs a registered finalizer exactly once per release and then completes', async () => {
    const id = beginResizeInteraction('context-panel')
    const finalizer = () => {
      finalizerCalls += 1
    }
    let finalizerCalls = 0
    registerResizeFinalizer(finalizer)

    releaseResizeInteraction('context-panel', id)
    await flushMicrotasks()
    await flushMicrotasks()
    expect(finalizerCalls).toBe(1)
    expect(getResizeInteractionPhase()).toBe('idle')
  })

  test('a stale release with a wrong transaction id is ignored', () => {
    const id = beginResizeInteraction('left-sidebar')
    releaseResizeInteraction('left-sidebar', id + 1)
    expect(getResizeInteractionPhase()).toBe('dragging')
    releaseResizeInteraction('left-sidebar', id)
    expect(getResizeInteractionPhase()).toBe('finalizing')
  })

  test('left and right sources share ONE transaction id; only the last release finalizes', async () => {
    const left = beginResizeInteraction('left-sidebar')
    const right = beginResizeInteraction('context-panel')
    // One global transaction per active period: the second source joins the
    // same id (no re-capture, no competing transaction).
    expect(right).toBe(left)

    // Releasing one source while the other is still dragging keeps dragging.
    releaseResizeInteraction('left-sidebar', left)
    expect(getResizeInteractionPhase()).toBe('dragging')

    releaseResizeInteraction('context-panel', right)
    expect(getResizeInteractionPhase()).toBe('finalizing')
    scheduler.runFrames()
    expect(getResizeInteractionPhase()).toBe('idle')
  })

  test('a joining source does not re-fire transaction-start participants', async () => {
    const starts: Array<{ transactionId: number; source: string; origin: string }> = []
    const unsubscribe = registerResizeTransactionStartParticipant((s) => { starts.push({ ...s }) })
    const first = beginResizeInteraction('left-sidebar')
    expect(starts.length).toBe(1)
    expect(starts[0].transactionId).toBe(first)
    expect(starts[0].origin).toBe('pointer')

    beginResizeInteraction('context-panel', 'programmatic')
    expect(starts.length).toBe(1) // Joining source: no re-fire.

    releaseResizeInteraction('left-sidebar', first)
    releaseResizeInteraction('context-panel', first)
    scheduler.runFrames()
    unsubscribe()
  })

  test('transaction-start participant fires synchronously before the first width frame', async () => {
    const order: string[] = []
    registerResizeTransactionStartParticipant(() => { order.push('start') })
    registerResizeFrameParticipant(() => { order.push('frame') })
    const id = beginResizeInteraction('left-sidebar', 'programmatic')
    notifyResizeFrame({ transactionId: id, width: 300, kind: 'drag', origin: 'programmatic', source: 'left-sidebar' })
    expect(order).toEqual(['start', 'frame'])
    releaseResizeInteraction('left-sidebar', id)
    scheduler.runFrames()
  })

  test('a new transaction during finalizing aborts the old finalizer', async () => {
    const first = beginResizeInteraction('left-sidebar')
    // Container objects: TS does not track values assigned inside closures for
    // reads outside them, so capture through properties instead of variables.
    const capturedSignal: { signal: AbortSignal | null } = { signal: null }
    const capturedResolve: { fn: (() => void) | null } = { fn: null }
    registerResizeFinalizer((signal) => {
      capturedSignal.signal = signal
      return new Promise<void>((resolve) => {
        capturedResolve.fn = resolve
      })
    })

    releaseResizeInteraction('left-sidebar', first)
    expect(getResizeInteractionPhase()).toBe('finalizing')
    await flushMicrotasks()
    expect(capturedSignal.signal?.aborted).toBe(false)

    // New drag supersedes the in-flight finalization.
    beginResizeInteraction('context-panel')
    expect(capturedSignal.signal?.aborted).toBe(true)
    expect(getResizeInteractionPhase()).toBe('dragging')

    // Letting the old finalizer resolve afterwards must not corrupt the new
    // transaction.
    capturedResolve.fn?.()
    await flushMicrotasks()
    expect(getResizeInteractionPhase()).toBe('dragging')
  })

  test('a never-resolving finalizer is recovered by the 1000ms fail-safe', async () => {
    const id = beginResizeInteraction('left-sidebar')
    const capturedSignal: { signal: AbortSignal | null } = { signal: null }
    registerResizeFinalizer((signal) => {
      capturedSignal.signal = signal
      return new Promise<void>(() => {
        // never resolves
      })
    })

    releaseResizeInteraction('left-sidebar', id)
    expect(getResizeInteractionPhase()).toBe('finalizing')
    await flushMicrotasks()
    expect(capturedSignal.signal?.aborted).toBe(false)
    scheduler.runTimeouts()
    expect(getResizeInteractionPhase()).toBe('idle')
    expect(capturedSignal.signal?.aborted).toBe(true)
  })

  test('cancel follows the same single-finalization path as release', async () => {
    const id = beginResizeInteraction('context-panel')
    let finalizerCalls = 0
    registerResizeFinalizer(() => {
      finalizerCalls += 1
    })
    cancelResizeInteraction('context-panel', id, 'cancelled')
    await flushMicrotasks()
    await flushMicrotasks()
    expect(finalizerCalls).toBe(1)
    expect(getResizeInteractionPhase()).toBe('idle')
  })

  test('listeners observe begin/release transitions with active boolean', async () => {
    const seen: boolean[] = []
    const unsubscribe = subscribeResizeInteraction((active) => {
      seen.push(active)
    })

    const id = beginResizeInteraction('left-sidebar')
    expect(seen).toEqual([true])
    releaseResizeInteraction('left-sidebar', id)
    // finalizing starts synchronously on release -> false notification.
    expect(seen).toEqual([true, false])
    // The no-finalizer next-frame end fires one more false for idle.
    scheduler.runFrames()
    expect(seen).toEqual([true, false, false])
    unsubscribe()
  })

  test('legacy setResizeInteractionActive maps to begin/release', () => {
    setResizeInteractionActive('left-sidebar', true)
    expect(getResizeInteractionPhase()).toBe('dragging')

    setResizeInteractionActive('left-sidebar', false)
    expect(getResizeInteractionPhase()).toBe('finalizing')

    // Idempotent: releasing an already-ended source is a no-op.
    setResizeInteractionActive('left-sidebar', false)
    expect(getResizeInteractionPhase()).toBe('finalizing')
  })

  test('frame participants are notified with transactionId/width/kind/origin/source/frameSequence and unsubscribe works', () => {
    const seen: Array<{ transactionId: number; width: number; kind: string; origin: string; source: string; frameSequence: number }> = []
    const unsubscribe = registerResizeFrameParticipant((frame) => { seen.push({ ...frame }) })
    notifyResizeFrame({ transactionId: 7, width: 320, kind: 'drag', origin: 'pointer', source: 'left-sidebar' })
    notifyResizeFrame({ transactionId: 7, width: 410, kind: 'drag', origin: 'programmatic', source: 'context-panel' })
    expect(seen.length).toBe(2)
    expect(seen[0].transactionId).toBe(7)
    expect(seen[0].width).toBe(320)
    expect(seen[0].origin).toBe('pointer')
    expect(seen[0].source).toBe('left-sidebar')
    expect(seen[0].frameSequence).toBeGreaterThan(0)
    expect(seen[1].origin).toBe('programmatic')
    expect(seen[1].frameSequence).toBeGreaterThan(seen[0].frameSequence)

    unsubscribe()
    notifyResizeFrame({ transactionId: 8, width: 500, kind: 'final', origin: 'pointer', source: 'left-sidebar' })
    expect(seen.length).toBe(2)
  })

  test('notifyResizeFrame with no participants is a no-op', () => {
    resetResizeFrameParticipantsForTests()
    let threw = false
    try {
      notifyResizeFrame({ transactionId: 1, width: 123, kind: 'drag', origin: 'pointer', source: 'left-sidebar' })
    } catch {
      threw = true
    }
    expect(threw).toBe(false)
  })

  test('multiple participants all receive every frame in registration order', () => {
    resetResizeFrameParticipantsForTests()
    const order: string[] = []
    const a = registerResizeFrameParticipant(() => { order.push('a') })
    const b = registerResizeFrameParticipant(() => { order.push('b') })
    notifyResizeFrame({ transactionId: 1, width: 300, kind: 'drag', origin: 'pointer', source: 'left-sidebar' })
    expect(order).toEqual(['a', 'b'])
    a()
    b()
    resetResizeFrameParticipantsForTests()
  })
})
