import { isTauriShell } from '@/lib/desktop';
import { invoke } from '@tauri-apps/api/core';

type DesktopReadFileResult = {
  mime?: string;
  base64?: string;
};

const FILE_URL_PREFIX = /^file:\/\//i;

const decodeBase64ToUint8Array = (base64: string): Uint8Array => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
};

export const normalizeDesktopDroppedPath = (rawPath: string): string => {
  const input = rawPath.trim();
  if (!FILE_URL_PREFIX.test(input)) {
    return input;
  }

  try {
    let pathname = decodeURIComponent(new URL(input).pathname || '');
    if (/^\/[A-Za-z]:\//.test(pathname)) {
      pathname = pathname.slice(1);
    }
    return pathname || input;
  } catch {
    const stripped = input.replace(FILE_URL_PREFIX, '');
    try {
      return decodeURIComponent(stripped);
    } catch {
      return stripped;
    }
  }
};

export const collectDesktopDroppedPaths = (paths: unknown): string[] => {
  if (!Array.isArray(paths)) {
    return [];
  }

  return paths
    .filter((candidate): candidate is string => typeof candidate === 'string')
    .map((candidate) => candidate.trim())
    .filter((candidate) => candidate.length > 0);
};

export const readDesktopDroppedFile = async (rawPath: string): Promise<{ file: File; path: string }> => {
  const normalizedPath = normalizeDesktopDroppedPath(rawPath);
  const fileName = normalizedPath.split(/[\\/]/).pop() || normalizedPath || 'file';

  if (isTauriShell()) {
    const result = await invoke<DesktopReadFileResult>('desktop_read_file', { path: normalizedPath });
    const mime = typeof result?.mime === 'string' && result.mime.length > 0
      ? result.mime
      : 'application/octet-stream';
    const base64 = typeof result?.base64 === 'string' ? result.base64 : '';

    if (!base64) {
      throw new Error('Dropped file payload is empty');
    }

    const bytes = decodeBase64ToUint8Array(base64);
    const blob = new Blob([bytes], { type: mime });
    return {
      file: new File([blob], fileName, { type: mime }),
      path: normalizedPath,
    };
  }

  const response = await fetch(`/api/fs/raw?path=${encodeURIComponent(normalizedPath)}`);
  if (!response.ok) {
    throw new Error(`Failed to read dropped file (${response.status})`);
  }

  const blob = await response.blob();
  return {
    file: new File([blob], fileName, { type: blob.type || 'application/octet-stream' }),
    path: normalizedPath,
  };
};
