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
  // Tracks a save that has been scheduled but has not fired yet, so closing
  // the dialog (unmounting) can flush it instead of silently dropping it.
  const scheduledRef = React.useRef(false);
  // Holds the latest flush routine for the debounced effect above, so the
  // unmount-only effect registered below can invoke it.
  const flushPendingRef = React.useRef<() => void>(() => {});
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
      scheduledRef.current = false;
      return;
    }
    if (!name.trim() || isUploadingIcon || isRemovingCustomIcon || isSavingRef.current) {
      scheduledRef.current = false;
      return;
    }

    const commitSave = async () => {
      if (isSavingRef.current) {
        return;
      }
      isSavingRef.current = true;
      try {
        const data = await prepareSaveData({ silent: true });
        if (data) {
          const serialized = JSON.stringify(data);
          const lastSaved = lastSavedRef.current;
          if (!(lastSaved && lastSaved.projectId === projectId && lastSaved.data === serialized)) {
            try {
              await onSave(data);
              lastSavedRef.current = { projectId, data: serialized };
            } catch {
              toast.error(t('settings.projects.page.toast.saveFailed'));
            }
          }
        }
      } finally {
        isSavingRef.current = false;
      }
    };

    scheduledRef.current = true;
    const timer = window.setTimeout(() => {
      scheduledRef.current = false;
      void commitSave();
    }, AUTO_SAVE_DELAY_MS);

    const flushPending = () => {
      if (!scheduledRef.current) {
        return;
      }
      window.clearTimeout(timer);
      scheduledRef.current = false;
      void commitSave();
    };

    flushPendingRef.current = flushPending;

    return () => {
      // Leave `scheduledRef` alone: on unmount the flush below still needs to
      // know a save is pending. Either order works, since the flush clears
      // this timer too.
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

  // Flushes a save still waiting on the debounce when the dialog or page goes
  // away. Empty deps keep this cleanup to the unmount only, and
  // `flushPendingRef` holds the routine of the latest scheduled run.
  React.useEffect(() => {
    return () => {
      flushPendingRef.current();
    };
  }, []);
};
