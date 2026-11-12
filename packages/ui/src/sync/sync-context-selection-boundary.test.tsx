import { describe, expect, spyOn, test } from 'bun:test'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { OpenCode } from '@opencode/client'
import { opencodeClient } from '@/lib/opencode/client'
import { SyncProvider, useChildStoreManager, useSyncDirectory } from './sync-context'
import { usePrefetchSessionMessages } from './use-sync'
import { installHookTestDom } from '../components/session/sidebar/test-utils/testDom'
import { useSessionUIStore } from './session-ui-store'
import { useProjectsStore } from '@/stores/useProjectsStore'
import type { Message, Part, Session } from '@/lib/opencode/model'
import type { SessionPage } from '@/lib/opencode/client'

// The provider's own data access goes through the `opencodeClient` singleton;
// this client only satisfies the prop and absorbs the event stream, so the
// assertion below measures render boundaries and nothing else.
const createSdk = () => OpenCode.make({
  baseUrl: 'https://sync.test',
  fetch: async (request) => {
    const path = new URL(request instanceof Request ? request.url : request.toString()).pathname
    if (path.endsWith('/event')) {
      return new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } })
    }
    const body = path.endsWith('/location')
      ? { directory: '/workspace', project: { id: 'project', directory: '/workspace', canonical: '/workspace' } }
      : path.endsWith('/session/active') ? {}
      : { data: [] }
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
  },
})

describe('SyncProvider selection boundary', () => {
  for (const outcome of ['complete', 'failed'] as const) {
    test(`publishes subagents before later history pages settle as ${outcome}`, async () => {
      const dom = installHookTestDom()
      const previousSurface = window.__OPENCHAMBER_SURFACE__
      window.__OPENCHAMBER_SURFACE__ = 'desktop'
      const root = createRoot(dom.container)
      const directory = `/workspace/progressive-bootstrap-${outcome}`
      let manager: ReturnType<typeof useChildStoreManager> | undefined
      const Probe = () => { manager = useChildStoreManager(); return null }
      const parent: Session = {
        id: 'parent', title: 'Parent', projectID: 'project', directory, cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: 1, updated: 1 },
      }
      const child: Session = { ...parent, id: 'child', parentID: parent.id }
      const older: Session = { ...parent, id: 'older' }
      let finishPage!: (page: SessionPage) => void
      const laterPage = new Promise<SessionPage>((resolve) => { finishPage = resolve })
      let pageStarted!: () => void
      const secondPageStarted = new Promise<void>((resolve) => { pageStarted = resolve })
      const list = spyOn(opencodeClient, 'listSessionsPage').mockImplementation(async (options) => {
        if (options?.directory !== directory) return { sessions: [], cursor: {} }
        if (!options.cursor) return { sessions: [parent, child], cursor: { next: 'older' } }
        pageStarted()
        const page = await laterPage
        if (outcome === 'failed') throw Object.assign(new Error('Later page unavailable'), { status: 503 })
        return page
      })
      try {
        await act(async () => {
          root.render(<SyncProvider sdk={createSdk()} directory={directory}><Probe /></SyncProvider>)
        })
        await act(() => secondPageStarted)
        if (!manager) throw new Error('Bootstrap manager was not mounted')
        const mountedManager = manager
        const store = mountedManager.getChild(directory)
        if (!store) throw new Error('Directory store was not created')
        expect(store.getState().session.map((session) => session.id)).toEqual(['child', 'parent'])
        expect(store.getState().sessionListSource).not.toBe('authoritative')
        expect(mountedManager.getBootstrapState(directory)).not.toBe('complete')
        await act(async () => {
          const completed = new Promise<void>((resolve) => {
            const unsubscribe = mountedManager.subscribeBootstrap(() => {
              if (mountedManager.getBootstrapState(directory) !== outcome) return
              unsubscribe()
              resolve()
            })
          })
          finishPage({ sessions: [older], cursor: {} })
          await completed
        })
        if (outcome === 'complete') {
          expect(store.getState().session.map((session) => session.id)).toEqual(['child', 'older', 'parent'])
          expect(store.getState().sessionListSource).toBe('authoritative')
          expect(store.getState().sessionTotal).toBe(2)
        } else {
          expect(store.getState().session.map((session) => session.id)).toEqual(['child', 'parent'])
          expect(store.getState().sessionListSource).not.toBe('authoritative')
        }
      } finally {
        finishPage({ sessions: [], cursor: {} })
        await act(async () => root.unmount())
        list.mockRestore()
        window.__OPENCHAMBER_SURFACE__ = previousSurface
        dom.restore()
      }
    }, 15_000)
  }

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
      const previousProjects = useProjectsStore.getState().projects
      useProjectsStore.setState({ projects: [{ id: 'project', path: '/workspace' }] })
      const detail = mode === 'adopted' ? spyOn(opencodeClient, 'getSession').mockResolvedValue({
        id: sessionID, projectID: 'project', directory, title: sessionID, cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 1 },
      }) : null
      try {
        await act(async () => root.render(<SyncProvider sdk={createSdk()} directory="/workspace/guess"><Probe /></SyncProvider>))
        if (!manager) throw new Error('Directory manager was not mounted')
        const store = manager.ensureChild(directory, { bootstrap: false })
        const messages: Message[] = Array.from({ length: 10 }, (_, index) => ({
          id: `${sessionID}-${index}`, sessionID, role: 'user', time: { created: index },
        }))
        const parts: { [id: string]: Part[] } = Object.fromEntries(messages.map((message) => [message.id, [{
          id: `part-${message.id}`, sessionID, messageID: message.id, type: 'text', text: 'prompt',
        }]]))
        await act(async () => {
          opencodeClient.setDirectory('/workspace/guess')
          useSessionUIStore.getState().setCurrentSession(sessionID, mode === 'confirmed' ? '/workspace/guess' : undefined)
          store.setState({
            session: [{
              id: sessionID, projectID: 'project', directory, title: sessionID, cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 1 },
            }],
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
        useProjectsStore.setState({ projects: previousProjects })
        detail?.mockRestore()
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
    // Providers unmounted by earlier tests keep retrying their own directory's
    // bootstrap in the background (their `session.active` read never succeeds
    // here); only this directory's requests measure the retry bound.
    const list = spyOn(opencodeClient, 'listSessionsPage').mockImplementation(async (options) => {
      if (fail) {
        if (options?.directory === '/workspace/a') failedPageRequests += 1
        throw Object.assign(new Error('OpenCode API unavailable'), { status: 503 })
      }
      return { sessions: [], cursor: {} }
    })
    const sdk = createSdk()

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
        id: 'cached', title: 'Cached session', projectID: 'project',
        directory: '/workspace/a', time: { created: 1, updated: 1 }, cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
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
      list.mockRestore()
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
