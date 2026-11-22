import React from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { CONTEXT_ZONES, type ContextZone } from '@/lib/workspace/zones';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { useZoneDragStore } from './zoneDrag';
import { isContextWindow } from '@/lib/contextWindow/role';

const TARGET_LABEL_KEYS = {
  left: 'contextPanel.zone.dropLeft',
  bottom: 'contextPanel.zone.dropBottom',
  right: 'contextPanel.zone.dropRight',
} as const;

const TARGET_ICONS = { left: 'layout-left', bottom: 'layout-bottom', right: 'layout-right' } as const satisfies Record<ContextZone, IconName>;

export const ZoneDropOverlay: React.FC = () => {
  const { t } = useI18n();
  const inContextWindow = isContextWindow();
  const labelKeys = inContextWindow ? { ...TARGET_LABEL_KEYS, bottom: 'contextPanel.zone.dropCenter' as const } : TARGET_LABEL_KEYS;
  const iconFor = (zone: ContextZone): IconName => (inContextWindow && zone === 'bottom' ? 'layout-center' : TARGET_ICONS[zone]);
  const drag = useZoneDragStore((state) => state.drag);
  const hovered = useZoneDragStore((state) => state.hovered);
  const chipRef = React.useRef<HTMLDivElement | null>(null);
  const [entered, setEntered] = React.useState(false);
  React.useEffect(() => {
    if (!drag) {
      setEntered(false);
      return undefined;
    }
    const frame = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(frame);
  }, [drag]);

  React.useEffect(() => {
    if (!drag) return undefined;
    const onMove = (event: PointerEvent) => {
      const chip = chipRef.current;
      if (chip) chip.style.transform = `translate(${event.clientX + 12}px, ${event.clientY + 12}px)`;
    };
    window.addEventListener('pointermove', onMove);
    return () => window.removeEventListener('pointermove', onMove);
  }, [drag]);

  if (!drag) return null;

  return createPortal(
    <div className="pointer-events-none fixed inset-0 z-[60]" aria-hidden="true">
      <div
        className={cn(
          'absolute inset-0 bg-surface-overlay/40 transition-opacity duration-150 ease-out motion-reduce:transition-none',
          entered ? 'opacity-100' : 'opacity-0',
        )}
      />
      {inContextWindow ? CONTEXT_ZONES.map((zone) => {
        const rect = drag.targets[zone];
        if (rect.width <= 0 || rect.height <= 0) return null;
        return <div key={`${zone}-plate`} className="absolute bg-background" style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }} />;
      }) : null}
      {CONTEXT_ZONES.map((zone) => {
        const rect = drag.frames[zone];
        if (rect.width <= 0 || rect.height <= 0) return null;
        const active = hovered === zone;
        return (
          <div
            key={zone}
            className={cn(
              'absolute flex flex-col items-center justify-center gap-2 rounded-[10px] border border-dashed transition-colors duration-100 motion-reduce:transition-none',
              active
                ? 'border-solid border-primary bg-[color-mix(in_srgb,var(--primary)_8%,var(--background))] text-foreground'
                : 'border-edge-strong bg-[color-mix(in_srgb,var(--foreground)_var(--oc-tile-tone),var(--background))] text-muted-foreground',
            )}
            style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
          >
            <Icon name={iconFor(zone)} className={cn('size-6', active && 'text-primary')} />
            <span className="max-w-full truncate px-3 typography-ui-label">
              {t(labelKeys[zone])}
            </span>
          </div>
        );
      })}
      <div
        ref={chipRef}
        // oxlint-disable-next-line openchamber/no-physical-sides -- follows the pointer through translate(clientX), which is physical
        className="absolute left-0 top-0 rounded-md border border-border bg-background px-2 py-1 typography-meta text-foreground shadow-sm"
      >
        {drag.label}
      </div>
    </div>,
    document.body,
  );
};
