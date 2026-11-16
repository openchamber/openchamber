import type { FilesystemError } from '@/lib/api/files-errors';

export type UploadFailureReason = 'too-large' | 'permission' | 'outside-workspace' | 'folder-missing' | 'unknown';

export type UploadFailure = {
  /** The file's own name, shown as-is so the user knows which one failed. */
  name: string;
  reason: UploadFailureReason;
  /** Server-side limit, present when the file was rejected for its size. */
  limitBytes?: number;
};

/**
 * Why one upload failed, from the error the files API threw. A batch reports
 * each file separately, so the name travels with the reason.
 */
export const uploadFailureOf = (name: string, error: FilesystemError | null): UploadFailure => {
  if (!error) return { name, reason: 'unknown' };
  if (error.reason === 'too-large') return { name, reason: 'too-large', limitBytes: error.maxBytes };
  if (error.reason === 'os-permission') return { name, reason: 'permission' };
  if (error.reason === 'outside-workspace') return { name, reason: 'outside-workspace' };
  if (error.reason === 'not-found') return { name, reason: 'folder-missing' };
  return { name, reason: 'unknown' };
};
