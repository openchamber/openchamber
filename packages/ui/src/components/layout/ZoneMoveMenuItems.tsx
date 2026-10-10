import React from 'react';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { ContextMenuItem } from '@/components/ui/context-menu';
import { useI18n } from '@/lib/i18n';
import type { ContextPanelMode } from '@/lib/surfaces/modes';
import { zoneOfMode, type ContextZone } from '@/lib/workspace/zones';
import { useUIStore } from '@/stores/useUIStore';

const ZONE_MOVES = [
  { zone: 'left', icon: 'layout-left', labelKey: 'contextPanel.zone.moveLeft' },
  { zone: 'bottom', icon: 'layout-bottom', labelKey: 'contextPanel.zone.moveBottom' },
  { zone: 'right', icon: 'layout-right', labelKey: 'contextPanel.zone.moveRight' },
] as const satisfies readonly { zone: ContextZone; icon: IconName; labelKey: string }[];

/**
 * "Move panel to …" for a surface: the keyboard and right-click way to do
 * what dragging a tab onto a zone does. Lists the zones the surface is not in.
 */
export const ZoneMoveMenuItems: React.FC<{ mode: ContextPanelMode }> = ({ mode }) => {
  const { t } = useI18n();
  const current = useUIStore((state) => zoneOfMode(state.contextSurfaceZones, mode));
  const moveContextSurfaceToZone = useUIStore((state) => state.moveContextSurfaceToZone);
  return (
    <>
      {ZONE_MOVES.filter((move) => move.zone !== current).map((move) => (
        <ContextMenuItem key={move.zone} onClick={() => moveContextSurfaceToZone(mode, move.zone)}>
          <Icon name={move.icon} className="mr-2 size-4" />
          {t(move.labelKey)}
        </ContextMenuItem>
      ))}
    </>
  );
};
