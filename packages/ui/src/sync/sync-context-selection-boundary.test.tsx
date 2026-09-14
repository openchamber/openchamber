import { describe, expect, test } from 'bun:test'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { createOpencodeClient } from '@opencode-ai/sdk/v2'
import { SyncProvider, useSessionDisplayStatus, useSessionKnownInactive, useSyncDirectory } from './sync-context'
import { usePrefetchSessionMessages } from './use-sync'
import { installHookTestDom } from '../components/session/sidebar/test-utils/testDom'
import {
  applyGlobalSessionStatusEvent,
  applyGlobalSessionStatusSnapshot,
  markDirectoryStatusUnavailable,
  resetGlobalSessionStatus,
} from './global-session-status'

const createSdk = () => createOpencodeClient({
  baseUrl: 'https://sync.test',
  fetch: async (request) => {
    const path = new URL(request instanceof Request ? request.url : request.toString()).pathname
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

  test('keeps control freshness stable across equivalent Windows directory spellings', async () => {
    const dom = installHookTestDom()
    const root = createRoot(dom.container)
    let knownInactive: boolean | undefined
    const Probe = ({ directory }: { directory: string }) => {
      knownInactive = useSessionKnownInactive('session-a', directory)
      return null
    }

    resetGlobalSessionStatus()
    markDirectoryStatusUnavailable('C:/Repo')

    try {
      await act(async () => root.render(<Probe directory={'c:\\Repo\\'} />))
      expect(knownInactive).toBe(false)

      await act(async () => root.render(<Probe directory="C:/Repo" />))
      expect(knownInactive).toBe(false)
    } finally {
      await act(async () => root.unmount())
      resetGlobalSessionStatus()
      dom.restore()
    }
  })

  test('presents a preserved busy status as reconnecting while its directory is unavailable', async () => {
    const dom = installHookTestDom()
    const root = createRoot(dom.container)
    let display: ReturnType<typeof useSessionDisplayStatus> | undefined
    const Probe = ({ directory }: { directory: string }) => {
      display = useSessionDisplayStatus('session-a', directory)
      return null
    }

    resetGlobalSessionStatus()

    try {
      await act(async () => root.render(<Probe directory="/repo" />))
      expect(display?.type).toBe('idle')

      await act(async () => {
        // SAFETY: This fixture provides the event fields the global status reducer reads.
        applyGlobalSessionStatusEvent('/repo', {
          type: 'session.status',
          properties: { sessionID: 'session-a', status: { type: 'busy' } },
        } as never)
      })
      expect(display?.type).toBe('busy')

      // Transient unavailability: preserved busy must not stay a confirmed spinner.
      await act(async () => {
        markDirectoryStatusUnavailable('/repo')
      })
      expect(display?.type).toBe('reconnecting')
      expect(display?.rawStatus?.type).toBe('busy')

      // A fresh authoritative empty snapshot settles the session to idle.
      await act(async () => {
        applyGlobalSessionStatusSnapshot('/repo', {}, ['session-a'])
      })
      expect(display?.type).toBe('idle')
    } finally {
      await act(async () => root.unmount())
      resetGlobalSessionStatus()
      dom.restore()
    }
  })
})
