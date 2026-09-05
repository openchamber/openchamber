import { describe, expect, test } from 'bun:test'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { createOpencodeClient } from '@opencode-ai/sdk/v2'
import { SyncProvider, useDirectoryStore, useSessionBlockingRequestCounts } from './sync-context'
import { installHookTestDom } from '../components/session/sidebar/test-utils/testDom'

// Neither scope is the provider's current directory: bootstrap of the current
// directory would reset the buckets this test seeds.
const CURRENT_DIR = '/workspace'
const PARENT_DIR = '/repo'
const CHILD_DIR = '/worktrees/feature'

const createSdk = () => createOpencodeClient({
  baseUrl: 'https://sync.test',
  fetch: async (request) => {
    const path = new URL(request instanceof Request ? request.url : request.toString()).pathname
    if (path.endsWith('/global/event')) {
      return new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } })
    }
    const body = path.endsWith('/path')
      ? { state: '', config: '', worktree: CURRENT_DIR, directory: CURRENT_DIR, home: '/home' }
      : path.endsWith('/project') ? []
      : path.endsWith('/project/current') ? { id: 'project' }
      : path.endsWith('/session/status') ? {}
      : []
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
  },
})

type ProbeStores = {
  parent: ReturnType<typeof useDirectoryStore>
  child: ReturnType<typeof useDirectoryStore>
}

let stores: ProbeStores | null = null
let renderedCounts: { permissionCount: number; questionCount: number } | null = null

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
  renderedCounts = useSessionBlockingRequestCounts(scopes)
  return null
}

const seedPermissions = async () => {
  await act(async () => {
    stores!.parent.setState({ permission: { parent: [{ id: 'parent-permission' }] as never[] } })
    stores!.child.setState({
      permission: { child: [{ id: 'child-permission-1' }, { id: 'child-permission-2' }] as never[] },
    })
  })
}

const withProbe = async (includeChild: boolean, assert: () => Promise<void>) => {
  const dom = installHookTestDom()
  const root = createRoot(dom.container)
  stores = null
  renderedCounts = null
  try {
    await act(async () => root.render(
      <SyncProvider sdk={createSdk()} directory={CURRENT_DIR}>
        <CountsProbe includeChild={includeChild} />
      </SyncProvider>,
    ))
    await assert()
  } finally {
    await act(async () => root.unmount())
    dom.restore()
  }
}

describe('useSessionBlockingRequestCounts', () => {
  test('rolls a hidden cross-directory subagent permission up to its collapsed parent (#2247)', async () => {
    await withProbe(true, async () => {
      // An unbootstrapped store contributes zero rather than inventing a count.
      expect(renderedCounts).toEqual({ permissionCount: 0, questionCount: 0 })

      await seedPermissions()

      // 1 own + 2 hidden in another directory store, delivered through the
      // permission sidecar channel rather than a re-render of the whole tree.
      expect(renderedCounts?.permissionCount).toBe(3)
    })
  })

  test('keeps an expanded parent count scoped to the parent row', async () => {
    await withProbe(false, async () => {
      await seedPermissions()

      expect(renderedCounts?.permissionCount).toBe(1)
    })
  })

  test('counts questions and permissions independently for the same scopes', async () => {
    await withProbe(true, async () => {
      await act(async () => {
        stores!.child.setState({
          permission: { child: [{ id: 'child-permission' }] as never[] },
          question: { child: [{ id: 'child-question-1' }, { id: 'child-question-2' }] as never[] },
        })
      })

      expect(renderedCounts).toEqual({ permissionCount: 1, questionCount: 2 })
    })
  })
})
