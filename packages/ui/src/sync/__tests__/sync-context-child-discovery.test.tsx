import { describe, expect, test } from 'bun:test'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { Window } from 'happy-dom'
import { createOpencodeClient, type Session } from '@opencode-ai/sdk/v2'
import { SyncProvider, setActiveSession } from '../sync-context'
import { getSyncChildStores } from '../sync-refs'

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
    const DIRECTORY = '/repo/discovery'
    const cursorsSeenOnDiscoveryCalls: Array<number | undefined> = []
    const parentMessageFetches: string[] = []
    const childSession: Session = {
      id: 'ses_child',
      slug: 'ses_child',
      projectID: 'project',
      directory: DIRECTORY,
      title: 'subagent child',
      version: '1',
      parentID: 'ses_parent',
      time: { created: 1, updated: 10 },
    }

    const hang = () => new Promise<Response>(() => undefined)

    const sdk = createOpencodeClient({
      baseUrl: 'http://discovery.test',
      fetch: async (request) => {
        const url = new URL(request instanceof Request ? request.url : request.toString())
        const path = url.pathname
        if (path.endsWith('/global/event')) {
          return hang()
        }
        if (path.endsWith('/experimental/session')) {
          const roots = url.searchParams.get('roots') === 'true'
          const limit = Number(url.searchParams.get('limit') ?? '0')
          if (!roots && limit === 200) {
            // Only the watchdog's child-discovery loop requests pageSize 200
            // with roots unset (bootstrap uses 500 with roots true/false).
            const cursorParam = url.searchParams.get('cursor')
            const cursor = cursorParam === null ? undefined : Number(cursorParam)
            cursorsSeenOnDiscoveryCalls.push(cursor)
            if (cursor === undefined) {
              // Page 1: a full page of 200 parent-less root sessions ending at
              // time.updated 801, so the child (page 2) sits beyond the
              // pre-fix one-shot cutoff. The next-cursor header matches the
              // last record's time.updated; the helper reads it at
              // result.response.headers with "updated strictly before"
              // semantics. The child is created after bootstrap, which is
              // exactly the gap the watchdog's discovery pull covers.
              const page: Session[] = Array.from({ length: 200 }, (_, index) => ({
                id: `ses_root_${index}`,
                slug: `root_${index}`,
                projectID: 'project',
                directory: DIRECTORY,
                title: `root ${index}`,
                version: '1',
                time: { created: 1, updated: 1000 - index },
              }))
              return new Response(JSON.stringify(page), {
                status: 200,
                headers: { 'content-type': 'application/json', 'x-next-cursor': '801' },
              })
            }
            // Page 2: the subagent child of a known parent.
            return new Response(JSON.stringify([childSession]), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            })
          }
          if (roots) {
            // Bootstrap root list: the parent known to the directory.
            return new Response(JSON.stringify([{
              id: 'ses_parent',
              slug: 'parent',
              projectID: 'project',
              directory: DIRECTORY,
              title: 'parent',
              version: '1',
              time: { created: 1, updated: 1500 },
            }]), { status: 200, headers: { 'content-type': 'application/json' } })
          }
          // Bootstrap's broader children list: hang. Resolving it as empty
          // would replace the store's sessions after discovery merges them;
          // in production this list races discovery anyway, and the watchdog
          // tick re-discovers merged children.
          return hang()
        }
        if (path.endsWith('/session/status')) {
          return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
        }
        if (path.match(/\/session\/[^/]+\/message$/)) {
          parentMessageFetches.push(path)
          return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })
        }
        if (path.endsWith('/path')) {
          return new Response(JSON.stringify({ state: '', config: '', worktree: DIRECTORY, directory: DIRECTORY, home: '/home' }), { status: 200, headers: { 'content-type': 'application/json' } })
        }
        if (path.endsWith('/project/current')) {
          return new Response(JSON.stringify({ id: 'project' }), { status: 200, headers: { 'content-type': 'application/json' } })
        }
        if (path.endsWith('/config')) {
          return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } })
        }
        return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })
      },
    })

    try {
      // Seed the persisted cache so the watchdog's first pass (before any
      // bootstrap session commit) sees the parent as a candidate.
      seedPersistedSessions(DIRECTORY, [{
        id: 'ses_parent',
        slug: 'parent',
        projectID: 'project',
        directory: DIRECTORY,
        title: 'parent',
        version: '1',
        time: { created: 1, updated: 1500 },
      }])

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
        materialized = parentMessageFetches.includes('/session/ses_parent/message')
        return discovered && materialized
      }, 8000)

      // The child beyond the first page was discovered through pagination.
      expect(discovered).toBe(true)
      // The discovery loop fetched two pages: page 2 exists only because the
      // helper paginates past the 200 cutoff. The second request carried the
      // page-1 cursor boundary (801 = the x-next-cursor header, which equals
      // the last record's time.updated in this fixture; server cursor
      // semantics are "updated strictly before this timestamp"). The pre-fix
      // one-shot fetch never issued this second request.
      expect(cursorsSeenOnDiscoveryCalls).toEqual([undefined, 801])
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
