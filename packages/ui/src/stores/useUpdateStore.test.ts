import { beforeEach, describe, expect, mock, test } from 'bun:test'
import type { UpdateInfo } from '@/lib/desktop'

let restartAttempts = 0
let restartOutcome: 'pending' | 'reject' | 'success' = 'pending'
let desktopCheckResult: UpdateInfo | null = null
let desktopCheckError: Error | null = null
let downloadHandler: () => Promise<boolean> = async () => true
let idleQueueResult: 'waiting' | 'unavailable' | 'failure' = 'waiting'

mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: async () => new Response(JSON.stringify({ nextSuggestedCheckInSec: 3600 })),
}))

const desktop = await import('@/lib/desktop')
// restartToApplyUpdate is the seam for the real quitAndInstall() flow; Squirrel
// accepts one install per app session, so the store must not invoke it twice.
mock.module('@/lib/desktop', () => ({
  ...desktop,
  isVSCodeRuntime: () => false,
  isWebRuntime: () => false,
  isElectronShell: () => true,
  isDesktopLocalOriginActive: () => true,
  hasDesktopInvoke: () => true,
  invokeDesktop: async (command: string) => {
    if (command !== 'desktop_queue_idle_update') return null
    if (idleQueueResult === 'failure') throw new Error('The command is disabled and cannot be executed')
    if (idleQueueResult === 'unavailable') return null
    return { phase: 'waiting', reason: null, remainingMs: 0, version: '2.0.0', channel: 'stable' }
  },
  checkForDesktopUpdates: () => desktopCheckError ? Promise.reject(desktopCheckError) : Promise.resolve(desktopCheckResult),
  downloadDesktopUpdate: () => downloadHandler(),
  restartToApplyUpdate: () => {
    restartAttempts += 1
    if (restartOutcome === 'pending') {
      return new Promise<boolean>(() => {})
    }
    if (restartOutcome === 'reject') {
      return Promise.reject(new Error('The command is disabled and cannot be executed'))
    }
    return Promise.resolve(true)
  },
}))

const { parseUpdateCheckResponse, useUpdateStore } = await import('./useUpdateStore')
const { getUpdateInstallErrorMessage } = await import('@/lib/updateInstallError')
const { getUpdateCheckErrorMessage } = await import('@/lib/updateCheckError')

const updaterDisabledError = () => getUpdateInstallErrorMessage(new Error('The command is disabled and cannot be executed'))

describe('useUpdateStore restartToUpdate', () => {
  beforeEach(() => {
    restartAttempts = 0
    restartOutcome = 'pending'
    useUpdateStore.setState({
      checking: false,
      available: true,
      downloading: false,
      downloaded: true,
      installing: false,
      idlePhase: 'idle',
      idleReason: null,
      idleRemainingMs: 0,
      info: null,
      progress: null,
      error: null,
      runtimeType: 'desktop',
      lastChecked: null,
      nextCheckInSec: null,
    })
  })

  test('a second click while the restart is in flight does not touch the updater again', async () => {
    void useUpdateStore.getState().restartToUpdate()
    await useUpdateStore.getState().restartToUpdate()

    expect(restartAttempts).toBe(1)
    expect(useUpdateStore.getState().installing).toBe(true)
    expect(useUpdateStore.getState().error).toBeNull()
  })

  test('a failed install re-enables the restart button and surfaces the installer error', async () => {
    restartOutcome = 'reject'

    await useUpdateStore.getState().restartToUpdate()

    expect(useUpdateStore.getState().installing).toBe(false)
    expect(useUpdateStore.getState().error).toBe(updaterDisabledError())

    // The retry path from #3204 stays intact: after the failure the button is
    // clickable and invoking it again reaches the updater once more.
    restartOutcome = 'success'
    await useUpdateStore.getState().restartToUpdate()

    expect(restartAttempts).toBe(2)
    expect(useUpdateStore.getState().error).toBeNull()
  })

  test('a successful restart keeps the restarting state until the app quits', async () => {
    restartOutcome = 'success'

    await useUpdateStore.getState().restartToUpdate()

    expect(useUpdateStore.getState().installing).toBe(true)
    expect(useUpdateStore.getState().error).toBeNull()
  })

  test('dismiss clears the restarting state', async () => {
    restartOutcome = 'success'
    await useUpdateStore.getState().restartToUpdate()
    useUpdateStore.getState().dismiss()

    expect(useUpdateStore.getState().installing).toBe(false)
    expect(useUpdateStore.getState().downloaded).toBe(false)
  })
})

