import { describe, expect, jest, spyOn, test } from 'bun:test'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { Window } from 'happy-dom'
import { mock } from 'bun:test'
import { OpenCode } from '@opencode/client'
import type { Session, SessionStatus } from '@/lib/opencode/model'
import type { SessionListOptions, SessionPage } from '@/lib/opencode/client'

const DIRECTORY = '/repo/discovery'
const cursorsSeenOnDiscoveryCalls: Array<string | undefined> = []
const parentsSeenOnDiscoveryCalls: Array<string | null | undefined> = []
const parentMessageFetches: string[] = []
let activeStatusReads = 0
let readActiveStatuses = async (_directory: string): Promise<Record<string, SessionStatus> | null> => ({})
let readDiscoveryPage: ((options: SessionListOptions) => Promise<SessionPage>) | undefined
let readSession: ((id: string, directory?: string) => Promise<Session>) | undefined

const rootSession = (id: string, title: string, updated: number): Session => ({
  id,
  projectID: 'project',
  directory: DIRECTORY,
  title,
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated },
})

const childSession: Session = { ...rootSession('ses_child', 'subagent child', 10), parentID: 'ses_parent' }

const hang = <T,>(): Promise<T> => new Promise<T>(() => undefined)

// The provider reads every session list through the client wrapper, so the
// pagination under test is driven here rather than through a fake transport.
const listSessionsPage = async (options: SessionListOptions = {}): Promise<SessionPage> => {
  if (options.limit === 200) {
    if (readDiscoveryPage) return readDiscoveryPage(options)
    cursorsSeenOnDiscoveryCalls.push(options.cursor)
    parentsSeenOnDiscoveryCalls.push(options.parentID)
    if (options.cursor === undefined) {
      // Page 1: a full page of root sessions, so the child on page 2 sits
      // beyond the pre-fix one-shot cutoff.
      return {
        sessions: Array.from({ length: 200 }, (_, index) => rootSession(`ses_root_${index}`, `root ${index}`, 1000 - index)),
        cursor: { next: 'cursor_page_2' },
      }
    }
    return { sessions: [childSession], cursor: {} }
  }
  if (readDiscoveryPage) return { sessions: [], cursor: {} }
  if (options.limit === 500) {
    // Bootstrap's own list: hang. Resolving it would replace the store's
    // sessions after discovery merged them; in production the two race and the
    // next watchdog tick re-discovers merged children.
    return hang()
  }
  return { sessions: [], cursor: {} }
}

let sequence = 0
// Staleness checks compare client identity across awaits, so these must be
// stable references rather than a fresh object per call.
const sdkIdentity = {}

mock.module('@/lib/opencode/client', () => ({
  ascendingId: (prefix: string) => `${prefix}_${(sequence += 1).toString().padStart(6, '0')}`,
  isOpencodeNotFound: () => false,
  OpencodeApiError: Error,
  normalizeOpencodeError: (operation: string, error: unknown) => new Error(`${operation}: ${String(error)}`),
  OPENCODE_DIRECTORY_HEADER: 'x-opencode-directory',
  opencodeClient: {
    listSessionsPage,
    getSdkClient: () => sdkIdentity,
    getScopedSdkClient: () => sdkIdentity,
    getDirectory: () => DIRECTORY,
    setDirectory: () => undefined,
    clearConfigCache: () => undefined,
    learnMessagePageShellsSupport: () => undefined,
    listProjects: async () => [],
    getFilesystemHome: async () => '/home',
    getLocation: async () => ({
      directory: DIRECTORY,
      project: { id: 'project', directory: DIRECTORY, canonical: DIRECTORY },
    }),
    getConfig: async () => ({}),
    getActiveSessionStatuses: async (directory: string) => {
      activeStatusReads += 1
      return readActiveStatuses(directory)
    },
    listCommands: async () => [],
    listAgents: async () => [],
    listMcpServers: async () => [],
    getVcs: async () => undefined,
    listPendingForms: async () => [],
    listPendingPermissions: async () => [],
    // The host's status map: these tests run without one, as a failed read.
    getHostSessionStatusSnapshot: async () => null,
    getProvidersForConfig: async () => ({ providers: [], models: [] }),
    getSession: async (id: string, directory?: string) => readSession ? readSession(id, directory) : rootSession(id, id, 1),
    getSessionMessages: async (id: string) => {
      parentMessageFetches.push(id)
      return { items: [], cursor: {} }
    },
  },
}))

