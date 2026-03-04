const MEBIBYTE = 1024 * 1024;

export const CLOUDFLARE_TUNNEL_MAX_UPLOAD_BYTES = 100 * MEBIBYTE;
const WRITE_FALLBACK_SAFE_TEXT_BYTES = 45 * MEBIBYTE;
const WRITE_FALLBACK_SAFE_BINARY_BYTES = 35 * MEBIBYTE;

const formatMiB = (bytes: number): string => `${(bytes / MEBIBYTE).toFixed(0)} MB`;

export const isLikelyCloudflareQuickTunnelHost = (): boolean => {
  if (typeof window === 'undefined') {
    return false;
  }

  const hostname = window.location.hostname.toLowerCase();
  return hostname.endsWith('.trycloudflare.com');
};

export const getUploadPreflightError = ({
  fileName,
  sizeBytes,
  isBinary,
  supportsStreamingUpload,
}: {
  fileName: string;
  sizeBytes: number;
  isBinary: boolean;
  supportsStreamingUpload: boolean;
}): string | null => {
  if (supportsStreamingUpload) {
    if (isLikelyCloudflareQuickTunnelHost() && sizeBytes > CLOUDFLARE_TUNNEL_MAX_UPLOAD_BYTES) {
      return `"${fileName}" is ${formatMiB(sizeBytes)}. Cloudflare tunnel uploads are limited to ${formatMiB(CLOUDFLARE_TUNNEL_MAX_UPLOAD_BYTES)} on this route.`;
    }
    return null;
  }

  const fallbackLimit = isBinary ? WRITE_FALLBACK_SAFE_BINARY_BYTES : WRITE_FALLBACK_SAFE_TEXT_BYTES;
  if (sizeBytes > fallbackLimit) {
    return `"${fileName}" is ${formatMiB(sizeBytes)}. This runtime uses JSON upload fallback with a practical limit around ${formatMiB(fallbackLimit)} for ${isBinary ? 'binary' : 'text'} files.`;
  }

  return null;
};

export const getFriendlyUploadErrorMessage = (error: unknown): string => {
  if (!(error instanceof Error)) {
    return 'Upload failed';
  }

  const message = error.message || '';
  const normalized = message.toLowerCase();

  if (
    normalized.includes('413') ||
    normalized.includes('payload too large') ||
    normalized.includes('entity too large') ||
    normalized.includes('request payload is too large') ||
    normalized.includes('upload payload is too large')
  ) {
    return 'Upload failed: file is larger than the current server/proxy limit';
  }

  if (normalized.includes('uploaded size mismatch') || normalized.includes('size mismatch')) {
    return message;
  }

  if (normalized.includes('interrupted before completion')) {
    return 'Upload failed: connection interrupted before completion';
  }

  return message;
};
