import React from 'react';
import { useI18n } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { selectWorkflowsShown } from '@/lib/workflows/availability';
import { SettingsSortableVisibilityList } from '@/components/sections/shared/SettingsSortableVisibilityList';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useGuestSurfaces } from '@/hooks/useGuestSurfaces';
import { contextSurfaceGroup, sortContextSurfaces } from '@/lib/surfaces/registry';

/**
 * Which surfaces the context rail shows. Everything is on by default and the
 * choice is stored as the *hidden* set, so a surface added in a later release
 * appears for everyone rather than staying invisible to whoever had saved
 * settings before it existed. Hidden surfaces also leave the digit shortcuts
 * (the rail and the shortcut share one visibility filter).
 */
export const ContextRailSurfacesDialog: React.FC<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
}> = ({ open, onOpenChange }) => {
  const { t } = useI18n();
  const contextRailOrder = useUIStore((state) => state.contextRailOrder);
  const setSurfaceOrder = useUIStore((state) => state.setContextRailOrder);
  const hidden = useUIStore((state) => state.contextRailHiddenSurfaces);
  const setSurfaceVisible = useUIStore((state) => state.setContextRailSurfaceVisible);
  const setHiddenSurfaces = useUIStore((state) => state.setContextRailHiddenSurfaces);

  // The full registry in the user's rail order — including surfaces a runtime
  // filter currently drops, so a choice made on desktop is editable anywhere.
  const guestSurfaces = useGuestSurfaces();
  // While workflows are not shown the surface is not offered.
  const workflowsAvailable = useUIStore(selectWorkflowsShown);
  const surfaces = React.useMemo(
    () => sortContextSurfaces(contextRailOrder, guestSurfaces).filter((surface) => workflowsAvailable || surface.id !== 'workflows'),
    [contextRailOrder, guestSurfaces, workflowsAvailable],
  );

  const allVisible = hidden.length === 0;
  const noneVisible = surfaces.every((surface) => hidden.includes(surface.id));
  const dragging = React.useRef(false);
  const items = React.useMemo(() => surfaces.map((surface, index) => ({
    id: surface.id,
    label: surface.label ?? t(surface.labelKey),
    visible: !hidden.includes(surface.id),
    groupStart: index > 0 && contextSurfaceGroup(surfaces[index - 1]) !== contextSurfaceGroup(surface),
  })), [hidden, surfaces, t]);
  // The rail's groups stay together: a surface dropped inside its own group
  // moves there, and one dropped ahead of another group carries its whole
  // group along (sortContextSurfaces). The saved order is that grouped order.
  const handleReorder = (next: string[]) => {
    const grouped = sortContextSurfaces(next, guestSurfaces).map((surface) => surface.id).filter((id) => next.includes(id));
    const shown = new Set<string>(grouped);
    // Keep saved entries for extensions that are temporarily unavailable.
    setSurfaceOrder([...grouped, ...contextRailOrder.filter((id) => !shown.has(id))]);
  };

  return (
    <Dialog open={open} onOpenChange={(nextOpen, details) => {
      if (!nextOpen && details.reason === 'escape-key' && dragging.current) {
        details.cancel();
        details.allowPropagation();
        return;
      }
      dragging.current = false;
      onOpenChange(nextOpen);
    }}>
      <DialogContent
        className="max-w-md"
        onKeyDown={(event) => {
          // Base UI stops arrow keys at the popup; dnd-kit listens on document.
          if (dragging.current && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) {
            event.preventBaseUIHandler();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>{t('contextRail.configure.dialogTitle')}</DialogTitle>
          <DialogDescription>{t('contextRail.configure.dialogDescription')}</DialogDescription>
        </DialogHeader>

        <SettingsSortableVisibilityList
          items={items}
          onVisibleChange={setSurfaceVisible}
          onReorder={handleReorder}
          settingsItemPrefix="layout.context-rail.surface."
          dragInstructions={t('contextRail.configure.dragInstructions')}
          onDraggingChange={(next) => { dragging.current = next; }}
        />

        {!allVisible ? (
          <div className="flex items-center justify-between border-t pt-3">
            {noneVisible ? (
              <span className="text-xs text-destructive">{t('contextRail.configure.noneWarning')}</span>
            ) : <span />}
            <Button
              variant="link"
              size="xs"
              onClick={() => setHiddenSurfaces([])}
              className="normal-case text-muted-foreground hover:text-foreground"
            >
              {t('contextRail.configure.showAll')}
            </Button>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
};
