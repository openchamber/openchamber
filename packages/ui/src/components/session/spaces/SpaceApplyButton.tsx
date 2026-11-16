
import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { ButtonTooltip } from '@/components/ui/action-toolbar';
import { isVSCodeRuntime } from '@/lib/desktop';
import { useI18n } from '@/lib/i18n';
import { isSpaceApplicable } from '@/lib/spaces/space-repair';
import { spaceIdOfDirectory } from '@/lib/spaces/space-route';
import { useSpacesStore } from '@/lib/spaces/spaces-store';
import { useUIStore } from '@/stores/useUIStore';

export const SpaceApplyButton: React.FC<{ directory: string | null | undefined }> = ({ directory }) => {
  const { t } = useI18n();
  const enabled = useUIStore((state) => state.isolatedSpacesEnabled);
  const spaceId = spaceIdOfDirectory(directory);
  const applicable = useSpacesStore((state) => isSpaceApplicable(spaceId ? state.journey?.get(spaceId) : undefined));
  const busy = useSpacesStore((state) => (spaceId ? state.actions.get(spaceId)?.kind === 'running' : false));
  if (!enabled || !spaceId || !applicable || isVSCodeRuntime()) return null;
  const label = t('spaces.gitPanel.apply');
  return (
    <ButtonTooltip label={t('contextTooltips.git.spaceApply')} side="bottom" className="shrink-0">
      <Button variant="outline" size="sm" className="shrink-0 gap-1.5" aria-label={label} disabled={busy} onClick={() => useSpacesStore.getState().openApplyDialog(spaceId)}>
        <Icon name="git-merge" className="size-3.5" />
        <span className="space-apply__label">{label}</span>
      </Button>
    </ButtonTooltip>
  );
};
