import React from 'react';
import { useI18n } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
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
import { sortContextSurfaces } from '@/lib/surfaces/registry';

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
  // A build without workflows does not name the unreleased surface anywhere.
  const workflowsAvailable = useUIStore((state) => state.agentWorkflowFeatureAvailable);
  const surfaces = React.useMemo(
    () => sortContextSurfaces(contextRailOrder, guestSurfaces).filter((surface) => workflowsAvailable || surface.id !== 'workflows'),
    [contextRailOrder, guestSurfaces, workflowsAvailable],
  );

  const allVisible = hidden.length === 0;
  const noneVisible = surfaces.every((surface) => hidden.includes(surface.id));
  const dragging = React.useRef(false);
  const items = React.useMemo(() => surfaces.map((surface) => ({
    id: surface.id,
    label: surface.label ?? t(surface.labelKey),
    visible: !hidden.includes(surface.id),
  })), [hidden, surfaces, t]);
  const handleReorder = (next: string[]) => {
    const shown = new Set<string>(next);
    // Keep saved entries for extensions that are temporarily unavailable.
    setSurfaceOrder([...next, ...contextRailOrder.filter((id) => !shown.has(id))]);
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