const { SyncProvider, setActiveSession } = await import('../sync-context')
const { getSyncChildStores } = await import('../sync-refs')

/**
 * Regression guard for silent child-session truncation in the watchdog's
 * `discoverChildSessions`: the discovery list must paginate past a full first
 * page, so a subagent child session beyond the pageSize cutoff is still
 * discovered, merged into the directory store, and triggers parent
 * materialization.
 *
 * The scenario is driven through a full SyncProvider mount against a mocked
 * OpenCode server. The parent arrives via the persisted directory cache and is
 * kept in the store (bootstrap's own children list is left pending), so after
 * the watchdog's discovery pull all known sessions must come from one
 * authoritative bootstrap roots page plus the paginated discovery pages.
 */

const DOM_GLOBAL_NAMES = [
  'window',
  'document',
  'localStorage',
  'navigator',
  'Node',
  'Element',
  'HTMLElement',
  'IS_REACT_ACT_ENVIRONMENT',
] as const

const installHookTestDomWithStorage = () => {
  const win = new Window({ url: 'http://localhost' })
  const previous = DOM_GLOBAL_NAMES.map(
    (name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
  )
  // SAFETY: React's test renderer and the provider under test only read these
  // fixture globals for DOM identity, storage, and environment flags — the
  // same subset the ReasoningPart.test.tsx fixture installs.
  const values = {
    window: win,
    document: win.document,
    localStorage: win.localStorage,
    navigator: win.navigator,
    Node: win.Node,
    Element: win.Element,
    HTMLElement: win.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  }
  for (const name of DOM_GLOBAL_NAMES) {
    // SAFETY: every name comes from the same DOM_GLOBAL_NAMES tuple that keys
    // the fixture values above, so the lookup is always a known property with
    // a concrete fixture-provided value.
    Object.defineProperty(globalThis, name, {
      value: values[name],
      configurable: true,
      writable: true,
    })
  }
  const container = document.createElement('div')
  document.body.appendChild(container)
  return {
    container,
    restore: () => {
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor)
        else Reflect.deleteProperty(globalThis, name)
      }
    },
  }
}

const waitFor = async (predicate: () => boolean, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return predicate()
}

/** Mirror persist-cache's v2 storage key so the parent survives bootstrap. */
const seedPersistedSessions = (directory: string, sessions: Session[]): void => {
  const head = directory.slice(0, 12).replace(/[^a-zA-Z0-9]/g, '_')
  const hashSource = `url:default\u0000${directory}`
  let hash = 0
  for (let i = 0; i < hashSource.length; i++) {
    hash = ((hash << 5) - hash) + hashSource.charCodeAt(i)
    hash |= 0
  }
  const key = `oc.dir.v2.${head}.${Math.abs(hash).toString(36)}.sessions`
  window.localStorage.setItem(key, JSON.stringify(sessions))
}

describe('SyncProvider child-session discovery pagination', () => {
  // The watchdog's first synchronous tick runs before the current-directory
  // effect creates the child store, so discovery's first effective pass is the
  // interval's second tick (~5s after mount).
  test('discovers a child session on page 2 beyond the 200 cutoff and materializes its parent', async () => {
    const dom = installHookTestDomWithStorage()
    cursorsSeenOnDiscoveryCalls.length = 0
    parentsSeenOnDiscoveryCalls.length = 0
    parentMessageFetches.length = 0
    const sdk = OpenCode.make({ baseUrl: 'http://discovery.test', fetch: () => hang<Response>() })

    try {
      // Seed the persisted cache so the watchdog's first pass (before any
      // bootstrap session commit) sees the parent as a candidate.
      seedPersistedSessions(DIRECTORY, [rootSession('ses_parent', 'parent', 1500)])

      const root = createRoot(dom.container)
      await act(async () => root.render(
        <SyncProvider sdk={sdk} directory={DIRECTORY}>
          <div />
        </SyncProvider>,
      ))

      setActiveSession(DIRECTORY, 'ses_parent')

      const store = getSyncChildStores().getChild(DIRECTORY)
      expect(store).toBeDefined()
      // A parent spawning subagents is running a turn. Discovery follows live
      // work, so the busy parent stays a candidate while bootstrap's children
      // list is still pending; an idle viewed session is not polled.
      store?.setState((state) => ({ session_status: { ...state.session_status, ses_parent: { type: 'busy' } } }))

      let discovered = false
      let materialized = false
      await waitFor(() => {
        const state = store?.getState()
        if (!state) return false
        discovered = state.session.some((session) => session.id === 'ses_child')
        materialized = parentMessageFetches.includes('ses_parent')
        return discovered && materialized
      }, 8000)

      // The child beyond the first page was discovered through pagination.
      expect(discovered).toBe(true)
      // The discovery loop fetched two pages: page 2 exists only because the
      // helper paginates past the first full page, carrying the cursor page 1
      // returned. The pre-fix one-shot fetch never issued this second request.
      expect(cursorsSeenOnDiscoveryCalls).toEqual([undefined, 'cursor_page_2'])
      // Both pages list the live parent's children only, never the whole directory.
      expect(parentsSeenOnDiscoveryCalls).toEqual(['ses_parent', 'ses_parent'])
      // Parent materialization was enqueued so the Task tool part refreshes.
      expect(materialized).toBe(true)

      const finalState = store?.getState()
      const mergedChild = finalState?.session.find((session) => session.id === 'ses_child')
      expect(mergedChild?.parentID).toBe('ses_parent')

      await act(async () => root.unmount())
    } finally {
      setActiveSession('', '')
      dom.restore()
    }
  }, 12000)
})

