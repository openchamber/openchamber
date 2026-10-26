import { describe, expect, spyOn, test } from 'bun:test'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { OpenCode } from '@opencode/client'
import { opencodeClient } from '@/lib/opencode/client'
import type { FormRequest, PermissionRequest } from '@/lib/opencode/model'
import { applyGlobalBlockingRequestEvents, readHostBlockingRequestsSnapshot, resetGlobalBlockingRequests } from './global-blocking-requests'
import { SyncProvider, useDirectoryStore, useSessionBlockingRequests } from './sync-context'
import { installHookTestDom } from '../components/session/sidebar/test-utils/testDom'

// The provider has no current directory to bootstrap; the two scoped stores
// receive only the live bucket writes made by these tests.
const CURRENT_DIR = '/workspace'
const PARENT_DIR = '/repo'
const CHILD_DIR = '/worktrees/feature'

const createSdk = () => OpenCode.make({
  baseUrl: 'https://sync.test',
  fetch: async (request) => {
    const path = new URL(request instanceof Request ? request.url : request.toString()).pathname
    if (path.endsWith('/event')) {
      return new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } })
    }
    const body = path.endsWith('/location')
      ? { directory: CURRENT_DIR, project: { id: 'project', directory: CURRENT_DIR, canonical: CURRENT_DIR } }
      : path.endsWith('/session/active') ? {}
      : { data: [] }
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
  },
})

const permission = (id: string, sessionID: string): PermissionRequest => ({ id, sessionID, action: 'bash', resources: [] })
const form = (id: string, sessionID: string): FormRequest => ({ id, sessionID, title: 'Answer', fields: [{ key: 'answer', type: 'boolean' }] })

type ProbeStores = {
  parent: ReturnType<typeof useDirectoryStore>
  child: ReturnType<typeof useDirectoryStore>
}

let stores: ProbeStores | null = null
let rendered: { hasPermission: boolean; hasForm: boolean } | null = null
let renderCount = 0

/**
 * A collapsed row subscribes to its own bucket plus every hidden descendant's;
 * an expanded row subscribes to its own only. `includeChild` is that difference.
 */
const CountsProbe = ({ includeChild }: { includeChild: boolean }) => {
  const parentStore = useDirectoryStore(PARENT_DIR, { bootstrap: false })
  const childStore = useDirectoryStore(CHILD_DIR, { bootstrap: false })
  stores = { parent: parentStore, child: childStore }
  // Stable identity: the hook keys its store resolution and pinning on this array.
  const scopes = React.useMemo(() => (includeChild
    ? [
        { directory: PARENT_DIR, sessionIDs: ['parent'] },
        { directory: CHILD_DIR, sessionIDs: ['child'] },
      ]
    : [{ directory: PARENT_DIR, sessionIDs: ['parent'] }]), [includeChild])
  rendered = useSessionBlockingRequests(scopes)
  renderCount += 1
  return null
}

const withProbe = async (includeChild: boolean, assert: () => Promise<void>) => {
  const dom = installHookTestDom()
  const previousSurface = window.__OPENCHAMBER_SURFACE__
  window.__OPENCHAMBER_SURFACE__ = 'desktop'
  const homeInfo = spyOn(opencodeClient, 'getFilesystemHomeInfo').mockResolvedValue({ home: '/home' })
  const home = spyOn(opencodeClient, 'getFilesystemHome').mockResolvedValue('/home')
  const location = spyOn(opencodeClient, 'getLocation').mockResolvedValue({
    directory: CURRENT_DIR,
    project: { id: 'project', directory: CURRENT_DIR, canonical: CURRENT_DIR },
  })
  const config = spyOn(opencodeClient, 'getConfig').mockResolvedValue({})
  const projects = spyOn(opencodeClient, 'listProjects').mockResolvedValue([])
  const root = createRoot(dom.container)
  stores = null
  rendered = null
  renderCount = 0
  try {
    await act(async () => root.render(
      <SyncProvider sdk={createSdk()} directory="">
        <CountsProbe includeChild={includeChild} />
      </SyncProvider>,
    ))
    await assert()
  } finally {
    await act(async () => root.unmount())
    homeInfo.mockRestore()
    home.mockRestore()
    location.mockRestore()
    config.mockRestore()
    projects.mockRestore()
    window.__OPENCHAMBER_SURFACE__ = previousSurface
    dom.restore()
  }
}

