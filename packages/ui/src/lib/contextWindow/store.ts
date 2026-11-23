import { create } from 'zustand';

type ContextWindowState = {
  detached: boolean;
  followedDirectory: string | null;
};

export const useContextWindowStore = create<ContextWindowState>(() => ({
  detached: false,
  followedDirectory: null,
}));
