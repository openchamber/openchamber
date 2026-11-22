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

  const guestSurfaces = useGuestSurfaces();
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
  const handleReorder = (next: string[]) => {
    const grouped = sortContextSurfaces(next, guestSurfaces).map((surface) => surface.id).filter((id) => next.includes(id));
    const shown = new Set<string>(grouped);
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
