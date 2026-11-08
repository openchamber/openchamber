import { beforeEach, describe, expect, mock, test } from 'bun:test'
import type { UpdateInfo } from '@/lib/desktop'

let restartAttempts = 0
let restartOutcome: 'pending' | 'reject' | 'success' = 'pending'
let desktopCheckResult: UpdateInfo | null = null
let desktopCheckError: Error | null = null
let downloadHandler: () => Promise<boolean> = async () => true

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

describe('parseUpdateCheckResponse', () => {
  test('keeps the reasons the server cannot install an update and drops unknown ones', () => {
    expect(parseUpdateCheckResponse({ available: true, installBlocked: 'manual-install' }).installBlocked).toBe('manual-install')
    expect(parseUpdateCheckResponse({ available: true, installBlocked: 'service-manager' }).installBlocked).toBe('service-manager')
    expect(parseUpdateCheckResponse({ available: true, installBlocked: 'desktop-host' }).installBlocked).toBe('desktop-host')
    expect(parseUpdateCheckResponse({ available: true, installBlocked: 'something-else' }).installBlocked).toBeUndefined()
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

  test('an authoritative no-update clears payload state', async () => {
    desktopCheckResult = { available: false, currentVersion: '1.0.0' }
    await useUpdateStore.getState().checkForUpdates()
    expect(useUpdateStore.getState().downloaded).toBe(false)
    expect(useUpdateStore.getState().downloading).toBe(false)
    expect(useUpdateStore.getState().progress).toBeNull()
  })

  test('a failed feed check preserves the ready payload and reports the error', async () => {
    desktopCheckError = new Error('Unable to check for updates: ENOTFOUND')
    await useUpdateStore.getState().checkForUpdates()
    expect(useUpdateStore.getState().downloaded).toBe(true)
    expect(useUpdateStore.getState().info?.version).toBe('2.0.0')
    expect(useUpdateStore.getState().error).toBe(desktopCheckError.message)
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
