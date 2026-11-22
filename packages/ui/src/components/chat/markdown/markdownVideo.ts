const VIDEO_FILE_RE = /\.(?:mp4|m4v|mov|webm)$/i;
const GITHUB_ASSET_RE = /^https:\/\/github\.com\/user-attachments\/assets\/[\w-]+$/i;
export const hasMarkdownMediaCredentials = (source: string): boolean => /[?&]oc_(?:url|client)_token=/i.test(source);
export const markdownMediaCopySource = (source: string): string => hasMarkdownMediaCredentials(source) ? '' : source;

export const markdownMediaFilename = (source: string, alt = ''): string => {
  if (/^data:/i.test(source)) return alt.trim() || `image.${/^data:image\/([^;,]+)/i.exec(source)?.[1]?.replace('jpeg', 'jpg') ?? 'png'}`;
  const name = source.split(/[?#]/, 1)[0]?.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) ?? alt;
  try { return decodeURIComponent(name); } catch { return name; }
};

const mediaFileName = (source: string): string => {
  const path = source.split(/[?#]/, 1)[0]?.replace(/\\/g, '/') ?? '';
  const encoded = path.split('/').filter(Boolean).at(-1) ?? '';
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
};

const isVideoFileName = (name: string): boolean => VIDEO_FILE_RE.test(name.trim());

export const isVideoSource = (source: string, name = ''): boolean => (
  isVideoFileName(name) || isVideoFileName(mediaFileName(source))
);

export const isBareVideoUrl = (url: string): boolean => (
  /^https?:\/\//i.test(url) && (GITHUB_ASSET_RE.test(url) || isVideoSource(url))
);
