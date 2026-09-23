import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { ContextMenuItem } from '@/components/ui/context-menu';
import type { IconName } from '@/components/icon/icons';
import type { I18nKey } from '@/lib/i18n';
import { useI18n } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import {
  allowedZonesForSurface,
  WORKSPACE_ZONES,
  type WorkspaceZone,
} from '@/lib/workspace/layout';

const ZONE_PRESENTATION = {
  left: { icon: 'layout-left', labelKey: 'workspace.move.left' },
  center: { icon: 'layout-column', labelKey: 'workspace.move.center' },
  right: { icon: 'layout-right', labelKey: 'workspace.move.right' },
  bottom: { icon: 'layout-bottom-2', labelKey: 'workspace.move.bottom' },
} satisfies Record<WorkspaceZone, { icon: IconName; labelKey: I18nKey }>;

type Props = {
  /** Registry id of the surface being moved, or null when it cannot be resolved. */
  surfaceId: string | null;
  currentZone: WorkspaceZone;
};

/**
 * The docking rows of a surface's context menu: "Move to ..." for each zone
 * it allows.
 *
 * The zone it is already in is shown as its current place rather than hidden,
 * so the menu says where the surface lives as well as where it can go.
 */
export const WorkspaceMoveMenuItems: React.FC<Props> = ({ surfaceId, currentZone }) => {
  const { t } = useI18n();
  const moveWorkspaceSurface = useUIStore((state) => state.moveWorkspaceSurface);

  if (!surfaceId) return null;

  const allowed = allowedZonesForSurface(surfaceId);
  const targets = WORKSPACE_ZONES.filter((zone) => allowed.includes(zone));
  if (targets.length < 2) return null;

  return (
    <>
      {targets.map((zone) => {
        const presentation = ZONE_PRESENTATION[zone];
        return (
          <ContextMenuItem
            key={zone}
            disabled={zone === currentZone}
            onClick={() => {
              moveWorkspaceSurface(surfaceId, zone);
            }}
          >
            <Icon name={presentation.icon} className="mr-2 size-4" />
            {t(presentation.labelKey)}
          </ContextMenuItem>
        );
      })}
    </>
  );
};