describe('useUpdateStore idle install', () => {
  test('queues in the background only after a successful desktop response', async () => {
    useUpdateStore.setState({ downloaded: true, installing: false, runtimeType: 'desktop', idlePhase: 'idle', error: null })
    idleQueueResult = 'waiting'
    expect(await useUpdateStore.getState().queueIdleInstall()).toBe(true)
    expect(useUpdateStore.getState().idlePhase).toBe('waiting')

    useUpdateStore.setState({ idlePhase: 'idle' })
    idleQueueResult = 'failure'
    expect(await useUpdateStore.getState().queueIdleInstall()).toBe(false)
    expect(useUpdateStore.getState().error).toBe(updaterDisabledError())

    idleQueueResult = 'unavailable'
    expect(await useUpdateStore.getState().queueIdleInstall()).toBe(false)
    expect(useUpdateStore.getState().idlePhase).toBe('idle')
    idleQueueResult = 'waiting'
  })

  test('native waiting state remains cancellable after renderer reload and a failed feed check', async () => {
    useUpdateStore.setState({
      runtimeType: null,
      available: false,
      downloaded: false,
      info: null,
      idlePhase: 'idle',
      idleReason: null,
    })
    useUpdateStore.getState().applyIdleUpdate({
      phase: 'waiting',
      reason: 'session',
      remainingMs: 0,
      version: '2.0.0',
      channel: 'stable',
    })
    expect(useUpdateStore.getState()).toMatchObject({ runtimeType: 'desktop', idlePhase: 'waiting', downloaded: false })

    desktopCheckError = new Error('Update feed unavailable')
    await useUpdateStore.getState().checkForUpdates()
    expect(useUpdateStore.getState()).toMatchObject({ runtimeType: 'desktop', idlePhase: 'waiting', available: false })
    desktopCheckError = null
  })

  test('a failed install leaves the download available', () => {
    useUpdateStore.setState({ downloaded: true, installing: true, runtimeType: 'desktop' })
    useUpdateStore.getState().applyIdleUpdate({
      phase: 'idle',
      reason: 'install-failed',
      remainingMs: 0,
      version: null,
      channel: null,
    })

    expect(useUpdateStore.getState().installing).toBe(false)
    expect(useUpdateStore.getState().idlePhase).toBe('idle')
    expect(useUpdateStore.getState().idleReason).toBe('install-failed')
    expect(useUpdateStore.getState().downloaded).toBe(true)
  })
})

describe('parseUpdateCheckResponse', () => {
  test('keeps the reasons the server cannot install an update and drops unknown ones', () => {
    expect(parseUpdateCheckResponse({ available: true, installBlocked: 'manual-install' }).installBlocked).toBe('manual-install')
    expect(parseUpdateCheckResponse({ available: true, installBlocked: 'service-manager' }).installBlocked).toBe('service-manager')
    expect(parseUpdateCheckResponse({ available: true, installBlocked: 'desktop-host' }).installBlocked).toBe('desktop-host')
    expect(parseUpdateCheckResponse({ available: true, installBlocked: 'something-else' }).installBlocked).toBeUndefined()
  })

  test('keeps an OpenCode block only with both versions it names', () => {
    expect(parseUpdateCheckResponse({
      available: true,
      installBlocked: 'opencode-version',
      requiredOpenCodeVersion: '2.3.0',
      openCodeVersion: '2.2.6',
    })).toMatchObject({ installBlocked: 'opencode-version', requiredOpenCodeVersion: '2.3.0', openCodeVersion: '2.2.6' })
    expect(parseUpdateCheckResponse({ available: true, installBlocked: 'opencode-version', openCodeVersion: '2.2.6' }))
      .toMatchObject({ installBlocked: undefined, requiredOpenCodeVersion: undefined, openCodeVersion: undefined })
  })
})