describe('useSessionBlockingRequests', () => {
  test('rolls a hidden cross-directory subagent permission up to its collapsed parent (#2247)', async () => {
    await withProbe(true, async () => {
      // An unbootstrapped store contributes nothing rather than inventing a request.
      expect(rendered).toEqual({ hasPermission: false, hasForm: false })

      await act(async () => stores!.child.setState({ permission: { child: [permission('child-permission', 'child')] } }))

      // Delivered through the permission sidecar channel rather than a
      // re-render of the whole tree.
      expect(rendered?.hasPermission).toBe(true)

      const previousRenders = renderCount
      await act(async () => stores!.child.setState({
        permission: { ...stores!.child.getState().permission, unrelated: [permission('other', 'unrelated')] },
      }))
      expect(renderCount).toBe(previousRenders)

      await act(async () => stores!.child.setState({ permission: { child: [] } }))
      expect(rendered?.hasPermission).toBe(false)
    })
  })

  test('keeps an expanded parent scoped to the parent row', async () => {
    await withProbe(false, async () => {
      await act(async () => stores!.child.setState({ permission: { child: [permission('child-permission', 'child')] } }))
      expect(rendered?.hasPermission).toBe(false)

      await act(async () => stores!.parent.setState({ permission: { parent: [permission('parent-permission', 'parent')] } }))
      expect(rendered?.hasPermission).toBe(true)
    })
  })

  test('tracks forms and permissions independently, and more of the same kind does not re-render', async () => {
    await withProbe(true, async () => {
      await act(async () => stores!.child.setState({ form: { child: [form('child-form-1', 'child')] } }))
      expect(rendered).toEqual({ hasPermission: false, hasForm: true })

      const previousRenders = renderCount
      await act(async () => stores!.child.setState({
        form: { child: [form('child-form-1', 'child'), form('child-form-2', 'child')] },
      }))
      expect(renderCount).toBe(previousRenders)
    })
  })

  test('shows a form the host seed found waiting in a directory this client never opened (#5098)', async () => {
    resetGlobalBlockingRequests()
    try {
      await withProbe(true, async () => {
        expect(rendered).toEqual({ hasPermission: false, hasForm: false })

        // The startup seed, not a live event: the unbootstrapped store stays empty.
        await act(async () => { await readHostBlockingRequestsSnapshot(async () => ({
          sessions: {},
          pending: { child: { permissions: [], forms: [{ id: 'seeded-form', sessionID: 'child', title: 'Answer' }], pages: [] } },
          serverTime: 0,
        }), () => CHILD_DIR) })
        expect(stores!.child.getState().form.child).toBeUndefined()
        expect(rendered).toEqual({ hasPermission: false, hasForm: true })

        await act(async () => applyGlobalBlockingRequestEvents(CHILD_DIR, [
          { type: 'form.settled', properties: { sessionID: 'child', formID: 'seeded-form' } },
        ]))
        expect(rendered?.hasForm).toBe(false)
      })
    } finally {
      resetGlobalBlockingRequests()
    }
  })

  test('a store whose bootstrap completed outranks a form the index still holds', async () => {
    resetGlobalBlockingRequests()
    try {
      await withProbe(true, async () => {
        // The index kept a form whose `form.settled` event was lost.
        await act(async () => { await readHostBlockingRequestsSnapshot(async () => ({
          sessions: {},
          pending: { child: { permissions: [], forms: [{ id: 'answered-form', sessionID: 'child', title: 'Answer' }], pages: [] } },
          serverTime: 0,
        }), () => CHILD_DIR) })
        expect(rendered?.hasForm).toBe(true)

        // The directory's own bootstrap read its pending forms and found none.
        await act(async () => stores!.child.setState({ status: 'complete' }))
        expect(rendered?.hasForm).toBe(false)

        // A form the complete store holds still shows.
        await act(async () => stores!.child.setState({ form: { child: [form('live-form', 'child')] } }))
        expect(rendered?.hasForm).toBe(true)
      })
    } finally {
      resetGlobalBlockingRequests()
    }
  })
})
