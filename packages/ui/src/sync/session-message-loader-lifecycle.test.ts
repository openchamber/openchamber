import { expect, test } from 'bun:test'
import type { MessagePage } from '@/lib/opencode/client'

import { SessionMessageLoader } from './session-message-loader'
import { ChildStoreManager } from './child-store'

const emptyPage: MessagePage = { items: [], cursor: {} }

test('loads messages after a Strict Mode cleanup and effect setup', async () => {
  const childStores = new ChildStoreManager()
  let messageRequests = 0
  let resolveFirstRequest!: (value: MessagePage) => void
  let markStarted!: () => void
  const started = new Promise<void>((resolve) => { markStarted = resolve })
  const firstResponse = new Promise<MessagePage>((resolve) => { resolveFirstRequest = resolve })
  const sdk = { getSessionMessages: async () => {
    messageRequests += 1
    if (messageRequests === 1) { markStarted(); return firstResponse }
    return emptyPage
  } }
  const loader = new SessionMessageLoader(childStores, { sdk, runtimeKey: 'runtime' })
  const target = { directory: '/project', sessionID: 'session-1' }
  try {
    const firstLoad = loader.ensure(target)
    await started
    loader.dispose()
    loader.activate()
    await loader.ensure(target)
    resolveFirstRequest(emptyPage)
    await firstLoad
    expect(messageRequests).toBe(2)
    expect(loader.getSnapshot(target).status).toBe('ready')
  } finally {
    loader.dispose()
    childStores.disposeAll()
  }
})
