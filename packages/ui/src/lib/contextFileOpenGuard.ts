import type { FilesAPI } from '@/lib/api/types';
import { MAX_OPEN_FILE_LINES, countLinesWithLimit } from '@/lib/fileOpenLimits';
import { getCurrentIntlLocale } from '@/lib/i18n';
import { formatMessage, useI18nStore } from '@/lib/i18n/store';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { isBinaryFile, isImageFile, isPdfFile, looksLikeBinaryText } from '@/lib/toolHelpers';

const t = (key: Parameters<typeof formatMessage>[1], params?: Parameters<typeof formatMessage>[2]) =>
  formatMessage(useI18nStore.getState().dictionary, key, params);

export type ContextFileOpenFailureReason = 'too-large' | 'missing' | 'unreadable' | 'binary';

export type ContextFileOpenValidationResult =
  | { ok: true }
  | { ok: false; reason: ContextFileOpenFailureReason };

export type ContextFileOpenOptions = {
  directory?: string;
};

const classifyReadError = (error: unknown): ContextFileOpenFailureReason => {
  const message = error instanceof Error ? error.message : String(error ?? '');
  const normalized = message.toLowerCase();

  if (
    normalized.includes('file not found')
    || normalized.includes('not found')
    || normalized.includes('enoent')
    || normalized.includes('no such file')
    || normalized.includes('does not exist')
  ) {
    return 'missing';
  }

  return 'unreadable';
};

const readFileContent = async (
  files: FilesAPI,
  path: string,
  options?: ContextFileOpenOptions,
): Promise<string> => {
  if (files.readFile) {
    const result = await files.readFile(path, {
      optional: true,
      directory: options?.directory,
    });
    return result.content ?? '';
  }

  const params = new URLSearchParams({ path, optional: 'true' });
  if (options?.directory) {
    params.set('directory', options.directory);
  }
  const response = await runtimeFetch(`/api/fs/read?${params.toString()}`, {
    // Avoid conditional requests (304 + empty body).
    cache: 'no-store',
    headers: options?.directory ? { 'x-opencode-directory': options.directory } : undefined,
  });
  if (!response.ok) {
    const errorPayload = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error((errorPayload as { error?: string }).error || 'Failed to read file');
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

  try {
    const content = await readFileContent(files, path, options);
    if (looksLikeBinaryText(content)) {
      return { ok: false, reason: 'binary' };
    }
    const lineCount = countLinesWithLimit(content, MAX_OPEN_FILE_LINES);
    if (lineCount > MAX_OPEN_FILE_LINES) {
      return { ok: false, reason: 'too-large' };
    }

    return { ok: true };
  } catch (error) {
    return { ok: false, reason: classifyReadError(error) };
  }
};

export const getContextFileOpenFailureMessage = (reason: ContextFileOpenFailureReason): string => {
  if (reason === 'too-large') {
    const lines = MAX_OPEN_FILE_LINES.toLocaleString(getCurrentIntlLocale());
    return t('contextFileOpen.failure.tooLarge', { count: lines });
  }

  if (reason === 'missing') {
    return t('contextFileOpen.failure.missing');
  }

  if (reason === 'binary') {
    return t('filesView.editor.cannotPreviewBinary');
  }

  return t('contextFileOpen.failure.unreadable');
};