const withWatchdogFixture = async (run: (fixture: {
  advance: (ms: number) => Promise<void>
  manager: ReturnType<typeof getSyncChildStores>
}) => Promise<void>) => {
  const { useConfigStore } = await import('@/stores/useConfigStore')
  const previousTransport = useConfigStore.getState().settingsMessageStreamTransport
  useConfigStore.setState({ settingsMessageStreamTransport: 'sse' })
  const dom = installHookTestDomWithStorage()
  const root = createRoot(dom.container)
  let now = Date.now()
  const clock = spyOn(Date, 'now').mockImplementation(() => now)
  jest.useFakeTimers()
  const sdk = OpenCode.make({ baseUrl: 'http://watchdog.test', fetch: () => hang<Response>() })
  // One activity signal, followed by a stalled stream. Watchdog reconnect
  // requests cannot introduce a second stream's independent recovery reads.
  const stream = spyOn(sdk.event, 'subscribe').mockImplementation(async function* (options) {
    options?.onActivity?.()
    yield await hang<never>()
  })
  const advance = async (ms: number) => {
    for (let elapsed = 0; elapsed < ms; elapsed += 500) {
      await act(async () => {
        const step = Math.min(500, ms - elapsed)
        now += step
        jest.advanceTimersByTime(step)
        await new Promise<void>((resolve) => setImmediate(resolve))
      })
    }
  }
  try {
    readDiscoveryPage = async () => ({ sessions: [], cursor: {} })
    await act(async () => root.render(<SyncProvider sdk={sdk} directory={DIRECTORY}><div /></SyncProvider>))
    await run({ advance, manager: getSyncChildStores() })
  } finally {
    setActiveSession('', '')
    await act(async () => root.unmount())
    stream.mockRestore()
    jest.useRealTimers()
    clock.mockRestore()
    readActiveStatuses = async () => ({})
    readDiscoveryPage = undefined
    readSession = undefined
    useConfigStore.setState({ settingsMessageStreamTransport: previousTransport })
    dom.restore()
  }
}

