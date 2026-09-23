import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { IconName } from '@/components/icon/icons';
import type { I18nKey } from '@/lib/i18n';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';
import {
  allowedZonesForSurface,
  WORKSPACE_ZONES,
  zoneOfSurface,
  type WorkspaceZone,
} from '@/lib/workspace/layout';

const ZONE_PRESENTATION = {
  left: { icon: 'layout-left', labelKey: 'workspace.move.left' },
  center: { icon: 'layout-column', labelKey: 'workspace.move.center' },
  right: { icon: 'layout-right', labelKey: 'workspace.move.right' },
  bottom: { icon: 'layout-bottom-2', labelKey: 'workspace.move.bottom' },
} satisfies Record<WorkspaceZone, { icon: IconName; labelKey: I18nKey }>;

/**
 * Where one surface is docked, as a row of zone buttons.
 *
 * This is the entry point that reaches every surface, including the session
 * conversation: the conversation has no rail icon of its own and, while it is
 * the only thing in its zone, no tab strip to right-click either.
 */
export const WorkspaceZonePicker: React.FC<{ surfaceId: string }> = ({ surfaceId }) => {
  const { t } = useI18n();
  const layout = useUIStore((state) => state.workspaceLayout);
  const moveWorkspaceSurface = useUIStore((state) => state.moveWorkspaceSurface);

  const allowed = allowedZonesForSurface(surfaceId);
  const targets = WORKSPACE_ZONES.filter((zone) => allowed.includes(zone));
  if (targets.length < 2) return null;

  const current = zoneOfSurface(layout, surfaceId);

  return (
    // The row around this handles Enter and Space itself to toggle rail
    // visibility; keys pressed on a zone button stop here.
    <div className="flex items-center gap-0.5" onKeyDown={(event) => event.stopPropagation()}>
      {targets.map((zone) => {
        const presentation = ZONE_PRESENTATION[zone];
        const label = t(presentation.labelKey);
        return (
          <Tooltip key={zone}>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={label}
                aria-pressed={zone === current}
                onClick={(event) => {
                  // The row around this is itself a button that toggles rail
                  // visibility; docking is a different choice.
                  event.stopPropagation();
                  moveWorkspaceSurface(surfaceId, zone);
                }}
                className={cn(
                  'flex h-6 w-6 items-center justify-center rounded transition-colors',
                  zone === current
                    ? 'bg-interactive-selection text-foreground'
                    : 'text-muted-foreground hover:bg-interactive-hover hover:text-foreground',
                )}
              >
                <Icon name={presentation.icon} className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent>{label}</TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
};
