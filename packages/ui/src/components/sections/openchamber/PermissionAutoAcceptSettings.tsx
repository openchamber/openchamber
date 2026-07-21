import React from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { SettingsCheckboxRow, SettingsSection } from '@/components/sections/shared/SettingsSection';
import { reportSettingsSaveState } from '@/lib/persistence';
import { useI18n } from '@/lib/i18n';
import { usePermissionStore } from '@/stores/permissionStore';

export const PermissionAutoAcceptSettings: React.FC = () => {
  const { t } = useI18n();
  const defaultEnabled = usePermissionStore((state) => state.defaultEnabled);
  const loaded = usePermissionStore((state) => state.loaded);
  const saving = usePermissionStore((state) => state.saving);
  const setDefaultAutoAccept = usePermissionStore((state) => state.setDefaultAutoAccept);
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const controlsDisabled = saving || !loaded;

  React.useEffect(() => {
    if (controlsDisabled) {
      setConfirmOpen(false);
    }
  }, [controlsDisabled]);

  const persist = React.useCallback(async (enabled: boolean) => {
    reportSettingsSaveState('saving');
    try {
      await setDefaultAutoAccept(enabled);
      reportSettingsSaveState('saved');
    } catch (error) {
      console.warn('Failed to save global permission auto-accept setting:', error);
      reportSettingsSaveState('error');
    }
  }, [setDefaultAutoAccept]);

  const handleToggle = React.useCallback((enabled: boolean) => {
    if (controlsDisabled) {
      return;
    }
    if (enabled === defaultEnabled) {
      return;
    }
    if (enabled) {
      setConfirmOpen(true);
      return;
    }
    void persist(false);
  }, [controlsDisabled, defaultEnabled, persist]);

  const handleConfirm = React.useCallback(() => {
    setConfirmOpen(false);
    void persist(true);
  }, [persist]);

  return (
    <>
      <SettingsSection
        title={t('settings.openchamber.permissionAutoAccept.title')}
        info={t('settings.openchamber.permissionAutoAccept.info')}
      >
        <SettingsCheckboxRow
          settingsItem="sessions.permission-auto-accept"
          checked={defaultEnabled}
          disabled={controlsDisabled}
          onChange={handleToggle}
          label={t('settings.openchamber.permissionAutoAccept.field.globalLabel')}
          ariaLabel={t('settings.openchamber.permissionAutoAccept.field.globalAria')}
          description={t('settings.openchamber.permissionAutoAccept.field.globalWarning')}
        />
      </SettingsSection>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent showCloseButton={false} className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('settings.openchamber.permissionAutoAccept.dialog.title')}</DialogTitle>
            <DialogDescription>{t('settings.openchamber.permissionAutoAccept.dialog.description')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setConfirmOpen(false)} disabled={controlsDisabled}>
              {t('settings.common.actions.cancel')}
            </Button>
            <Button type="button" onClick={handleConfirm} disabled={controlsDisabled}>
              {t('settings.openchamber.permissionAutoAccept.dialog.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};
