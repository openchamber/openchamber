import React from 'react';
import { useI18n } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { SettingsCheckboxRow } from '@/components/sections/shared/SettingsSection';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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
  const hidden = useUIStore((state) => state.contextRailHiddenSurfaces);
  const setSurfaceVisible = useUIStore((state) => state.setContextRailSurfaceVisible);
  const setHiddenSurfaces = useUIStore((state) => state.setContextRailHiddenSurfaces);

  // The full registry in the user's rail order — including surfaces a runtime
  // filter currently drops, so a choice made on desktop is editable anywhere.
  const surfaces = React.useMemo(() => sortContextSurfaces(contextRailOrder), [contextRailOrder]);

  const allVisible = hidden.length === 0;
  const noneVisible = surfaces.every((surface) => hidden.includes(surface.id));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('contextRail.configure.dialogTitle')}</DialogTitle>
          <DialogDescription>{t('contextRail.configure.dialogDescription')}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col">
          {surfaces.map((surface) => (
            <SettingsCheckboxRow
              key={surface.id}
              settingsItem={`layout.context-rail.surface.${surface.id}`}
              checked={!hidden.includes(surface.id)}
              onChange={(checked) => setSurfaceVisible(surface.id, checked)}
              label={t(surface.labelKey)}
              ariaLabel={t(surface.labelKey)}
            />
          ))}
        </div>

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
