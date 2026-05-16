import { beforeEach, describe, expect, mock, test } from 'bun:test'

import { opencodeClient } from './client'

type MutableClientState = {
  client: {
    app: {
      agents: (options?: { directory?: string }) => Promise<{ data?: Array<{ name: string }> }>
    }
  }
  currentDirectory?: string
}

const clientState = opencodeClient as unknown as MutableClientState
const originalClient = clientState.client
const originalDirectory = clientState.currentDirectory
const originalFetch = globalThis.fetch

beforeEach(() => {
  clientState.client = originalClient
  clientState.currentDirectory = originalDirectory
  globalThis.fetch = originalFetch
})

describe('opencodeClient.listAgents', () => {
  test('prefers the /agent endpoint so plugin agents remain visible', async () => {
    clientState.client = {
      app: {
        agents: async () => ({
          data: [{ name: 'build' }],
        }),
      },
    }

    clientState.currentDirectory = '/workspace/project'

    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      expect(url).toBe('http://localhost/api/agent?directory=%2Fworkspace%2Fproject')

      return new Response(JSON.stringify([
        { name: 'build' },
        { name: 'sisyphus' },
      ]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch

    const agents = await opencodeClient.listAgents()

    expect(agents).toEqual([
      { name: 'build' },
      { name: 'sisyphus' },
    ])
  })
})
