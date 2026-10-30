import { toast } from '@/components/ui';
import type { FilesAPI } from '@/lib/api/types';
import { MAX_OPEN_FILE_BYTES, MAX_OPEN_FILE_LINES, countLinesWithLimit } from '@/lib/fileOpenLimits';
import { formatFileSize } from '@/lib/fileSize';
import { getCurrentIntlLocale } from '@/lib/i18n';
import { formatMessage, useI18nStore } from '@/lib/i18n/store';
import { isFilePathWithinDirectory } from '@/lib/path-utils';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { isBinaryFile, isImageFile, isPdfFile, looksLikeBinaryText } from '@/lib/toolHelpers';

const t = (key: Parameters<typeof formatMessage>[1], params?: Parameters<typeof formatMessage>[2]) =>
  formatMessage(useI18nStore.getState().dictionary, key, params);

const READ_FAILED_FALLBACK = 'Failed to read file';

type ContextFileOpenFailure =
  | { reason: 'too-large'; sizeBytes: number }
  | { reason: 'too-large-size'; sizeBytes: number }
  | { reason: 'missing' }
  | { reason: 'unreadable'; message: string | null }
  | { reason: 'binary' };

type ContextFileOpenValidationResult = { ok: true } | ({ ok: false } & ContextFileOpenFailure);

type ContextFileOpenOptions = {
  directory?: string;
};

const classifyReadError = (error: unknown): ContextFileOpenFailure => {
  const message = error instanceof Error ? error.message : String(error ?? '');
  const normalized = message.toLowerCase();

  if (
    normalized.includes('file not found')
    || normalized.includes('not found')
    || normalized.includes('enoent')
    || normalized.includes('no such file')
    || normalized.includes('does not exist')
  ) {
    return { reason: 'missing' };
  }

  // The server's own reason (a permission error, say) tells the user more than the fallback.
  const reason = message.trim();
  return { reason: 'unreadable', message: reason && reason !== READ_FAILED_FALLBACK ? reason : null };
};

// A referenced file outside the active workspace (a skill, an agent output
// under /tmp) is a legitimate read. Without the flag the server rejects it
// and the caller reports the file as unreadable.
const isOutsideWorkspace = (path: string, options?: ContextFileOpenOptions): boolean => (
  Boolean(options?.directory && !isFilePathWithinDirectory(path, options.directory))
);

// Null when the runtime has no metadata route or the stat fails: the read
// below then reports the failure.
const readFileSize = async (
  files: FilesAPI,
  path: string,
  options?: ContextFileOpenOptions,
): Promise<number | null> => {
  if (!files.statFile) return null;
  try {
    const stat = await files.statFile(path, {
      directory: options?.directory,
      allowOutsideWorkspace: isOutsideWorkspace(path, options),
    });
    return stat.size;
  } catch {
    return null;
  }
};

const readFileContent = async (
  files: FilesAPI,
  path: string,
  options?: ContextFileOpenOptions,
): Promise<string> => {
  const allowOutsideWorkspace = isOutsideWorkspace(path, options);
  if (files.readFile) {
    const result = await files.readFile(path, {
      optional: true,
      directory: options?.directory,
      allowOutsideWorkspace,
    });
    return result.content ?? '';
  }

  const params = new URLSearchParams({ path, optional: 'true' });
  if (options?.directory) {
    params.set('directory', options.directory);
  }
  if (allowOutsideWorkspace) {
    params.set('allowOutsideWorkspace', 'true');
  }
  const response = await runtimeFetch(`/api/fs/read?${params.toString()}`, {
    // Avoid conditional requests (304 + empty body).
    cache: 'no-store',
    headers: options?.directory ? { 'x-opencode-directory': options.directory } : undefined,
  });
  if (!response.ok) {
    const errorPayload = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error((errorPayload as { error?: string }).error || READ_FAILED_FALLBACK);
  }

  return response.text();
};

/**
 * Validate whether a context-panel click may open a path in the shared file editor.
 * Previewable/non-text binaries are allowed through so FilesView can show image/PDF
 * preview or the cannot-preview empty state — never by decoding them as editable text here.
 */
export const validateContextFileOpen = async (
  files: FilesAPI,
  path: string,
  options?: ContextFileOpenOptions,
): Promise<ContextFileOpenValidationResult> => {
  if (isBinaryFile(path) || isPdfFile(path) || isImageFile(path)) {
    return { ok: true };
  }

  // Refused by its size, before a read that would pull the whole file in.
  const size = await readFileSize(files, path, options);
  if (size !== null && size > MAX_OPEN_FILE_BYTES) {
    return { ok: false, reason: 'too-large-size', sizeBytes: size };
  }

  try {
    const content = await readFileContent(files, path, options);
    if (looksLikeBinaryText(content)) {
      return { ok: false, reason: 'binary' };
    }
    const lineCount = countLinesWithLimit(content, MAX_OPEN_FILE_LINES);
    if (lineCount > MAX_OPEN_FILE_LINES) {
      return { ok: false, reason: 'too-large', sizeBytes: new Blob([content]).size };
    }

    return { ok: true };
  } catch (error) {
    return { ok: false, ...classifyReadError(error) };
  }
};

export const getContextFileSizeLimitMessage = (sizeBytes: number, translate: typeof t): string =>
  translate('contextFileOpen.failure.tooLargeSize', {
    limit: formatFileSize(MAX_OPEN_FILE_BYTES),
    size: formatFileSize(sizeBytes),
  });

export const toastContextFileOpenFailure = (path: string, failure: ContextFileOpenFailure): void => {
  const name = path.split(/[\\/]/).filter(Boolean).pop() ?? path;
  switch (failure.reason) {
    case 'too-large': {
      const count = MAX_OPEN_FILE_LINES.toLocaleString(getCurrentIntlLocale());
      toast.error(t('contextFileOpen.failure.tooLarge', { name }), {
        description: t('contextFileOpen.failure.tooLargeDetail', { count, size: formatFileSize(failure.sizeBytes) }),
      });
      return;
    }
    case 'too-large-size':
      toast.error(t('contextFileOpen.failure.tooLarge', { name }), {
        description: getContextFileSizeLimitMessage(failure.sizeBytes, t),
      });
      return;
    case 'missing':
      toast.error(t('contextFileOpen.failure.missing', { name }));
      return;
    case 'binary':
      toast.error(t('filesView.editor.cannotPreviewBinary'));
      return;
    case 'unreadable':
      toast.error(t('contextFileOpen.failure.unreadable', { name }), failure.message ? { description: failure.message } : undefined);
  }
};