describe('SyncProvider sibling watchdog reads', () => {
  for (const failure of ['null', 'rejection']) {
    test(`paces stale resync after a ${failure} status read and resets on success`, async () => {
      await withWatchdogFixture(async ({ advance, manager }) => {
        const store = manager.getChild(DIRECTORY)
        if (!store) throw new Error('Directory store was not created')
        const otherDirectory = '/repo/healthy-resync'
        const other = manager.ensureChild(otherDirectory, { bootstrap: false })
        // A resolved, idle viewed session needs stale recovery but no periodic
        // status poll. The other directory remains busy and runs every path.
        setActiveSession(DIRECTORY, 'ses_viewed')
        store.setState({
          session: [rootSession('ses_viewed', 'viewed', 1)],
          message: { ses_viewed: [] },
          session_status: { ses_viewed: { type: 'idle' } },
        })
        other.setState({
          session: [{ ...rootSession('ses_healthy', 'healthy', 1), directory: otherDirectory }],
          session_status: { ses_healthy: { type: 'busy' } },
        })
        const statusReads: string[] = []
        const sessionReads: string[] = []
        let failing = true
        readActiveStatuses = async (directory) => {
          statusReads.push(directory)
          if (directory === DIRECTORY && failing) {
            if (failure === 'rejection') throw new Error('Status unavailable')
            return null
          }
          return { ses_healthy: { type: 'busy' } }
        }
        readSession = async (id, directory) => {
          sessionReads.push(directory ?? '')
          return { ...rootSession(id, id, 1), directory: directory ?? DIRECTORY }
        }
        const failedReads = () => statusReads.filter((directory) => directory === DIRECTORY).length
        const healthyResyncs = () => sessionReads.filter((directory) => directory === otherDirectory).length
        await advance(20_000)
        expect(failedReads()).toBe(1)
        expect(healthyResyncs()).toBe(1)
        await advance(15_000)
        expect(failedReads()).toBe(1)
        expect(healthyResyncs()).toBe(2)
        await advance(15_000)
        expect(failedReads()).toBe(2)
        await advance(55_000)
        expect(failedReads()).toBe(2)
        expect(healthyResyncs()).toBe(6)
        await advance(5_000)
        expect(failedReads()).toBe(3)
        // A successful empty snapshot clears only this resync's delay.
        failing = false
        await advance(60_000)
        expect(failedReads()).toBe(4)
        await advance(15_000)
        expect(failedReads()).toBe(5)
        await advance(15_000)
        expect(failedReads()).toBe(6)
      })
    })
  }

  for (const failure of ['session', 'messages', 'forms', 'permissions']) {
    test(`paces failed ${failure} resyncs despite successful status polls and discovery`, async () => {
      await withWatchdogFixture(async ({ advance, manager }) => {
        const { opencodeClient } = await import('@/lib/opencode/client')
        const store = manager.getChild(DIRECTORY)
        if (!store) throw new Error('Directory store was not created')
        store.setState({
          session: [rootSession('ses_parent', 'parent', 1)],
          session_status: { ses_parent: { type: 'busy' } },
        })
        let failing = true
        let resyncReads = 0
        readActiveStatuses = async () => ({ ses_parent: { type: 'busy' } })
        readSession = async (id) => {
          resyncReads += 1
          if (failure === 'session' && failing) throw new Error('Session record unavailable')
          return rootSession(id, id, 1)
        }
        const messages = spyOn(opencodeClient, 'getSessionMessages').mockImplementation(async () => {
          if (failure === 'messages' && failing) throw new Error('transport failure')
          return { items: [], cursor: {} }
        })
        const forms = spyOn(opencodeClient, 'listPendingForms').mockImplementation(async () => {
          if (failure === 'forms' && failing) throw new Error('Form list unavailable')
          return []
        })
        const permissions = spyOn(opencodeClient, 'listPendingPermissions').mockImplementation(async () => {
          if (failure === 'permissions' && failing) throw new Error('Permission list unavailable')
          return []
        })
        try {
          await advance(25_000)
          expect(resyncReads).toBe(1)
          await advance(10_000)
          expect(resyncReads).toBe(1)
          await advance(30_000)
          expect(resyncReads).toBe(2)
          await advance(40_000)
          expect(resyncReads).toBe(2)
          await advance(15_000)
          expect(resyncReads).toBe(3)
          await advance(10_000)
          expect(resyncReads).toBe(3)
          failing = false
          for (let elapsed = 0; resyncReads === 3 && elapsed < 70_000; elapsed += 500) await advance(500)
          expect(resyncReads).toBe(4)
          await advance(15_000)
          expect(resyncReads).toBe(5)
          expect(store.getState().session_status.ses_parent?.type).toBe('busy')
        } finally {
          messages.mockRestore()
          forms.mockRestore()
          permissions.mockRestore()
        }
      })
    })
  }

  test('paces exhausted discovery pages independently of successful status polls and stale resyncs', async () => {
    await withWatchdogFixture(async ({ advance, manager }) => {
      const otherDirectory = '/repo/healthy-discovery'
      const stores = [
        { directory: DIRECTORY, store: manager.getChild(DIRECTORY), id: 'ses_parent' },
        { directory: otherDirectory, store: manager.ensureChild(otherDirectory, { bootstrap: false }), id: 'ses_healthy' },
      ]
      for (const { directory, store, id } of stores) {
        if (!store) throw new Error('Directory store was not created')
        store.setState({
          session: [{ ...rootSession(id, id, 1), directory }],
          session_status: { [id]: { type: 'busy' } },
        })
      }
      const discoveryReads: string[] = []
      const statusReads: string[] = []
      const sessionReads: string[] = []
      let failing = true
      readActiveStatuses = async (directory) => {
        statusReads.push(directory)
        return { ses_parent: { type: 'busy' }, ses_healthy: { type: 'busy' } }
      }
      readSession = async (id, directory) => {
        sessionReads.push(directory ?? '')
        return { ...rootSession(id, id, 1), directory: directory ?? DIRECTORY }
      }
      readDiscoveryPage = async (options) => {
        discoveryReads.push(options.directory ?? '')
        if (options.directory === DIRECTORY && failing) throw new Error('Session list unavailable')
        return { sessions: [], cursor: {} }
      }
      const failedReads = () => discoveryReads.filter((directory) => directory === DIRECTORY).length
      const healthyReads = () => discoveryReads.filter((directory) => directory === otherDirectory).length
      // The page helper retains its three attempts, 500 then 1000 ms apart.
      await advance(10_000)
      expect(failedReads()).toBe(3)
      await advance(25_000)
      expect(failedReads()).toBe(3)
      expect(healthyReads()).toBe(3)
      expect(statusReads.filter((directory) => directory === DIRECTORY)).toHaveLength(9)
      expect(sessionReads.filter((directory) => directory === DIRECTORY)).toHaveLength(2)
      await advance(10_000)
      expect(failedReads()).toBe(6)
      await advance(55_000)
      expect(failedReads()).toBe(6)
      await advance(10_000)
      expect(failedReads()).toBe(9)
      failing = false
      await advance(65_000)
      expect(failedReads()).toBe(10)
      await advance(15_000)
      expect(failedReads()).toBe(11)
      await advance(15_000)
      expect(failedReads()).toBe(12)
    })
  })
})

