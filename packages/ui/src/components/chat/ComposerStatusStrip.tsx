import React from 'react';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { useComposerStatusChip, type ComposerStatusRowId } from '@/components/chat/composer/state/composerStatusChips';
import { Spinner } from '@/components/ui/spinner';

interface ComposerStatusStripProps {
  /** Its place in the phone's chip line. */
  chipId: ComposerStatusRowId;
  icon: IconName;
  /** A spinner says the wait is active work, not a pause. */
  spin?: boolean;
  text: string;
  /** The shorter label its phone chip shows. */
  chipLabel: string;
}

/**
 * A quiet status line among the composer's top rows, for a wait the first
 * prompt depends on: a worktree running its setup commands, a message waiting
 * for its space. It says why nothing happens yet, so the wait does not look
 * stuck; it offers no action.
 */
export const ComposerStatusStrip: React.FC<ComposerStatusStripProps> = React.memo(({ chipId, icon, spin = false, text, chipLabel }) => {
  useComposerStatusChip(chipId, { icon, label: chipLabel, spin });
  return (
    <div role="status" className="border-b border-edge">
      <div className="flex oc-composer-row items-center gap-2 ps-3 pe-3">
        {spin
          ? <Spinner className="size-3.5 text-muted-foreground" aria-hidden="true" />
          : <Icon name={icon} className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />}
        <span className="min-w-0 flex-1 truncate typography-meta text-muted-foreground">{text}</span>
      </div>
    </div>
  );
});

ComposerStatusStrip.displayName = 'ComposerStatusStrip';
