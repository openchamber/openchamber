import type { FilesystemError } from '@/lib/api/files-errors';

export type UploadFailureReason = 'too-large' | 'permission' | 'outside-workspace' | 'folder-missing' | 'unknown';

export type UploadFailure = {
  name: string;
  reason: UploadFailureReason;
  limitBytes?: number;
};

export const uploadFailureOf = (name: string, error: FilesystemError | null): UploadFailure => {
  if (!error) return { name, reason: 'unknown' };
  if (error.reason === 'too-large') return { name, reason: 'too-large', limitBytes: error.maxBytes };
  if (error.reason === 'os-permission') return { name, reason: 'permission' };
  if (error.reason === 'outside-workspace') return { name, reason: 'outside-workspace' };
  if (error.reason === 'not-found') return { name, reason: 'folder-missing' };
  return { name, reason: 'unknown' };
};
