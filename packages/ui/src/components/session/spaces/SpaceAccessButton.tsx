/**
 * The key in the session header that opens the grant dialog of the space the open session or
 * draft works in (DESIGN.md, user journey step 4), with a warning dot while that space lacks
 * access. Nothing for a host directory, while the feature is off, or in VS Code (decision 16).
 */

import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { isVSCodeRuntime } from '@/lib/desktop';
import { useI18n } from '@/lib/i18n';
import { spaceAccessNoticeOf } from '@/lib/spaces/space-access';
import { spaceIdOfDirectory } from '@/lib/spaces/space-route';
import { useSpacesStore } from '@/lib/spaces/spaces-store';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';

export const SpaceAccessButton: React.FC<{ directory: string | null | undefined; className: string; iconClassName: string }> = ({ directory, className, iconClassName }) => {
  const { t } = useI18n();
  const enabled = useUIStore((state) => state.isolatedSpacesEnabled);
  const spaceId = spaceIdOfDirectory(directory);
  const lacking = useSpacesStore((state) => {
    if (!spaceId) return false;
    if (state.creationAccess.get(spaceId)?.kind === 'failed') return true;
    const notice = spaceAccessNoticeOf(state.journey?.get(spaceId));
    return notice?.kind === 'needs_again' || notice?.kind === 'no_model';
  });
  if (!enabled || !spaceId || isVSCodeRuntime()) return null;
  const label = lacking ? t('spaces.header.accessLacking') : t('spaces.group.access.give');
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" aria-label={label} onClick={() => useSpacesStore.getState().openAccessDialog(spaceId)} className={cn('relative', className)}>
          <Icon name="key" className={iconClassName} />
          {lacking ? <span className="absolute right-1 top-1 size-2 rounded-full border border-[var(--background)] bg-[var(--status-warning)]" aria-hidden /> : null}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
};
