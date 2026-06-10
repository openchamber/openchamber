type SessionOpener = (sessionID: string, directory: string) => void

let sessionOpener: SessionOpener | null = null

export const setSessionOpener = (opener: SessionOpener | null) => {
  sessionOpener = opener
}

export const openSessionFromToast = (sessionID: string, directory: string) => {
  sessionOpener?.(sessionID, directory)
}
