import React from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { CONTEXT_ZONES } from '@/lib/workspace/zones';
import { useZoneDragStore } from './zoneDrag';

const TARGET_LABEL_KEYS = {
  left: 'contextPanel.zone.dropLeft',
  bottom: 'contextPanel.zone.dropBottom',
  right: 'contextPanel.zone.dropRight',
} as const;

/**
 * The drop targets while a surface is dragged, over a scrim, and a chip with
 * its name under the pointer. Pointer-transparent: the drag source keeps the gesture. The
 * chip follows the pointer by writing its own transform, so a drag renders
 * React only when the hovered target changes.
 */
export const ZoneDropOverlay: React.FC = () => {
  const { t } = useI18n();
  const drag = useZoneDragStore((state) => state.drag);
  const hovered = useZoneDragStore((state) => state.hovered);
  const chipRef = React.useRef<HTMLDivElement | null>(null);
  // The scrim fades in on the frame after the overlay mounts.
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
      {/* Dims the app around the targets; the dialog scrim's tone, lighter and
          without blur so the layout under the targets stays recognisable. */}
      <div
        className={cn(
          'absolute inset-0 bg-surface-overlay/40 transition-opacity duration-150 ease-out motion-reduce:transition-none',
          entered ? 'opacity-100' : 'opacity-0',
        )}
      />
      {CONTEXT_ZONES.map((zone) => {
        const rect = drag.frames[zone];
        if (rect.width <= 0 || rect.height <= 0) return null;
        const active = hovered === zone;
        return (
          <div
            key={zone}
            className={cn(
              'absolute flex items-center justify-center rounded-[10px] border transition-colors duration-100',
              // Opaque enough that the label reads over whatever is under it.
              active
                ? 'border-primary bg-background/90 text-foreground shadow-sm'
                : 'border-border bg-background/80 text-muted-foreground',
            )}
            style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
          >
            <span className="typography-ui-label">
              {t(TARGET_LABEL_KEYS[zone])}
            </span>
          </div>
        );
      })}
      <div
        ref={chipRef}
        className="absolute left-0 top-0 rounded-md border border-border bg-background px-2 py-1 typography-meta text-foreground shadow-sm"
      >
        {drag.label}
      </div>
    </div>,
    document.body,
  );
};
