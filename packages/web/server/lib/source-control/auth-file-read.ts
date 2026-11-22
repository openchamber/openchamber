// Reads the source-control auth file. A fork module: upstream reads it whole.
import fs from 'node:fs/promises';
import { readBoundedFile } from '../shared/bounded-file-read.js';
import { hasSourceControlErrorCode } from './input-guards.js';

const AUTH_FILE_MAX_BYTES = 1_048_576;

/**
 * The auth file's text, or null when there is none. Bounded: a FIFO or an
 * oversized file at this path is refused, through `invalid`, instead of read
 * whole. An injected fs is read as it is.
 */
export const readAuthFileText = async (filePath: string, fsImpl: typeof fs, invalid: (cause: Error) => Error): Promise<string | null> => {
  if (fsImpl !== fs) {
    try {
      return await fsImpl.readFile(filePath, 'utf8');
    } catch (error) {
      if (hasSourceControlErrorCode(error) && error.code === 'ENOENT') return null;
      throw error;
    }
  }
  const result = await readBoundedFile(filePath, AUTH_FILE_MAX_BYTES);
  if (result.ok) return result.buffer.toString('utf8');
  if (result.reason === 'missing') return null;
  if (result.reason === 'not-regular') throw invalid(new Error('Auth file is not a regular file', { cause: result }));
  if (result.reason === 'too-large') throw invalid(new Error('Auth file exceeds size limit', { cause: result }));
  throw invalid(new Error('Failed to read auth file', { cause: result }));
};