describe('useUpdateStore checkForUpdates', () => {
  const downloadedState = {
    checking: false,
    available: true,
    downloading: false,
    downloaded: true,
    installing: false,
    info: { available: true, currentVersion: '1.0.0', version: '2.0.0' },
    progress: { downloaded: 10, total: 20 },
    error: null,
    runtimeType: 'desktop' as const,
    lastChecked: null,
    nextCheckInSec: null,
  }

  beforeEach(() => {
    desktopCheckError = null
    downloadHandler = async () => true
    desktopCheckResult = { available: true, currentVersion: '1.0.0', version: '2.0.0' }
    useUpdateStore.setState({ ...downloadedState })
  })

  test('a different offered version drops the downloaded payload', async () => {
    desktopCheckResult = { available: true, currentVersion: '1.0.0', version: '2.1.0' }

    await useUpdateStore.getState().checkForUpdates()

    expect(useUpdateStore.getState().downloaded).toBe(false)
    expect(useUpdateStore.getState().downloading).toBe(false)
    expect(useUpdateStore.getState().progress).toBeNull()
  })

  test('the same offered version keeps the downloaded payload', async () => {
    await useUpdateStore.getState().checkForUpdates()

    expect(useUpdateStore.getState().downloaded).toBe(true)
  })

  test('a fresh renderer picks up an already downloaded update', async () => {
    useUpdateStore.setState({ downloaded: false, info: null })
    desktopCheckResult = { available: true, downloaded: true, currentVersion: '1.0.0', version: '2.0.0' }
    await useUpdateStore.getState().checkForUpdates()
    expect(useUpdateStore.getState().downloaded).toBe(true)
  })

  test('an authoritative no-update clears payload state', async () => {
    desktopCheckResult = { available: false, currentVersion: '1.0.0' }
    await useUpdateStore.getState().checkForUpdates()
    expect(useUpdateStore.getState().downloaded).toBe(false)
    expect(useUpdateStore.getState().downloading).toBe(false)
    expect(useUpdateStore.getState().progress).toBeNull()
  })

  test('a failed feed check preserves the ready payload and reports the error', async () => {
    desktopCheckError = new Error('Unable to check for updates (ENOTFOUND)')
    await useUpdateStore.getState().checkForUpdates()
    expect(useUpdateStore.getState().downloaded).toBe(true)
    expect(useUpdateStore.getState().info?.version).toBe('2.0.0')
    expect(useUpdateStore.getState().error).toBe(getUpdateCheckErrorMessage(desktopCheckError))
    expect(useUpdateStore.getState().error).not.toContain('ENOTFOUND')
  })

  test('a missing bridge result preserves the ready payload', async () => {
    desktopCheckResult = null
    await useUpdateStore.getState().checkForUpdates()
    expect(useUpdateStore.getState().downloaded).toBe(true)
    expect(useUpdateStore.getState().info?.version).toBe('2.0.0')
    expect(useUpdateStore.getState().error).not.toBeNull()
  })

  test('a no-update check keeps an active download locked until it finishes', async () => {
    let finish!: (value: boolean) => void
    let started!: () => void
    const downloading = new Promise<void>((resolve) => { started = resolve })
    downloadHandler = () => {
      started()
      return new Promise<boolean>((resolve) => { finish = resolve })
    }
    useUpdateStore.setState({ downloaded: false })
    const download = useUpdateStore.getState().downloadUpdate()
    await downloading
    desktopCheckResult = { available: false, currentVersion: '1.0.0' }
    await useUpdateStore.getState().checkForUpdates()
    expect(useUpdateStore.getState().downloading).toBe(true)
    expect(useUpdateStore.getState().downloaded).toBe(false)
    finish(true)
    await download
    expect(useUpdateStore.getState().downloading).toBe(false)
    expect(useUpdateStore.getState().downloaded).toBe(false)
  })

  test('download A, check B, finish A keeps B unready and blocks duplicate downloads', async () => {
    let finish!: (value: boolean) => void
    let started!: () => void
    const downloading = new Promise<void>((resolve) => { started = resolve })
    let calls = 0
    downloadHandler = () => {
      calls += 1
      started()
      return new Promise<boolean>((resolve) => { finish = resolve })
    }
    useUpdateStore.setState({ downloaded: false })
    const download = useUpdateStore.getState().downloadUpdate()
    await downloading
    desktopCheckResult = { available: true, currentVersion: '1.0.0', version: '2.1.0' }
    await useUpdateStore.getState().checkForUpdates()
    expect(useUpdateStore.getState().downloading).toBe(true)
    await useUpdateStore.getState().downloadUpdate()
    expect(calls).toBe(1)
    finish(true)
    await download
    expect(useUpdateStore.getState().info?.version).toBe('2.1.0')
    expect(useUpdateStore.getState().downloaded).toBe(false)
    expect(useUpdateStore.getState().downloading).toBe(false)
    expect(useUpdateStore.getState().progress).toBeNull()
  })

  test('finishing A in one renderer cannot enable restart for B in another renderer', async () => {
    restartAttempts = 0
    const secondRendererModule = './useUpdateStore.ts?second-renderer'
    const { useUpdateStore: secondRenderer }: typeof import('./useUpdateStore') = await import(secondRendererModule)
    expect(secondRenderer).not.toBe(useUpdateStore)
    const updaterModule = '../../../electron/updater-check.mjs'
    const { downloadPendingDesktopUpdate } = await import(updaterModule)
    const state = { pendingUpdate: { version: '2.0.0', electronUpdate: {} }, updateDownloadPromise: null }
    let finish!: (files: string[]) => void
    let started!: () => void
    const downloading = new Promise<void>((resolve) => { started = resolve })
    let secondStarted!: () => void
    const secondDownloading = new Promise<void>((resolve) => { secondStarted = resolve })
    let downloadCalls = 0
    const autoUpdater = {
      downloadUpdate: () => {
        started()
        return new Promise<string[]>((resolve) => { finish = resolve })
      },
    }
    downloadHandler = async () => {
      const download = downloadPendingDesktopUpdate({ autoUpdater, state })
      if (++downloadCalls === 2) secondStarted()
      await download
      return true
    }
    useUpdateStore.setState({ downloaded: false })
    const firstDownload = useUpdateStore.getState().downloadUpdate()
    await downloading
    state.pendingUpdate = { version: '2.1.0', electronUpdate: {} }
    desktopCheckResult = { available: true, currentVersion: '1.0.0', version: '2.1.0' }
    secondRenderer.setState({ ...downloadedState, downloaded: false, info: desktopCheckResult })
    const secondDownload = secondRenderer.getState().downloadUpdate()
    await secondDownloading
    finish(['/cache/A'])
    await Promise.all([firstDownload, secondDownload])
    expect(useUpdateStore.getState().downloaded).toBe(true)
    expect(secondRenderer.getState().info?.version).toBe('2.1.0')
    expect(secondRenderer.getState().downloaded).toBe(false)
    expect(secondRenderer.getState().error).toContain('already in progress')
    await secondRenderer.getState().restartToUpdate()
    expect(restartAttempts).toBe(0)
  })
})
