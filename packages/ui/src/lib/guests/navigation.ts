import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { isVSCodeRuntime } from '@/lib/desktop';
import { isMiniChatWindow } from '@/lib/miniChatWindow';

import { openGuestCommit, readCurrentBranch } from './open-commit';
import { openGuestWalkthrough, readWalkthroughRepository } from './open-walkthrough';

export const guestNavigationEffects = (frameDirectory: () => string | null) => ({
  openCommit: (sha: string) => {
    const git = getRegisteredRuntimeAPIs()?.git ?? null;
    return openGuestCommit({
      sha,
      directory: frameDirectory(),
      git,
      currentBranch: (dir) => (git ? readCurrentBranch(git, dir) : Promise.resolve(null)),
      supported: !isVSCodeRuntime(),
    });
  },
  openWalkthrough: (base: string) => {
    const apis = getRegisteredRuntimeAPIs();
    const git = apis?.git;
    const sourceControl = apis?.sourceControl;
    return openGuestWalkthrough({
      base,
      directory: frameDirectory(),
      readRepository: git && sourceControl ? (dir) => readWalkthroughRepository(git, sourceControl, dir) : null,
      supported: !isVSCodeRuntime() && !isMiniChatWindow(),
    });
  },
});
