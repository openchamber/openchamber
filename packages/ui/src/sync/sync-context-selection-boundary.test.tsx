import { describe, expect, test } from 'bun:test'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { createOpencodeClient } from '@opencode-ai/sdk/v2'
import { SyncProvider, useChildStoreManager, useSyncDirectory } from './sync-context'
import { usePrefetchSessionMessages } from './use-sync'
import { installHookTestDom } from '../components/session/sidebar/test-utils/testDom'
import { useSessionUIStore } from './session-ui-store'
import { opencodeClient } from '@/lib/opencode/client'
import type { Message, Part } from '@opencode-ai/sdk/v2'

const createSdk = (respond?: (url: URL) => Response | undefined) => createOpencodeClient({
  baseUrl: 'https://sync.test',
  fetch: async (request) => {
    const url = new URL(request instanceof Request ? request.url : request.toString())
    const response = respond?.(url)
    if (response) return response
    const path = url.pathname
    if (path.endsWith('/global/event')) {
      return new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } })
    }
    const body = path.endsWith('/path')
      ? { state: '', config: '', worktree: '/workspace', directory: '/workspace', home: '/home' }
      : path.endsWith('/project') ? []
      : path.endsWith('/project/current') ? { id: 'project' }
      : path.endsWith('/session/status') ? {}
      : []
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
  },
})

describe('SyncProvider selection boundary', () => {
  for (const mode of ['confirmed', 'adopted'] as const) {
    test(`keeps the selected transcript whole after its directory is ${mode}`, async () => {
      const dom = installHookTestDom()
      const previousSurface = window.__OPENCHAMBER_SURFACE__
      window.__OPENCHAMBER_SURFACE__ = 'desktop'
      const root = createRoot(dom.container)
      let manager: ReturnType<typeof useChildStoreManager> | undefined
      const Probe = () => { manager = useChildStoreManager(); return null }
      const sessionID = `selected-${mode}`
      const directory = `/workspace/actual-${mode}`
      try {
        await act(async () => root.render(<SyncProvider sdk={createSdk()} directory="/workspace/guess"><Probe /></SyncProvider>))
        if (!manager) throw new Error('Directory manager was not mounted')
        const store = manager.ensureChild(directory, { bootstrap: false })
        const messages: Message[] = Array.from({ length: 10 }, (_, index) => ({
          id: `${sessionID}-${index}`, sessionID, role: 'user', time: { created: index },
          agent: 'build', model: { providerID: 'test', modelID: 'test' },
        }))
        const parts: { [id: string]: Part[] } = Object.fromEntries(messages.map((message) => [message.id, [{
          id: `part-${message.id}`, sessionID, messageID: message.id, type: 'text', text: 'prompt',
        }]]))
        await act(async () => {
          opencodeClient.setDirectory('/workspace/guess')
          useSessionUIStore.getState().setCurrentSession(sessionID, mode === 'confirmed' ? '/workspace/guess' : undefined)
          store.setState({
            session: [{ id: sessionID, slug: sessionID, projectID: 'project', directory, title: sessionID, version: '1', time: { created: 1, updated: 1 } }],
            message: { [sessionID]: messages }, part: parts,
          })
          if (mode === 'confirmed') useSessionUIStore.getState().setSessionDirectory(sessionID, directory)
          else useSessionUIStore.getState().adoptAuthoritativeSessionDirectory()
          await Promise.resolve()
        })
        expect(useSessionUIStore.getState().currentSessionDirectory).toBe(directory)
        expect(store.getState().message[sessionID]).toHaveLength(10)
        // Leaving starts the idle grace; the transcript stays whole meanwhile.
        await act(async () => { useSessionUIStore.getState().setCurrentSession(null); await Promise.resolve() })
        expect(store.getState().message[sessionID]).toHaveLength(10)
      } finally {
        useSessionUIStore.getState().setCurrentSession(null)
        await act(async () => root.unmount())
        window.__OPENCHAMBER_SURFACE__ = previousSurface
        dom.restore()
      }
    })
  }

  test('bounds failed session-page retries and preserves the last directory snapshot', async () => {
    const dom = installHookTestDom()
    const previousSurface = window.__OPENCHAMBER_SURFACE__
    window.__OPENCHAMBER_SURFACE__ = 'desktop'
    const root = createRoot(dom.container)
    let manager: ReturnType<typeof useChildStoreManager> | undefined
    const Probe = () => {
      manager = useChildStoreManager()
      return null
    }
    let fail = false
    let failedPageRequests = 0
    const sdk = createSdk((url) => {
      if (fail && url.pathname === '/experimental/session') {
        failedPageRequests += 1
        return Response.json({ message: 'OpenCode API unavailable' }, { status: 503 })
      }
      return undefined
    })

    try {
      await act(async () => root.render(<SyncProvider sdk={sdk} directory="/workspace/a"><Probe /></SyncProvider>))
      if (!manager) throw new Error('Bootstrap manager was not mounted')
      const mountedManager = manager
      const waitForState = (expected: 'complete' | 'failed') => new Promise<void>((resolve) => {
        if (mountedManager.getBootstrapState('/workspace/a') === expected) return resolve()
        const unsubscribe = mountedManager.subscribeBootstrap(() => {
          if (mountedManager.getBootstrapState('/workspace/a') !== expected) return
          unsubscribe()
          resolve()
        })
      })
      await act(() => waitForState('complete'))
      const store = manager.getChild('/workspace/a')
      if (!store) throw new Error('Directory store was not created')
      const cached = [{
        id: 'cached', slug: 'cached', title: 'Cached session', projectID: 'project',
        directory: '/workspace/a', version: '1', time: { created: 1, updated: 1 },
      }]
      store.setState({ session: cached, sessionListSource: 'authoritative' })
      fail = true
      await act(async () => {
        mountedManager.requestBootstrap({ directory: '/workspace/a', priority: 'selected', reason: 'current-directory', force: true })
        await waitForState('failed')
      })
      expect(failedPageRequests).toBe(3)
      expect(store.getState().session).toBe(cached)
    } finally {
      await act(async () => root.unmount())
      window.__OPENCHAMBER_SURFACE__ = previousSurface
      dom.restore()
    }
  }, 15_000)

  test('does not rerender a stable prefetch consumer when only current directory changes', async () => {
    const dom = installHookTestDom()
    const previousSurface = window.__OPENCHAMBER_SURFACE__
    window.__OPENCHAMBER_SURFACE__ = 'desktop'
    const root = createRoot(dom.container)
    let runtimeRenders = 0
    let directoryRenders = 0
    let callback: ReturnType<typeof usePrefetchSessionMessages> | undefined
    const RuntimeConsumer = React.memo(() => {
      callback = usePrefetchSessionMessages()
      runtimeRenders += 1
      return null
    })
    const DirectoryConsumer = () => {
      useSyncDirectory()
      directoryRenders += 1
      return null
    }
    const sdk = createSdk()

    try {
      await act(async () => root.render(
        <SyncProvider sdk={sdk} directory="/workspace/a">
          <RuntimeConsumer />
          <DirectoryConsumer />
        </SyncProvider>,
      ))
      const initialCallback = callback
      await act(async () => root.render(
        <SyncProvider sdk={sdk} directory="/workspace/b">
          <RuntimeConsumer />
          <DirectoryConsumer />
        </SyncProvider>,
      ))
      expect(runtimeRenders).toBe(1)
      expect(callback).toBe(initialCallback)
      expect(directoryRenders).toBe(2)
    } finally {
      await act(async () => root.unmount())
      window.__OPENCHAMBER_SURFACE__ = previousSurface
      dom.restore()
    }
  })
})
