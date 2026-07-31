import { expect, test } from 'bun:test'
import { createStore } from 'zustand/vanilla'

import { SessionMessageLoader } from './session-message-loader'

test('loads messages after a Strict Mode cleanup and effect setup', async () => {
  const store = createStore(() => ({ message: {}, part: {} }))
  const childStores = { ensureChild: () => store, getChild: () => store }
  let messageRequests = 0
  let resolveFirstRequest: ((value: { data: []; response: { headers: { get: () => null } } }) => void) | undefined
  const sdk = { session: { messages: async () => {
    messageRequests += 1
    if (messageRequests === 1) return new Promise((resolve) => { resolveFirstRequest = resolve })
    return { data: [], response: { headers: { get: () => null } } }
  } } }
  const loader = new SessionMessageLoader(childStores as never, { sdk: sdk as never, runtimeKey: 'runtime' })
  const firstLoad = loader.ensure({ directory: '/project', sessionID: 'session-1' })
  loader.dispose(); loader.activate(); await loader.ensure({ directory: '/project', sessionID: 'session-1' })
  resolveFirstRequest?.({ data: [], response: { headers: { get: () => null } } }); await firstLoad
  expect(messageRequests).toBe(2)
  expect(loader.getSnapshot({ directory: '/project', sessionID: 'session-1' }).status).toBe('ready')
})
