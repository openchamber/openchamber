/**
 * "Apply changes" in the Git panel of an isolated space (journey step 6): the panel where the
 * user reads the space's diff is where its work goes back to the project, as a branch or as
 * uncommitted changes, through the apply dialog. The space's row menu in the sidebar and the
 * phone's actions sheet open the same dialog. Nothing for a host directory, while the feature is
 * off, or in VS Code (decision 16).
 */

import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
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
  // As the row's menu: nothing new starts while another action on the space runs.
  const busy = useSpacesStore((state) => (spaceId ? state.actions.get(spaceId)?.kind === 'running' : false));
  if (!enabled || !spaceId || !applicable || isVSCodeRuntime()) return null;
  const label = t('spaces.gitPanel.apply');
  // A narrow panel hides the word (`.space-apply__label` in index.css); the name stays for the pointer.
  return (
    <Button variant="outline" size="sm" className="shrink-0 gap-1.5" aria-label={label} title={label} disabled={busy} onClick={() => useSpacesStore.getState().openApplyDialog(spaceId)}>
      <Icon name="git-merge" className="size-3.5" />
      <span className="space-apply__label">{label}</span>
    </Button>
  );
};
