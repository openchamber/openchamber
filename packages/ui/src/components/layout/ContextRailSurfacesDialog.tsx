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
import { useGuestSurfaces } from '@/hooks/useGuestSurfaces';
import { sortContextSurfaces } from '@/lib/surfaces/registry';
import { WORKSPACE_PRESET_IDS, type WorkspacePresetId } from '@/lib/workspace/layout';
import { WorkspaceZonePicker } from './workspace/WorkspaceZonePicker';
import type { I18nKey } from '@/lib/i18n';

const WORKSPACE_PRESET_LABELS = {
  default: 'workspace.preset.default',
  developer: 'workspace.preset.developer',
  'code-agent': 'workspace.preset.codeAgent',
} satisfies Record<WorkspacePresetId, I18nKey>;

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
  const applyWorkspaceLayoutPreset = useUIStore((state) => state.applyWorkspaceLayoutPreset);
  const resetWorkspaceLayout = useUIStore((state) => state.resetWorkspaceLayout);

  // The full registry in the user's rail order — including surfaces a runtime
  // filter currently drops, so a choice made on desktop is editable anywhere.
  const guestSurfaces = useGuestSurfaces();
  const surfaces = React.useMemo(
    () => sortContextSurfaces(contextRailOrder, guestSurfaces),
    [contextRailOrder, guestSurfaces],
  );

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
              label={surface.label ?? t(surface.labelKey)}
              ariaLabel={surface.label ?? t(surface.labelKey)}
              labelAccessory={<WorkspaceZonePicker surfaceId={surface.id} />}
            />
          ))}
        </div>

        {/* Starting points for the workspace zones. A preset writes a layout
            once; the user keeps rearranging from there, and Default is the
            way back to the original arrangement. */}
        <div className="flex flex-col gap-2 border-t pt-3">
          <span className="typography-ui-label text-muted-foreground">{t('workspace.preset.title')}</span>
          <div className="flex flex-wrap gap-2">
            {WORKSPACE_PRESET_IDS.map((preset) => (
              <Button
                key={preset}
                variant="outline"
                size="xs"
                onClick={() => applyWorkspaceLayoutPreset(preset)}
              >
                {t(WORKSPACE_PRESET_LABELS[preset])}
              </Button>
            ))}
            <Button variant="ghost" size="xs" onClick={resetWorkspaceLayout}>
              {t('workspace.preset.reset')}
            </Button>
          </div>
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
