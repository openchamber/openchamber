import React from 'react';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { ContextMenuItem } from '@/components/ui/context-menu';
import { useI18n } from '@/lib/i18n';
import { isContextWindow } from '@/lib/contextWindow/role';
import type { ContextPanelMode } from '@/lib/surfaces/modes';
import { zoneOfMode, type ContextZone } from '@/lib/workspace/zones';
import { useUIStore } from '@/stores/useUIStore';

const ZONE_MOVES = [
  { zone: 'left', icon: 'layout-left', labelKey: 'contextPanel.zone.moveLeft' },
  { zone: 'bottom', icon: 'layout-bottom', labelKey: 'contextPanel.zone.moveBottom' },
  { zone: 'right', icon: 'layout-right', labelKey: 'contextPanel.zone.moveRight' },
] as const satisfies readonly { zone: ContextZone; icon: IconName; labelKey: string }[];

const CENTER_MOVE = { zone: 'bottom', icon: 'layout-center', labelKey: 'contextPanel.zone.moveCenter' } as const satisfies { zone: ContextZone; icon: IconName; labelKey: string };

export const ZoneMoveMenuItems: React.FC<{ mode: ContextPanelMode }> = ({ mode }) => {
  const { t } = useI18n();
  const current = useUIStore((state) => zoneOfMode(state.contextSurfaceZones, mode));
  const moveContextSurfaceToZone = useUIStore((state) => state.moveContextSurfaceToZone);
  const moves = isContextWindow() ? ZONE_MOVES.map((move) => (move.zone === 'bottom' ? CENTER_MOVE : move)) : ZONE_MOVES;
  return (
    <>
      {moves.filter((move) => move.zone !== current).map((move) => (
        <ContextMenuItem key={move.zone} onClick={() => moveContextSurfaceToZone(mode, move.zone)}>
          <Icon name={move.icon} className="me-2 size-4" />
          {t(move.labelKey)}
        </ContextMenuItem>
      ))}
    </>
  );
};
