import React from 'react';

import { toast } from '@/components/ui';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { Button } from '@/components/ui/button';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { isFilesystemError } from '@/lib/api/files-errors';
import { notifyFileContentInvalidated } from '@/lib/fileContentInvalidation';
import { useI18n } from '@/lib/i18n';
import { getRuntimeKey } from '@/lib/runtime-switch';

type UploadConflicts = {
  directory: string;
  files: File[];
  runtimeKey: string;
  workspaceRoot: string;
};

type UploadOutcome = 'uploaded' | 'conflict' | 'failed';

const MAX_PARALLEL_UPLOADS = 3;

const joinPath = (directory: string, name: string): string => (
  `${directory.replace(/[\\/]+$/, '')}/${name}`
);

const getUploadName = (file: File): string | null => {
  const name = file.name;
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
    return null;
  }
  return name;
};

type FileTreeUploadOptions = {
  /** Normalized workspace root the tree shows; uploads are scoped to it. */
  root: string;
  refreshDirectory: (directory: string) => Promise<void>;
};

/**
 * Uploads external files into a workspace directory for a file tree:
 * drag-and-drop callers pass files directly, picker callers open the
 * system file chooser (gallery/camera/files on mobile). Existing names
 * are never replaced silently; they surface in a replace-confirmation
 * dialog rendered through `uploadElements`.
 */
export const useFileTreeUpload = ({ root, refreshDirectory }: FileTreeUploadOptions) => {
  const { t } = useI18n();
  const { files } = useRuntimeAPIs();
  const uploadFile = files.uploadFile;
  const [uploadingDirectory, setUploadingDirectory] = React.useState<string | null>(null);
  const [uploadConflicts, setUploadConflicts] = React.useState<UploadConflicts | null>(null);
  const uploadingRef = React.useRef(false);
  const rootRef = React.useRef(root);
  rootRef.current = root;
  const inputRef = React.useRef<HTMLInputElement>(null);
  const pickerDirectoryRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    setUploadConflicts(null);
  }, [root]);

  const uploadFiles = React.useCallback(async (
    directory: string,
    selectedFiles: File[],
    overwrite = false,
  ) => {
    if (!uploadFile || selectedFiles.length === 0 || uploadingRef.current || !root) return;

    const operationRoot = root;
    const operationRuntime = getRuntimeKey();
    uploadingRef.current = true;
    setUploadingDirectory(directory);
    if (overwrite) setUploadConflicts(null);

    const outcomes: UploadOutcome[] = [];
    for (let index = 0; index < selectedFiles.length; index += MAX_PARALLEL_UPLOADS) {
      const batch = selectedFiles.slice(index, index + MAX_PARALLEL_UPLOADS);
      const batchOutcomes = await Promise.all(batch.map(async (file): Promise<UploadOutcome> => {
        const name = getUploadName(file);
        if (!name || getRuntimeKey() !== operationRuntime) return 'failed';

        try {
          const result = await uploadFile(joinPath(directory, name), file, {
            directory: operationRoot,
            overwrite,
          });
          return result.success ? 'uploaded' : 'failed';
        } catch (error) {
          if (!overwrite && isFilesystemError(error) && error.reason === 'already-exists') {
            return 'conflict';
          }
          return 'failed';
        }
      }));
      outcomes.push(...batchOutcomes);
    }

    const uploadedCount = outcomes.filter((outcome) => outcome === 'uploaded').length;
    const failedCount = outcomes.filter((outcome) => outcome === 'failed').length;
    const conflictingFiles = selectedFiles.filter((_, index) => outcomes[index] === 'conflict');
    const uploadedPaths = selectedFiles.flatMap((file, index) => {
      const name = getUploadName(file);
      return outcomes[index] === 'uploaded' && name ? [joinPath(directory, name)] : [];
    });
    const isCurrentDestination = rootRef.current === operationRoot && getRuntimeKey() === operationRuntime;

    try {
      if (uploadedPaths.length > 0) {
        notifyFileContentInvalidated({ runtimeKey: operationRuntime, paths: uploadedPaths });
      }
      if (uploadedCount > 0 && isCurrentDestination) {
        await refreshDirectory(directory);
      }
      if (uploadedCount > 0) {
        toast.success(t(conflictingFiles.length > 0
          ? 'sidebarFilesTree.toast.uploadedWithoutConflicts'
          : 'sidebarFilesTree.toast.uploaded'));
      }
      if (failedCount > 0) {
        toast.error(t('sidebarFilesTree.toast.uploadFailed'));
      }
      if (conflictingFiles.length > 0 && isCurrentDestination) {
        setUploadConflicts({
          directory,
          files: conflictingFiles,
          runtimeKey: operationRuntime,
          workspaceRoot: operationRoot,
        });
      }
    } finally {
      uploadingRef.current = false;
      setUploadingDirectory(null);
    }
  }, [refreshDirectory, root, t, uploadFile]);

  const pickFiles = React.useCallback((directory: string) => {
    const input = inputRef.current;
    if (!input || uploadingRef.current) return;
    pickerDirectoryRef.current = directory;
    input.value = '';
    input.click();
  }, []);

  const handlePickerChange = React.useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const directory = pickerDirectoryRef.current;
    const picked = Array.from(event.target.files ?? []);
    pickerDirectoryRef.current = null;
    event.target.value = '';
    if (!directory || picked.length === 0) return;
    void uploadFiles(directory, picked);
  }, [uploadFiles]);

  const uploadElements = (
    <>
      <input ref={inputRef} type="file" multiple hidden onChange={handlePickerChange} />
      <Dialog open={Boolean(uploadConflicts)} onOpenChange={(open: boolean) => !open && setUploadConflicts(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('sidebarFilesTree.dialog.uploadConflicts.title')}</DialogTitle>
            <DialogDescription>
              {t('sidebarFilesTree.dialog.uploadConflicts.description', { path: uploadConflicts?.directory ?? '' })}
            </DialogDescription>
          </DialogHeader>
          <ScrollableOverlay outerClassName="max-h-52" className="flex flex-col gap-1 pr-2">
            {uploadConflicts?.files.map((file, index) => (
              <div key={`${file.name}-${file.size}-${index}`} className="truncate rounded-md bg-muted px-2 py-1 typography-meta" title={file.name}>
                {file.name}
              </div>
            ))}
          </ScrollableOverlay>
          <DialogFooter>
            <Button variant="outline" onClick={() => setUploadConflicts(null)} disabled={uploadingDirectory !== null}>
              {t('sidebarFilesTree.dialog.cancel')}
            </Button>
            <Button
              onClick={() => {
                if (!uploadConflicts) return;
                if (uploadConflicts.runtimeKey !== getRuntimeKey() || uploadConflicts.workspaceRoot !== root) {
                  setUploadConflicts(null);
                  return;
                }
                void uploadFiles(uploadConflicts.directory, uploadConflicts.files, true);
              }}
              disabled={uploadingDirectory !== null}
            >
              {t('sidebarFilesTree.dialog.uploadConflicts.replace')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );

  return {
    canUpload: Boolean(uploadFile),
    uploadingDirectory,
    uploadFiles,
    pickFiles,
    uploadElements,
  };
};
