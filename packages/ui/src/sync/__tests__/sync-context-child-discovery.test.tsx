import { describe, expect, test } from 'bun:test'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { Window } from 'happy-dom'
import { mock } from 'bun:test'
import { OpenCode } from '@opencode/client'
import type { Session } from '@/lib/opencode/model'
import type { SessionListOptions, SessionPage } from '@/lib/opencode/client'

const DIRECTORY = '/repo/discovery'
const cursorsSeenOnDiscoveryCalls: Array<string | undefined> = []
const parentMessageFetches: string[] = []

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
    cursorsSeenOnDiscoveryCalls.push(options.cursor)
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
    listProjects: async () => [],
    getFilesystemHome: async () => '/home',
    getLocation: async () => ({
      directory: DIRECTORY,
      project: { id: 'project', directory: DIRECTORY, canonical: DIRECTORY },
    }),
    getConfig: async () => ({}),
    getActiveSessionStatuses: async () => ({}),
    listCommands: async () => [],
    listAgents: async () => [],
    listMcpServers: async () => [],
    getVcs: async () => undefined,
    listPendingForms: async () => [],
    listPendingPermissions: async () => [],
    getProvidersForConfig: async () => ({ providers: [], models: [] }),
    getSession: async (id: string) => rootSession(id, id, 1),
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

      // Mark the parent as viewed so later ticks keep it as a discovery
      // candidate even while bootstrap's children list is still pending.
      setActiveSession(DIRECTORY, 'ses_parent')

      const store = getSyncChildStores().getChild(DIRECTORY)
      expect(store).toBeDefined()

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
