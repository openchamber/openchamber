import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { OpenCode } from '@opencode/client'
import { opencodeClient } from '@/lib/opencode/client'
import type { Message, Session } from '@/lib/opencode/model'
import { useSessionUIStore } from '@/sync/session-ui-store'
import { SyncProvider, useDirectoryStore } from '@/sync/sync-context'
import { installHookTestDom } from '../session/sidebar/test-utils/testDom'
import { ContextUsageRingIcon } from './ContextRailUsage'

// The rail ring sits beside the transcript for the whole session, so a
// streamed step that leaves the context reading unchanged must not render it.

const CURRENT_DIR = '/workspace'
const DIR = '/repo'
const SESSION_ID = 'ses_1'

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

const session = (updated: number): Session => ({
  id: SESSION_ID,
  projectID: 'proj_1',
  directory: DIR,
  title: 'One',
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated },
  agent: 'build',
})

const assistant = (id: string, total: number): Message => ({
  id,
  sessionID: SESSION_ID,
  role: 'assistant',
  time: { created: 10 },
  agent: 'build',
  providerID: 'anthropic',
  modelID: 'claude',
  tokens: { input: total, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
})

let store: ReturnType<typeof useDirectoryStore> | null = null
let renders = 0

const StoreProbe = () => {
  store = useDirectoryStore(DIR, { bootstrap: false })
  return null
}

describe('ContextUsageRingIcon', () => {
  let dom: ReturnType<typeof installHookTestDom>
  let root: Root
  let restoreSpies: Array<() => void>
  let previousSurface: typeof window.__OPENCHAMBER_SURFACE__
  let previousSessionUI: ReturnType<typeof useSessionUIStore.getState>

  const seed = async (sessions: Session[], messages: Message[]) => {
    await act(async () => store!.setState({ session: sessions, message: { [SESSION_ID]: messages } }))
  }

  beforeEach(async () => {
    dom = installHookTestDom()
    previousSurface = window.__OPENCHAMBER_SURFACE__
    window.__OPENCHAMBER_SURFACE__ = 'desktop'
    const spies = [
      spyOn(opencodeClient, 'getFilesystemHomeInfo').mockResolvedValue({ home: '/home' }),
      spyOn(opencodeClient, 'getFilesystemHome').mockResolvedValue('/home'),
      spyOn(opencodeClient, 'getLocation').mockResolvedValue({
        directory: CURRENT_DIR,
        project: { id: 'project', directory: CURRENT_DIR, canonical: CURRENT_DIR },
      }),
      spyOn(opencodeClient, 'getConfig').mockResolvedValue({}),
      spyOn(opencodeClient, 'listProjects').mockResolvedValue([]),
    ]
    restoreSpies = spies.map((spy) => () => spy.mockRestore())
    previousSessionUI = useSessionUIStore.getState()
    useSessionUIStore.setState({ currentSessionId: SESSION_ID, currentSessionDirectory: DIR })
    root = createRoot(dom.container)
    store = null
    renders = 0
    await act(async () => root.render(
      <SyncProvider sdk={createSdk()} directory="">
        <StoreProbe />
        <React.Profiler id="ring" onRender={() => { renders += 1 }}>
          <ContextUsageRingIcon />
        </React.Profiler>
      </SyncProvider>,
    ))
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    useSessionUIStore.setState({
      currentSessionId: previousSessionUI.currentSessionId,
      currentSessionDirectory: previousSessionUI.currentSessionDirectory,
    })
    restoreSpies.forEach((restore) => restore())
    window.__OPENCHAMBER_SURFACE__ = previousSurface
    dom.restore()
  })

  test('streamed steps with the same reading do not render the ring', async () => {
    await seed([session(1)], [assistant('msg_1', 50_000)])
    const settled = renders
    expect(settled).toBeGreaterThan(0)

    for (let step = 2; step < 12; step += 1) {
      await seed([session(step)], [assistant('msg_1', 50_000)])
    }

    expect(renders).toBe(settled)
  })

  test('a new reading and a cleared session still render it', async () => {
    await seed([session(1)], [assistant('msg_1', 50_000)])
    const measured = renders

    await seed([session(2)], [assistant('msg_1', 50_000), assistant('msg_2', 100_000)])
    expect(renders).toBe(measured + 1)

    await seed([session(3)], [])
    expect(renders).toBe(measured + 2)
  })
})
