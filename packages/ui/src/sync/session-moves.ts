export type GlobalSessionMove = { sessionId: string; from: string; to: string }

const listeners = new Set<(move: GlobalSessionMove) => void>()

/** Moves OpenCode reports while this client listens; history and snapshots never count. */
export const subscribeGlobalSessionMoves = (listener: (move: GlobalSessionMove) => void): (() => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export const publishGlobalSessionMoves = (moves: readonly GlobalSessionMove[]): void => {
  for (const move of moves) for (const listener of listeners) listener(move)
}
