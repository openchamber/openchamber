import { expect, test } from 'bun:test'
import { createOpencodeClient } from '@opencode-ai/sdk/v2/client'

import { SessionMessageLoader } from './session-message-loader'
import { ChildStoreManager } from './child-store'

test('loads messages after a Strict Mode cleanup and effect setup', async () => {
  const childStores = new ChildStoreManager()
  let messageRequests = 0
  let resolveFirstRequest!: (value: Response) => void
  let markStarted!: () => void
  const started = new Promise<void>((resolve) => { markStarted = resolve })
  const firstResponse = new Promise<Response>((resolve) => { resolveFirstRequest = resolve })
  const sdk = createOpencodeClient({ baseUrl: 'http://lifecycle.test', fetch: async () => {
    messageRequests += 1
    if (messageRequests === 1) { markStarted(); return firstResponse }
    return Response.json([])
  } })
  const loader = new SessionMessageLoader(childStores, { sdk, runtimeKey: 'runtime' })
  const target = { directory: '/project', sessionID: 'session-1' }
  try {
    const firstLoad = loader.ensure(target)
    await started
    loader.dispose()
    loader.activate()
    await loader.ensure(target)
    resolveFirstRequest(Response.json([]))
    await firstLoad
    expect(messageRequests).toBe(2)
    expect(loader.getSnapshot(target).status).toBe('ready')
  } finally {
    loader.dispose()
    childStores.disposeAll()
  }
})
