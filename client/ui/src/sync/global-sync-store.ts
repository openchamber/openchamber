import { create } from "zustand"
import type { GlobalState } from "./types"
import { INITIAL_GLOBAL_STATE } from "./types"

export type GlobalSyncStore = GlobalState & {
  actions: {
    set: (patch: Partial<GlobalState>) => void
    reset: () => void
  }
}

export const useGlobalSyncStore = create<GlobalSyncStore>()((set) => ({
  ...INITIAL_GLOBAL_STATE,
  actions: {
    set: (patch) => set(patch),
    reset: () => set(INITIAL_GLOBAL_STATE),
  },
}))
