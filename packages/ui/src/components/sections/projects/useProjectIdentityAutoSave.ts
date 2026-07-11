import React from 'react';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import type { ProjectIdentitySaveData } from './useProjectIdentityForm';
import type { useProjectIdentityForm } from './useProjectIdentityForm';

type ProjectIdentityFormState = ReturnType<typeof useProjectIdentityForm>;

const AUTO_SAVE_DELAY_MS = 450;

export const useProjectIdentityAutoSave = (
  form: ProjectIdentityFormState,
  onSave: (data: ProjectIdentitySaveData) => void | Promise<void>,
) => {
  const { t } = useI18n();
  const {
    hasChanges,
    name,
    icon,
    color,
    iconBackground,
    defaultModel,
    pendingRemoveImageIcon,
    pendingUploadIconFile,
    isUploadingIcon,
    isRemovingCustomIcon,
    prepareSaveData,
  } = form;

  const isSavingRef = React.useRef(false);

  React.useEffect(() => {
    if (!hasChanges || !name.trim() || isUploadingIcon || isRemovingCustomIcon || isSavingRef.current) {
      return;
    }

    const timer = window.setTimeout(() => {
      if (isSavingRef.current) {
        return;
      }
      isSavingRef.current = true;
      void (async () => {
        try {
          const data = await prepareSaveData({ silent: true });
          if (data) {
            try {
              await onSave(data);
            } catch {
              toast.error(t('settings.projects.page.toast.saveFailed'));
            }
          }
        } finally {
          isSavingRef.current = false;
        }
      })();
    }, AUTO_SAVE_DELAY_MS);

    return () => {
      window.clearTimeout(timer);
    };
  }, [
    color,
    defaultModel,
    hasChanges,
    icon,
    iconBackground,
    isRemovingCustomIcon,
    isUploadingIcon,
    name,
    onSave,
    pendingRemoveImageIcon,
    pendingUploadIconFile,
    prepareSaveData,
    t,
  ]);
};
