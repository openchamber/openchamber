/**
 * The button in the desktop session header that opens the apply dialog of the space the open
 * session works in (DESIGN.md, user journey step 6): the person looks at the chat when the agent
 * is done, not at the sidebar. The phone reaches the same dialog from the group's sheet. Nothing
 * for a host directory, while the feature is off, or in VS Code (decision 16).
 */

import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { isVSCodeRuntime } from '@/lib/desktop';
import { useI18n } from '@/lib/i18n';
import { isSpaceApplicable } from '@/lib/spaces/space-repair';
import { spaceIdOfDirectory } from '@/lib/spaces/space-route';
import { useSpacesStore } from '@/lib/spaces/spaces-store';
import { useUIStore } from '@/stores/useUIStore';

export const SpaceApplyButton: React.FC<{ directory: string | null | undefined; className: string; iconClassName: string }> = ({ directory, className, iconClassName }) => {
  const { t } = useI18n();
  const enabled = useUIStore((state) => state.isolatedSpacesEnabled);
  const spaceId = spaceIdOfDirectory(directory);
  const applicable = useSpacesStore((state) => isSpaceApplicable(spaceId ? state.journey?.get(spaceId) : undefined));
  // As the group's menu: nothing new starts while another action on the space runs.
  const busy = useSpacesStore((state) => (spaceId ? state.actions.get(spaceId)?.kind === 'running' : false));
  if (!enabled || !spaceId || !applicable || isVSCodeRuntime()) return null;
  const label = t('spaces.header.apply');
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" aria-label={label} disabled={busy} onClick={() => useSpacesStore.getState().openApplyDialog(spaceId)} className={className}>
          <Icon name="git-merge" className={iconClassName} />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
};
