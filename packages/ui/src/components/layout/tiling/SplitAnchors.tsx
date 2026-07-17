import React from 'react';
import { useDroppable } from '@dnd-kit/core';

import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { SplitAnchor } from './splitTree';

type AnchorConfig = { anchor: SplitAnchor; zoneClassName: string; icon: IconName };

const ANCHOR_CONFIG: readonly AnchorConfig[] = [
  { anchor: 'left', zoneClassName: 'inset-y-0 left-0 w-[28%]', icon: 'arrow-left' },
  { anchor: 'right', zoneClassName: 'inset-y-0 right-0 w-[28%]', icon: 'arrow-right' },
  { anchor: 'top', zoneClassName: 'inset-x-0 top-0 h-[28%]', icon: 'arrow-up' },
  { anchor: 'bottom', zoneClassName: 'inset-x-0 bottom-0 h-[28%]', icon: 'arrow-down' },
];

const AnchorZone: React.FC<{ groupId: string; anchor: SplitAnchor; label: string; zoneClassName: string; icon: IconName }> = ({
  groupId,
  anchor,
  label,
  zoneClassName,
  icon,
}) => {
  const { setNodeRef, isOver } = useDroppable({
    id: `anchor:${groupId}:${anchor}`,
    data: { type: 'anchor', groupId, anchor },
  });

  return (
    <div
      ref={setNodeRef}
      role="button"
      aria-label={label}
      title={label}
      className={cn(
        'pointer-events-auto absolute flex items-center justify-center transition-colors duration-100',
        zoneClassName,
        isOver
          ? 'bg-[color-mix(in_srgb,var(--interactive-selection)_35%,transparent)] ring-2 ring-inset ring-[var(--primary-base)]'
          : 'bg-transparent',
      )}
    >
      <Icon
        name={icon}
        className={cn(
          'h-5 w-5 transition-opacity duration-100',
          isOver ? 'text-[var(--primary-base)] opacity-100' : 'opacity-0',
        )}
      />
    </div>
  );
};

// Edge drop-zones shown over a region while a tile header is being dragged. Four
// edges only in v1 (left/right/top/bottom) per CONTEXT.md; dropping on one peels
// the dragged tile into a new split beside the region's existing content.
export const SplitAnchors: React.FC<{ groupId: string }> = ({ groupId }) => {
  const { t } = useI18n();
  const labels: Record<SplitAnchor, string> = {
    left: t('tiling.splitAnchor.left'),
    right: t('tiling.splitAnchor.right'),
    top: t('tiling.splitAnchor.top'),
    bottom: t('tiling.splitAnchor.bottom'),
  };

  return (
    <div className="pointer-events-none absolute inset-0 z-30" aria-hidden={false}>
      {ANCHOR_CONFIG.map(({ anchor, zoneClassName, icon }) => (
        <AnchorZone
          key={anchor}
          groupId={groupId}
          anchor={anchor}
          label={labels[anchor]}
          zoneClassName={zoneClassName}
          icon={icon}
        />
      ))}
    </div>
  );
};
