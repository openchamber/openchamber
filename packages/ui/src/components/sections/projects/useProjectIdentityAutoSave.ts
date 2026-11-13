import React from 'react';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import type { ProjectIdentitySaveData, useProjectIdentityForm } from './useProjectIdentityForm';

type ProjectIdentityFormState = ReturnType<typeof useProjectIdentityForm>;
type SaveSnapshot = Pick<ProjectIdentityFormState, 'projectId' | 'prepareSaveData' | 'pendingUploadIconFile' | 'pendingRemoveImageIcon'> & {
  onSave: (data: ProjectIdentitySaveData) => void | Promise<void>;
  onError: () => void;
};

const AUTO_SAVE_DELAY_MS = 450;
// Closing and reopening an editor must not let its old writes overtake new ones.
const projectSaveTails = new Map<string | null, Promise<void>>();

export const useProjectIdentityAutoSave = (
  form: ProjectIdentityFormState,
  onSave: (data: ProjectIdentitySaveData) => void | Promise<void>,
) => {
  const { t } = useI18n();
  const pendingRef = React.useRef(new Map<string | null, SaveSnapshot>());
  const savingProjectRef = React.useRef<string | null | undefined>(undefined);
  // Callers may normalize or omit fields, leaving hasChanges true after a save.
  const lastSavedRef = React.useRef<{ projectId: string | null; data: string } | null>(null);

  const flushPending = React.useCallback(async (): Promise<void> => {
    if (savingProjectRef.current !== undefined || !pendingRef.current.size) return;
    const projectId = pendingRef.current.keys().next().value;
    if (projectId === undefined) return;
    savingProjectRef.current = projectId;
    const previous = projectSaveTails.get(projectId);
    let release = () => {};
    const finished = new Promise<void>((resolve) => { release = resolve; });
    projectSaveTails.set(projectId, finished);
    let prepared: SaveSnapshot | null = null;
    try {
      if (previous) await previous;
      while (pendingRef.current.has(projectId)) {
        const snapshot = pendingRef.current.get(projectId);
        if (!snapshot) break;
        pendingRef.current.delete(projectId);
        try {
          // A trailing edit shares the icon operation that already finished.
          const skipIconChanges = prepared !== null
            && prepared.projectId === snapshot.projectId
            && prepared.pendingUploadIconFile === snapshot.pendingUploadIconFile
            && prepared.pendingRemoveImageIcon === snapshot.pendingRemoveImageIcon;
          const data = await snapshot.prepareSaveData({ silent: true, skipIconChanges });
          if (!data) continue;
          prepared = snapshot;
          const serialized = JSON.stringify(data);
          const lastSaved = lastSavedRef.current;
          if (lastSaved?.projectId === snapshot.projectId && lastSaved.data === serialized) continue;
          await snapshot.onSave(data);
          lastSavedRef.current = { projectId: snapshot.projectId, data: serialized };
        } catch {
          snapshot.onError();
        }
      }
    } finally {
      release();
      if (projectSaveTails.get(projectId) === finished) projectSaveTails.delete(projectId);
      savingProjectRef.current = undefined;
      // A mounted panel may have switched projects while this queue drained.
      if (pendingRef.current.size) void flushPending();
    }
  }, []);

  React.useEffect(() => {
    if (!form.hasChanges) lastSavedRef.current = null;
    if ((!form.hasChanges && savingProjectRef.current !== form.projectId) || !form.name.trim()) {
      pendingRef.current.delete(form.projectId);
      return;
    }
    pendingRef.current.set(form.projectId, {
      projectId: form.projectId,
      prepareSaveData: form.prepareSaveData,
      pendingUploadIconFile: form.pendingUploadIconFile,
      pendingRemoveImageIcon: form.pendingRemoveImageIcon,
      onSave,
      onError: () => toast.error(t('settings.projects.page.toast.saveFailed')),
    });
    const timer = window.setTimeout(() => void flushPending(), AUTO_SAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [form.hasChanges, form.name, form.projectId, form.prepareSaveData, form.pendingUploadIconFile, form.pendingRemoveImageIcon, onSave, t, flushPending]);

  React.useEffect(() => () => { void flushPending(); }, [flushPending]);
};