describe('SyncProvider active-session watchdog status poll', () => {
  for (const failure of ['null', 'rejection']) {
    test(`backs off ${failure} failures per directory and resets after success`, async () => {
      const { useConfigStore } = await import('@/stores/useConfigStore')
      const previousTransport = useConfigStore.getState().settingsMessageStreamTransport
      // Keep the fixture's pending stream on SSE so advancing all timers
      // cannot trigger WebSocket fallback's separate status resync.
      useConfigStore.setState({ settingsMessageStreamTransport: 'sse' })
      const dom = installHookTestDomWithStorage()
      const root = createRoot(dom.container)
      const sdk = OpenCode.make({ baseUrl: 'http://backoff.test', fetch: () => hang<Response>() })
      let now = Date.now()
      const clock = spyOn(Date, 'now').mockImplementation(() => now)
      jest.useFakeTimers()
      const reads: string[] = []
      let failing = true
      readActiveStatuses = async (directory) => {
        reads.push(directory)
        if (directory === DIRECTORY && failing) {
          if (failure === 'rejection') throw new Error('Upstream unavailable')
          return null
        }
        return { ses_parent: { type: 'busy' }, ses_healthy: { type: 'busy' } }
      }
      const advance = async (ms: number) => {
        await act(async () => {
          now += ms
          jest.advanceTimersByTime(ms)
          await new Promise<void>((resolve) => setImmediate(resolve))
        })
      }
      try {
        await act(async () => root.render(<SyncProvider sdk={sdk} directory={DIRECTORY}><div /></SyncProvider>))
        const manager = getSyncChildStores()
        const store = manager.getChild(DIRECTORY)
        if (!store) throw new Error('Directory store was not created')
        const otherDirectory = '/repo/healthy'
        const other = manager.ensureChild(otherDirectory)
        for (const { directory, child } of [{ directory: DIRECTORY, child: store }, { directory: otherDirectory, child: other }]) {
          const id = directory === DIRECTORY ? 'ses_parent' : 'ses_healthy'
          child.setState({
            session: [{ ...rootSession(id, 'parent', 1500), directory }],
            session_status: { [id]: { type: 'busy' } },
          })
        }
        reads.length = 0
        await advance(5_000)
        expect(reads.filter((directory) => directory === DIRECTORY)).toHaveLength(1)
        expect(store.getState().session_status.ses_parent?.type).toBe('busy')

        // Every skipped tick still polls the healthy directory. The failing
        // directory retries after 10, 20, 40, then repeated 60 second waits.
        let expectedReads = 1
        for (const delay of [10_000, 20_000, 40_000, 60_000, 60_000]) {
          for (let elapsed = 5_000; elapsed < delay; elapsed += 5_000) {
            const healthyReads = reads.filter((directory) => directory === otherDirectory).length
            await advance(5_000)
            expect(reads.filter((directory) => directory === DIRECTORY)).toHaveLength(expectedReads)
            expect(reads.filter((directory) => directory === otherDirectory)).toHaveLength(healthyReads + 1)
          }
          await advance(5_000)
          expectedReads += 1
          expect(reads.filter((directory) => directory === DIRECTORY)).toHaveLength(expectedReads)
          expect(store.getState().session_status.ses_parent?.type).toBe('busy')
        }

        failing = false
        await advance(60_000)
        expectedReads += 1
        expect(reads.filter((directory) => directory === DIRECTORY)).toHaveLength(expectedReads)
        await advance(5_000)
        expectedReads += 1
        expect(reads.filter((directory) => directory === DIRECTORY)).toHaveLength(expectedReads)

        let finishSlowPoll!: () => void
        let slowPoll = true
        readActiveStatuses = async (directory) => {
          reads.push(directory)
          if (directory !== DIRECTORY) return { ses_healthy: { type: 'busy' } }
          if (slowPoll) await new Promise<void>((resolve) => { finishSlowPoll = resolve })
          if (failure === 'rejection') throw new Error('Upstream unavailable')
          return null
        }
        await advance(5_000)
        expectedReads += 1
        await advance(60_000)
        expect(reads.filter((directory) => directory === DIRECTORY)).toHaveLength(expectedReads)
        slowPoll = false
        await act(async () => {
          finishSlowPoll()
          await new Promise<void>((resolve) => setImmediate(resolve))
        })
        await advance(5_000)
        expect(reads.filter((directory) => directory === DIRECTORY)).toHaveLength(expectedReads)
        await advance(5_000)
        expect(reads.filter((directory) => directory === DIRECTORY)).toHaveLength(expectedReads + 1)

        store.setState({ session_status: { ses_parent: { type: 'idle' } } })
        await advance(5_000)
        store.setState({ session_status: { ses_parent: { type: 'busy' } } })
        await advance(5_000)
        expect(reads.filter((directory) => directory === DIRECTORY)).toHaveLength(expectedReads + 2)

        // An empty successful snapshot still follows normal authoritative
        // recovery and settles a session whose idle event was lost.
        readActiveStatuses = async (directory) => {
          reads.push(directory)
          return {}
        }
        await advance(10_000)
        expect(store.getState().session_status.ses_parent?.type).toBe('idle')
      } finally {
        await act(async () => root.unmount())
        jest.useRealTimers()
        clock.mockRestore()
        useConfigStore.setState({ settingsMessageStreamTransport: previousTransport })
        readActiveStatuses = async () => ({})
        dom.restore()
      }
    })
  }

  // Over the private relay a 5 s poll keeps the relay awake, so an open but
  // idle session must not be polled; live work still is.
  test('polls status for a busy session and not for an idle viewed one', async () => {
    const dom = installHookTestDomWithStorage()
    const sdk = OpenCode.make({ baseUrl: 'http://poll.test', fetch: () => hang<Response>() })
    try {
      seedPersistedSessions(DIRECTORY, [rootSession('ses_idle', 'idle', 1500)])
      const root = createRoot(dom.container)
      await act(async () => root.render(
        <SyncProvider sdk={sdk} directory={DIRECTORY}>
          <div />
        </SyncProvider>,
      ))
      setActiveSession(DIRECTORY, 'ses_idle')
      const store = getSyncChildStores().getChild(DIRECTORY)
      // Rendered history makes the viewed session resolved and idle.
      store?.setState((state) => ({
        message: { ...state.message, ses_idle: [] },
        session_status: { ...state.session_status, ses_idle: { type: 'idle' } },
      }))

      await new Promise((resolve) => setTimeout(resolve, 1000))
      const idleBaseline = activeStatusReads
      await new Promise((resolve) => setTimeout(resolve, 6000))
      expect(activeStatusReads).toBe(idleBaseline)

      store?.setState((state) => ({ session_status: { ...state.session_status, ses_idle: { type: 'busy' } } }))
      expect(await waitFor(() => activeStatusReads > idleBaseline, 6000)).toBe(true)

      await act(async () => root.unmount())
    } finally {
      setActiveSession('', '')
      dom.restore()
    }
  }, 20000)
})
