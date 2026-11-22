import React from 'react';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { Spinner } from '@/components/ui/spinner';

interface ComposerStatusStripProps {
  icon: IconName;
  spin?: boolean;
  text: string;
}

export const ComposerStatusStrip: React.FC<ComposerStatusStripProps> = React.memo(({ icon, spin = false, text }) => {
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
