/**
 * Settings → Git: the folder new worktrees go in, which is OpenCode's
 * `worktree.directory` key rather than an OpenChamber one.
 *
 * The read is scoped to the current project, because OpenCode resolves project
 * config against the repository's primary checkout and a value set in a project
 * config is the usual case. A write goes to the config file the read named, so
 * the control cannot silently land somewhere the value would not win.
 */

import { create } from 'zustand';

import { opencodeClient } from '@/lib/opencode/client';
import {
  readWorktreeDirectory,
  saveWorktreeDirectory,
  type WorktreeDirectoryConfig,
} from '@/lib/opencode/worktree';
import { reportSettingsSaveState } from '@/lib/persistence';
import { getRuntimeKey } from '@/lib/runtime-switch';

export type WorktreeDirectorySnapshot = WorktreeDirectoryConfig & {
  scope: string;
};

interface WorktreeDirectoryStore {
  state:
    | { kind: 'idle' }
    | { kind: 'loading'; scope: string }
    | { kind: 'ready'; snapshot: WorktreeDirectorySnapshot }
    | { kind: 'failed'; scope: string };
  load: () => Promise<void>;
  save: (directory: string | null) => Promise<boolean>;
}

const currentDirectory = (): string | null => opencodeClient.getDirectory()?.trim() || null;

const getScopeKey = (): string => JSON.stringify([getRuntimeKey(), currentDirectory()]);

export const useWorktreeDirectoryStore = create<WorktreeDirectoryStore>()((set, get) => ({
  state: { kind: 'idle' },

  load: async () => {
    const scope = getScopeKey();
    const previous = get().state;
    if (previous.kind !== 'ready' || previous.snapshot.scope !== scope) {
      set({ state: { kind: 'loading', scope } });
    }

    try {
      const config = await readWorktreeDirectory(currentDirectory());
      if (getScopeKey() !== scope) return;
      set({ state: { kind: 'ready', snapshot: { ...config, scope } } });
    } catch (error) {
      console.warn('[worktree] failed to read the worktree directory', error);
      if (getScopeKey() !== scope) return;
      const current = get().state;
      // A failed read never replaces a good snapshot with an empty one; the
      // folder the git service would use is unknown here, not "unset".
      if (current.kind === 'ready' && current.snapshot.scope === scope) return;
      set({ state: { kind: 'failed', scope } });
    }
  },

  save: async (directory) => {
    const current = get().state;
    if (current.kind !== 'ready') return false;

    reportSettingsSaveState('saving');
    try {
      await saveWorktreeDirectory(directory, currentDirectory());
    } catch (error) {
      console.warn('[worktree] failed to save the worktree directory', error);
      reportSettingsSaveState('error');
      return false;
    }

    reportSettingsSaveState('saved');
    // OpenCode reads its config fresh on the next request; drop the copy cached
    // for the page's read.
    opencodeClient.clearConfigCache();
    await get().load();
    return true;
  },
}));
