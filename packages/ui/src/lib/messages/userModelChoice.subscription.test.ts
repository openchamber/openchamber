import { afterEach, describe, expect, test } from 'bun:test'
import type { Part, UserMessage } from '@opencode-ai/sdk/v2'
import { ChildStoreManager, markDirectorySessionPartChanged } from '@/sync/child-store'
import { createSessionUserModelChoiceSource } from '@/sync/session-user-model-choice'
import { shouldPreserveManualModelOverride } from './userModelChoice'

const prompt = (id: string, created: number, agent: string): UserMessage => ({
  id, sessionID: 'session', role: 'user', time: { created }, agent,
  model: { providerID: 'provider', modelID: `model-${agent}` },
})
const text = (messageID: string, synthetic = false): Part => ({
  id: `part-${messageID}`, sessionID: 'session', messageID, type: 'text', text: 'Prompt', synthetic,
})

const managers: ChildStoreManager[] = []
afterEach(() => { for (const manager of managers.splice(0)) manager.disposeAll() })

const setup = () => {
  const manager = new ChildStoreManager()
  managers.push(manager)
  const store = manager.ensureChild('/workspace', { bootstrap: false })
  const plan = prompt('msg_fff', 10, 'plan')
  const build = prompt('msg_000', 20, 'build')
  store.setState({ message: { session: [plan] }, part: { [plan.id]: [text(plan.id)] } })
  const source = createSessionUserModelChoiceSource(store, 'session')
  const setParts = (messageID: string, parts: Part[], sessionID = 'session') => {
    markDirectorySessionPartChanged(store, sessionID, messageID)
    store.setState({ part: { ...store.getState().part, [messageID]: parts } })
  }
  return { manager, store, source, plan, build, setParts }
}

describe('composer user-message subscription', () => {
  test('separate metadata and real text publications reconcile Build without any assistant response', () => {
    const { store, source, plan, build, setParts } = setup()
    const previousMessage = source.getSnapshot()
    let selected = previousMessage
    let notifications = 0
    const unsubscribe = source.subscribe(() => {
      notifications += 1
      const candidate = source.getSnapshot()
      if (!shouldPreserveManualModelOverride({
        selectionSource: 'manual',
        savedSessionModel: { providerId: 'provider', modelId: 'model-plan' },
        previousMessage, candidate,
      })) selected = candidate
    })
    store.setState({ message: { session: [plan, build] } })
    expect(source.getSnapshot()).toBe(previousMessage)
    expect(notifications).toBe(0)
    setParts(build.id, [text(build.id)])
    expect(notifications).toBe(1)
    expect(selected?.agent).toBe('build')
    expect(selected?.modelID).toBe('model-build')
    unsubscribe()
  })

  test('synthetic-only arrival stays ignored, but a later real part is observed', () => {
    const { store, source, plan, build, setParts } = setup()
    const initial = source.getSnapshot()
    let notifications = 0
    const unsubscribe = source.subscribe(() => { notifications += 1 })
    store.setState({ message: { session: [plan, build] } })
    setParts(build.id, [text(build.id, true)])
    expect(source.getSnapshot()).toBe(initial)
    expect(notifications).toBe(0)
    setParts(build.id, [text(build.id, true), { ...text(build.id), id: 'real-part' }])
    expect(source.getSnapshot()?.agent).toBe('build')
    expect(notifications).toBe(1)
    unsubscribe()
  })

  test('1,000 assistant or unrelated-session deltas do not notify or read user part buckets', () => {
    const { store, source, plan, setParts } = setup()
    let reads = 0
    const parts = [text(plan.id)]
    // A getter observes projection work without mocking the sync modules.
    store.setState({ part: { get [plan.id]() { reads += 1; return parts } } })
    const initial = source.getSnapshot()
    let notifications = 0
    const unsubscribe = source.subscribe(() => { notifications += 1 })
    for (let index = 0; index < 1_000; index += 1) {
      const messageID = index % 2 ? 'assistant' : 'other-user'
      const sessionID = index % 2 ? 'session' : 'other-session'
      const nextParts = { ...store.getState().part, [messageID]: [text(messageID)] }
      Object.defineProperty(nextParts, plan.id, { enumerable: true, get: () => { reads += 1; return parts } })
      reads = 0
      markDirectorySessionPartChanged(store, sessionID, messageID)
      store.setState({ part: nextParts })
      expect(reads).toBe(0)
    }
    expect(notifications).toBe(0)
    expect(source.getSnapshot()).toBe(initial)
    setParts(plan.id, [text(plan.id, true)])
    expect(source.getSnapshot()).toBeNull()
    expect(notifications).toBe(1)
    unsubscribe()
  })

  test('bulk hydration and removal update the snapshot, and cleanup stops notifications', () => {
    const { store, source, plan, build, setParts } = setup()
    let notifications = 0
    const unsubscribe = source.subscribe(() => { notifications += 1 })
    store.setState({ message: { session: [build] } })
    expect(source.getSnapshot()).toBeNull()
    store.setState({ part: { [build.id]: [text(build.id)] } })
    expect(source.getSnapshot()?.agent).toBe('build')
    const previousMessage = source.getSnapshot()
    store.setState({ message: { session: [plan] }, part: { [plan.id]: [text(plan.id)] } })
    expect(shouldPreserveManualModelOverride({
      selectionSource: 'manual', savedSessionModel: { providerId: 'provider', modelId: 'model-build' },
      previousMessage, candidate: source.getSnapshot(),
    })).toBe(true)
    unsubscribe()
    const stoppedAt = notifications
    setParts(plan.id, [])
    expect(notifications).toBe(stoppedAt)
  })

  test('same-message metadata changes remain subject to the manual override guard', () => {
    const { store, source, plan } = setup()
    const previousMessage = source.getSnapshot()
    let notifications = 0
    const unsubscribe = source.subscribe(() => { notifications += 1 })
    store.setState({ message: { session: [{ ...plan, agent: 'build', model: { providerID: 'provider', modelID: 'model-build' } }] } })
    expect(notifications).toBe(1)
    expect(shouldPreserveManualModelOverride({
      selectionSource: 'manual', savedSessionModel: { providerId: 'provider', modelId: 'model-plan' },
      previousMessage, candidate: source.getSnapshot(),
    })).toBe(true)
    unsubscribe()
  })

  test('equal session IDs in separate directories/runtimes have independent snapshots', () => {
    const { manager, store, source, build } = setup()
    const other = manager.ensureChild('/other', { bootstrap: false })
    const otherSource = createSessionUserModelChoiceSource(other, 'session')
    other.setState({ message: { session: [build] }, part: { [build.id]: [text(build.id)] } })
    expect(otherSource.getSnapshot()?.agent).toBe('build')
    expect(source.getSnapshot()?.agent).toBe('plan')
    const nextRuntime = setup()
    expect(nextRuntime.source.getSnapshot()?.agent).toBe('plan')
    expect(createSessionUserModelChoiceSource(store, '').getSnapshot()).toBeNull()
  })
})
