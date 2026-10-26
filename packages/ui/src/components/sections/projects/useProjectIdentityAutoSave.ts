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
    projectId,
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
  // What was last handed to `onSave` for this project. The store may keep a
  // value the form cannot match (a variant a caller does not persist, a hex
  // color the store normalizes away), so `hasChanges` alone would schedule
  // the same save every 450 ms for as long as the form stays open.
  const lastSavedRef = React.useRef<{ projectId: string | null; data: string } | null>(null);

  React.useEffect(() => {
    if (!hasChanges) {
      // The store matches the form again, so whatever is typed next is a
      // new change even if it repeats an earlier value.
      lastSavedRef.current = null;
      return;
    }
    if (!name.trim() || isUploadingIcon || isRemovingCustomIcon || isSavingRef.current) {
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
            const serialized = JSON.stringify(data);
            const lastSaved = lastSavedRef.current;
            if (lastSaved && lastSaved.projectId === projectId && lastSaved.data === serialized) {
              return;
            }
            try {
              await onSave(data);
              lastSavedRef.current = { projectId, data: serialized };
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
    projectId,
    t,
  ]);
};
