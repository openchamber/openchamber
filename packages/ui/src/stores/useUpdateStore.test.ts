import { beforeEach, describe, expect, mock, test } from 'bun:test'

let restartAttempts = 0
let restartOutcome: 'pending' | 'reject' | 'success' = 'pending'

const desktop = await import('@/lib/desktop')
// restartToApplyUpdate is the seam for the real quitAndInstall() flow; Squirrel
// accepts one install per app session, so the store must not invoke it twice.
mock.module('@/lib/desktop', () => ({
  ...desktop,
  isVSCodeRuntime: () => false,
  isWebRuntime: () => false,
  isElectronShell: () => true,
  isDesktopLocalOriginActive: () => true,
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

const { useUpdateStore } = await import('./useUpdateStore')
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
