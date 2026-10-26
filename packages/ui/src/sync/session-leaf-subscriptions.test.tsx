import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { OpenCode } from '@opencode/client'
import { opencodeClient } from '@/lib/opencode/client'
import type { Message, Session } from '@/lib/opencode/model'
import {
  areModelChoicesEqual,
  extractSessionRecordModelChoice,
  type UserModelChoice,
} from '@/lib/messages/userModelChoice'
import { buildSessionContextUsage, isSameContextUsage } from '@/stores/utils/tokenUtils'
import type { SessionContextUsage } from '@/stores/types/sessionTypes'
import {
  SyncProvider,
  useDirectoryStore,
  useLiveSessionsExcluding,
  useSessionDirectory,
  useSessionMessagesSelector,
  useSessionSelector,
} from './sync-context'
import { installHookTestDom } from '../components/session/sidebar/test-utils/testDom'

// The leaf subscriptions the header, the composer's model controls and the
// sidebar collection read through. A streamed step replaces the session record
// (`time.updated`) and the message list many times while what those surfaces
// show stays the same; each probe counts its renders across that churn.

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

const session = (overrides: Partial<Session> = {}): Session => ({
  id: SESSION_ID,
  projectID: 'proj_1',
  directory: DIR,
  title: 'One',
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 },
  model: { providerID: 'anthropic', id: 'claude', variant: 'high' },
  agent: 'build',
  ...overrides,
})

const assistant = (id: string, total: number, overrides: Partial<Extract<Message, { role: 'assistant' }>> = {}): Message => ({
  id,
  sessionID: SESSION_ID,
  role: 'assistant',
  time: { created: 10 },
  agent: 'build',
  providerID: 'anthropic',
  modelID: 'claude',
  tokens: { input: total, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  ...overrides,
})

const selectRecordAgent = (record: Session | undefined) => record?.agent

type Readings = {
  directory: string | undefined
  agent: string | undefined
  recordChoice: UserModelChoice | null
  contextUsage: SessionContextUsage | null
  liveGap: Session[]
}

let store: ReturnType<typeof useDirectoryStore> | null = null
let readings: Readings | null = null
let renders = 0

const Probe = ({ excludedIds }: { excludedIds: ReadonlySet<string> }) => {
  store = useDirectoryStore(DIR, { bootstrap: false })
  const directory = useSessionDirectory(SESSION_ID, DIR)
  const agent = useSessionSelector(SESSION_ID, DIR, selectRecordAgent)
  const recordChoice = useSessionSelector(SESSION_ID, DIR, extractSessionRecordModelChoice, areModelChoicesEqual)
  const selectUsage = React.useCallback((messages: Message[]) => buildSessionContextUsage(messages, 200_000, 32_000), [])
  const contextUsage = useSessionMessagesSelector(SESSION_ID, DIR, selectUsage, isSameContextUsage)
  const liveGap = useLiveSessionsExcluding(excludedIds)
  readings = { directory, agent, recordChoice, contextUsage, liveGap }
  renders += 1
  return null
}

describe('session leaf subscriptions', () => {
  let dom: ReturnType<typeof installHookTestDom>
  let root: Root
  let restoreSpies: Array<() => void>
  let previousSurface: typeof window.__OPENCHAMBER_SURFACE__

  const render = async (excludedIds: ReadonlySet<string>) => {
    await act(async () => root.render(
      <SyncProvider sdk={createSdk()} directory="">
        <Probe excludedIds={excludedIds} />
      </SyncProvider>,
    ))
  }

  const seed = async (sessions: Session[], messages: Message[]) => {
    await act(async () => store!.setState({ session: sessions, message: { [SESSION_ID]: messages } }))
  }

  beforeEach(() => {
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
    root = createRoot(dom.container)
    store = null
    readings = null
    renders = 0
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    restoreSpies.forEach((restore) => restore())
    window.__OPENCHAMBER_SURFACE__ = previousSurface
    dom.restore()
  })

  test('a time-only session update and a re-sent message list do not re-render', async () => {
    const excluded = new Set([SESSION_ID])
    await render(excluded)
    await seed([session()], [assistant('msg_1', 50_000)])

    expect(readings?.directory).toBe(DIR)
    expect(readings?.agent).toBe('build')
    expect(readings?.recordChoice).toEqual({
      id: `session:${SESSION_ID}`,
      agent: undefined,
      providerID: 'anthropic',
      modelID: 'claude',
      variant: 'high',
    })
    expect(readings?.contextUsage).toMatchObject({ state: 'measured', totalTokens: 50_000, percentage: 25 })
    expect(readings?.liveGap).toEqual([])

    const settled = renders
    const choice = readings?.recordChoice
    const usage = readings?.contextUsage
    for (let step = 2; step < 12; step += 1) {
      // What a streamed step publishes: a new record with a newer
      // `time.updated`, and a new message list with the same token reading.
      await seed([session({ time: { created: 1, updated: step } })], [assistant('msg_1', 50_000, { time: { created: 10, streamed: step } })])
    }

    expect(renders).toBe(settled)
    expect(readings?.recordChoice).toBe(choice)
    expect(readings?.contextUsage).toBe(usage)
  })

  test('each rendered value still follows a real change', async () => {
    await render(new Set([SESSION_ID]))
    await seed([session()], [assistant('msg_1', 50_000)])

    await seed([session({ model: { providerID: 'openai', id: 'gpt', variant: 'high' } })], [assistant('msg_1', 50_000)])
    expect(readings?.recordChoice?.providerID).toBe('openai')
    expect(readings?.recordChoice?.modelID).toBe('gpt')

    await seed([session({ model: { providerID: 'openai', id: 'gpt', variant: 'low' }, agent: 'plan' })], [assistant('msg_1', 50_000)])
    expect(readings?.recordChoice?.variant).toBe('low')
    expect(readings?.agent).toBe('plan')

    await seed([session({ directory: '/repo/worktree', agent: 'plan', model: { providerID: 'openai', id: 'gpt', variant: 'low' } })], [assistant('msg_1', 50_000)])
    expect(readings?.directory).toBe('/repo/worktree')

    await seed([session({ directory: '/repo/worktree' })], [assistant('msg_1', 50_000), assistant('msg_2', 100_000)])
    expect(readings?.contextUsage).toMatchObject({ state: 'measured', totalTokens: 100_000, percentage: 50, lastMessageId: 'msg_2' })

    await seed([session({ directory: '/repo/worktree', model: undefined })], [])
    expect(readings?.recordChoice).toBeNull()
    expect(readings?.contextUsage).toBeNull()
  })

  test('live sessions the caller excludes do not re-render it; the rest still do', async () => {
    const gapSession = session({ id: 'ses_gap', title: 'Gap', time: { created: 1, updated: 1 } })
    await render(new Set([SESSION_ID]))
    await seed([session(), gapSession], [])
    expect(readings?.liveGap.map((entry) => entry.id)).toEqual(['ses_gap'])

    const settled = renders
    const gap = readings?.liveGap
    for (let step = 2; step < 8; step += 1) {
      await seed([session({ time: { created: 1, updated: step } }), gapSession], [])
    }
    expect(renders).toBe(settled)
    expect(readings?.liveGap).toBe(gap)

    await seed([session({ time: { created: 1, updated: 9 } }), { ...gapSession, title: 'Renamed' }], [])
    expect(readings?.liveGap.map((entry) => entry.title)).toEqual(['Renamed'])

    // Once the global cache holds the session, it leaves the gap.
    await render(new Set([SESSION_ID, 'ses_gap']))
    expect(readings?.liveGap).toEqual([])
  })
})
