import type { FilesAPI } from '@/lib/api/types';
import { MAX_OPEN_FILE_LINES, countLinesWithLimit } from '@/lib/fileOpenLimits';
import { getCurrentIntlLocale } from '@/lib/i18n';
import { formatMessage, useI18nStore } from '@/lib/i18n/store';

const t = (key: Parameters<typeof formatMessage>[1], params?: Parameters<typeof formatMessage>[2]) =>
  formatMessage(useI18nStore.getState().dictionary, key, params);

export type ContextFileOpenFailureReason = 'too-large' | 'missing' | 'unreadable';

export type ContextFileOpenValidationResult =
  | { ok: true }
  | { ok: false; reason: ContextFileOpenFailureReason };

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

const readFileContent = async (files: FilesAPI, path: string): Promise<string> => {
  if (files.readFile) {
    const result = await files.readFile(path, { allowOutsideWorkspace: true, optional: true });
    return result.content ?? '';
  }

  const params = new URLSearchParams({ path, allowOutsideWorkspace: 'true', optional: 'true' });
  const response = await fetch(`/api/fs/read?${params.toString()}`, {
    // Avoid conditional requests (304 + empty body).
    cache: 'no-store',
  });
  if (!response.ok) {
    const errorPayload = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error((errorPayload as { error?: string }).error || 'Failed to read file');
  }

  return response.text();
};

export const validateContextFileOpen = async (files: FilesAPI, path: string): Promise<ContextFileOpenValidationResult> => {
  try {
    const content = await readFileContent(files, path);
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

  return t('contextFileOpen.failure.unreadable');
};
