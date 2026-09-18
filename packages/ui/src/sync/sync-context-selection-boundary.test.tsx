import { describe, expect, test } from 'bun:test'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { createOpencodeClient } from '@opencode-ai/sdk/v2'
import { SyncProvider, useChildStoreManager, useSyncDirectory } from './sync-context'
import { usePrefetchSessionMessages } from './use-sync'
import { installHookTestDom } from '../components/session/sidebar/test-utils/testDom'

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
  test('bounds failed session-page retries and preserves the last directory snapshot', async () => {
    const dom = installHookTestDom()
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
      dom.restore()
    }
  }, 15_000)

  test('does not rerender a stable prefetch consumer when only current directory changes', async () => {
    const dom = installHookTestDom()
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
      dom.restore()
    }
  })
})
