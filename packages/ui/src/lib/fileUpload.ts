import type { FilesAPI } from '@/lib/api/types';
import { isBinaryFile, isTextFile } from '@/lib/fileHelpers';
import { getFriendlyUploadErrorMessage, getUploadPreflightError } from '@/lib/fileUploadGuards';

export type UploadProgressUpdate = {
  phase: 'reading' | 'writing';
  progress: number;
};

export type UploadAttemptResult =
  | { success: true; sizeBytes?: number }
  | { success: false; error: string };

const clampProgress = (progress: number): number => {
  if (!Number.isFinite(progress)) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.round(progress)));
};

const readFileForFallbackWrite = (
  file: File,
  readAsText: boolean,
  onProgress?: (update: UploadProgressUpdate) => void,
): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => {
      reject(reader.error ?? new Error('Failed to read file'));
    };

    reader.onprogress = (event) => {
      if (!event.lengthComputable || event.total <= 0) {
        return;
      }

      const progress = clampProgress((event.loaded / event.total) * 100);
      onProgress?.({ phase: 'reading', progress });
    };

    if (readAsText) {
      reader.onload = () => {
        onProgress?.({ phase: 'reading', progress: 100 });
        resolve(typeof reader.result === 'string' ? reader.result : '');
      };
      reader.readAsText(file);
      return;
    }

    reader.onload = () => {
      onProgress?.({ phase: 'reading', progress: 100 });
      const dataUrl = typeof reader.result === 'string' ? reader.result : '';
      const commaIndex = dataUrl.indexOf(',');
      resolve(commaIndex >= 0 ? dataUrl.slice(commaIndex + 1) : dataUrl);
    };
    reader.readAsDataURL(file);
  });
};

export const uploadFileWithFallback = async ({
  files,
  file,
  targetDir,
  normalizePath,
  onProgress,
}: {
  files: Pick<FilesAPI, 'uploadFile' | 'writeFile'>;
  file: File;
  targetDir: string;
  normalizePath: (value: string) => string;
  onProgress?: (update: UploadProgressUpdate) => void;
}): Promise<UploadAttemptResult> => {
  if (!files.uploadFile && !files.writeFile) {
    return { success: false, error: 'File upload not supported' };
  }

  const filePath = normalizePath(`${targetDir}/${file.name}`);
  const supportsStreamingUpload = Boolean(files.uploadFile);
  const shouldUseTextFallback = isTextFile(file.name);
  const preflightError = getUploadPreflightError({
    fileName: file.name,
    sizeBytes: file.size,
    isBinary: supportsStreamingUpload ? isBinaryFile(file.name) : !shouldUseTextFallback,
    supportsStreamingUpload,
  });

  if (preflightError) {
    return { success: false, error: preflightError };
  }

  try {
    if (files.uploadFile) {
      const uploadResult = await files.uploadFile(filePath, file, {
        expectedSizeBytes: file.size,
        onProgress: ({ loadedBytes, totalBytes }) => {
          const denominator = totalBytes > 0 ? totalBytes : file.size;
          const progress = denominator > 0 ? clampProgress((loadedBytes / denominator) * 100) : 0;
          onProgress?.({ phase: progress >= 100 ? 'writing' : 'reading', progress });
        },
      });

      onProgress?.({ phase: 'writing', progress: 100 });

      if (!uploadResult.success) {
        return { success: false, error: 'Upload failed' };
      }

      if (typeof uploadResult.sizeBytes === 'number' && uploadResult.sizeBytes !== file.size) {
        return {
          success: false,
          error: `Uploaded size mismatch: expected ${file.size} bytes but wrote ${uploadResult.sizeBytes} bytes`,
        };
      }

      return { success: true, sizeBytes: uploadResult.sizeBytes };
    }

    if (!files.writeFile) {
      return { success: false, error: 'File upload not supported' };
    }

    const content = await readFileForFallbackWrite(file, shouldUseTextFallback, onProgress);
    onProgress?.({ phase: 'writing', progress: 100 });

    const writeResult = await files.writeFile(filePath, content, {
      encoding: shouldUseTextFallback ? 'utf8' : 'base64',
      expectedSizeBytes: file.size,
    });

    if (!writeResult.success) {
      return { success: false, error: 'Upload failed' };
    }

    if (typeof writeResult.sizeBytes === 'number' && writeResult.sizeBytes !== file.size) {
      return {
        success: false,
        error: `Uploaded size mismatch: expected ${file.size} bytes but wrote ${writeResult.sizeBytes} bytes`,
      };
    }

    return { success: true, sizeBytes: writeResult.sizeBytes };
  } catch (error) {
    return { success: false, error: getFriendlyUploadErrorMessage(error) };
  }
};
