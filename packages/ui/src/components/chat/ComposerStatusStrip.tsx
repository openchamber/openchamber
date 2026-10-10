import React from 'react';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';

interface ComposerStatusStripProps {
  icon: IconName;
  /** A spinning icon says the wait is active work, not a pause. */
  spin?: boolean;
  text: string;
}

/**
 * A quiet status line among the composer's top rows, for a wait the first
 * prompt depends on: a worktree running its setup commands, a message waiting
 * for its space. It says why nothing happens yet, so the wait does not look
 * stuck; it offers no action.
 */
export const ComposerStatusStrip: React.FC<ComposerStatusStripProps> = React.memo(({ icon, spin = false, text }) => (
  <div role="status" className="border-b border-border/60">
    <div className="flex h-10 items-center gap-2 pl-3 pr-3">
      <Icon name={icon} className={spin ? 'size-3.5 shrink-0 animate-spin text-muted-foreground' : 'size-3.5 shrink-0 text-muted-foreground'} aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate typography-meta text-muted-foreground">{text}</span>
    </div>
  </div>
));

ComposerStatusStrip.displayName = 'ComposerStatusStrip';
