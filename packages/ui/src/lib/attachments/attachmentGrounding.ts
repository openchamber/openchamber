/**
 * Attachment grounding — capability-aware attachment routing.
 *
 * Providers reject whole messages when a file part's media type is not
 * supported by the selected model ("file part media type ... functionality not
 * supported"): spreadsheets and archives are never accepted, and text-only
 * models (e.g. DeepSeek) reject even images. Instead of forwarding blindly,
 * attachments the current model cannot ingest are saved into an `uploads/`
 * folder inside the session working directory and replaced with a synthetic
 * text part that tells the agent where the file is, so it can read the file
 * with its own tools.
 *
 * Grounding is strictly opt-out-by-capability: a media type is passed through
 * only when the model's metadata explicitly declares support for it. When the
 * workspace write fails (e.g. a runtime without the fs API), the original file
 * part is passed through unchanged — behavior is then no worse than before.
 */
import { runtimeFetch } from '@/lib/runtime-fetch';

export type GroundableFile = { id?: string; type: 'file'; mime: string; url: string; filename?: string };

export type GroundedAttachments = {
  /** Files the model accepts natively — send as file parts. */
  direct: GroundableFile[];
  /** Agent-facing hints for grounded files — send as synthetic text parts. */
  hints: string[];
};

const UPLOADS_DIR = 'uploads';
/** /api/fs JSON body limit is 50mb — leave headroom for base64 + envelope. */
const MAX_GROUNDABLE_BYTES = 30 * 1024 * 1024;

const normalizeMime = (mime: string): string => (mime || '').toLowerCase().split(';')[0].trim();

const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown size';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

/**
 * Whether the selected model natively accepts a file part of this media type.
 * text/plain always passes: the OpenCode server inlines it as a text part
 * before the provider sees it. Images/PDF require an explicit declaration in
 * the model metadata (modalities.input, falling back to the coarse
 * `attachment` flag). Everything else is never provider-ingestible.
 */
export async function modelAcceptsAttachmentMime(
  mime: string,
  providerID: string,
  modelID: string,
): Promise<boolean> {
  const normalized = normalizeMime(mime);
  if (normalized === 'text/plain' || normalized === 'application/x-directory') return true;
  const isImage = normalized.startsWith('image/');
  const isPdf = normalized === 'application/pdf';
  if (!isImage && !isPdf) return false;
  // Dynamic import keeps this transport-adjacent module out of the
  // client ⇄ config-store import cycle.
  const { useConfigStore } = await import('@/stores/useConfigStore');
  const metadata = useConfigStore.getState().getModelMetadata(providerID, modelID);
  const input = metadata?.modalities?.input;
  if (Array.isArray(input) && input.length > 0) {
    return input.includes(isImage ? 'image' : 'pdf');
  }
  return metadata?.attachment === true;
}

const sanitizeFilename = (filename: string | undefined): string => {
  const base = (filename || '').split(/[\\/]/).pop() || '';
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f<>:"|?*]/g, '').trim();
  return cleaned || 'attachment';
};

const splitDataUrl = (url: string): { base64: string; bytes: number } | null => {
  if (!url.startsWith('data:')) return null;
  const commaIndex = url.indexOf(',');
  if (commaIndex < 0) return null;
  const metadata = url.slice(0, commaIndex).toLowerCase();
  const payload = url.slice(commaIndex + 1);
  if (!metadata.endsWith(';base64')) return null;
  let padding = 0;
  if (payload.endsWith('==')) padding = 2;
  else if (payload.endsWith('=')) padding = 1;
  return { base64: payload, bytes: Math.max(0, Math.floor((payload.length * 3) / 4) - padding) };
};

// Directory rides the query string, not the x-opencode-directory header:
// header-based scoping is dropped by relay/remote transports, query survives
// every path (resolveProjectDirectory reads both).
const directoryQuery = (directory: string | null | undefined, lead: '?' | '&'): string =>
  directory ? `${lead}directory=${encodeURIComponent(directory)}` : '';

const pathExists = async (relativePath: string, directory: string | null | undefined): Promise<boolean> => {
  try {
    const res = await runtimeFetch(
      `/api/fs/stat?path=${encodeURIComponent(relativePath)}${directoryQuery(directory, '&')}`,
    );
    return res.ok;
  } catch {
    return false;
  }
};

const pickUploadPath = async (
  filename: string,
  directory: string | null | undefined,
): Promise<string> => {
  const safe = sanitizeFilename(filename);
  const candidate = `${UPLOADS_DIR}/${safe}`;
  if (!(await pathExists(candidate, directory))) return candidate;
  const dot = safe.lastIndexOf('.');
  const stem = dot > 0 ? safe.slice(0, dot) : safe;
  const ext = dot > 0 ? safe.slice(dot) : '';
  return `${UPLOADS_DIR}/${stem}-${Date.now()}${ext}`;
};

const buildSavedHint = (filename: string, mime: string, bytes: number, relativePath: string): string =>
  `[Attachment saved to workspace] The user attached "${filename}" (${mime}, ${formatBytes(bytes)}). `
  + `The current model cannot ingest this file type directly, so it was saved to ${relativePath} `
  + `in the working directory. Read it from there with local tools (e.g. Python) when you need its contents.`;

const buildOnDiskHint = (filename: string, mime: string, absolutePath: string): string =>
  `[Attachment on disk] The user attached "${filename}" (${mime}) located at ${absolutePath}. `
  + `The current model cannot ingest this file type directly. Read it from there with local tools `
  + `(e.g. Python) when you need its contents.`;

const groundOne = async (
  file: GroundableFile,
  directory: string | null | undefined,
): Promise<{ hint: string } | { passthrough: true }> => {
  const filename = sanitizeFilename(file.filename);
  const mime = normalizeMime(file.mime) || 'application/octet-stream';

  if (file.url.startsWith('file://')) {
    // Already on disk (server-source attachment) — no copy needed.
    let absolutePath = file.url.slice('file://'.length);
    try {
      absolutePath = decodeURIComponent(absolutePath);
    } catch {
      // keep raw path
    }
    return { hint: buildOnDiskHint(filename, mime, absolutePath) };
  }

  const data = splitDataUrl(file.url);
  if (!data || data.bytes > MAX_GROUNDABLE_BYTES) return { passthrough: true };

  try {
    const relativePath = await pickUploadPath(filename, directory);
    const res = await runtimeFetch(`/api/fs/write${directoryQuery(directory, '?')}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: relativePath, content: data.base64, encoding: 'base64' }),
    });
    if (!res.ok) return { passthrough: true };
    return { hint: buildSavedHint(filename, mime, data.bytes, relativePath) };
  } catch {
    return { passthrough: true };
  }
};

/**
 * Split attachments into model-ingestible file parts and grounded hints.
 * Never throws; on any grounding failure the file passes through unchanged.
 */
export async function groundAttachmentsForModel(input: {
  files: GroundableFile[];
  providerID: string;
  modelID: string;
  directory?: string | null;
}): Promise<GroundedAttachments> {
  const direct: GroundableFile[] = [];
  const hints: string[] = [];
  for (const file of input.files) {
    if (await modelAcceptsAttachmentMime(file.mime, input.providerID, input.modelID)) {
      direct.push(file);
      continue;
    }
    const result = await groundOne(file, input.directory);
    if ('hint' in result) {
      hints.push(result.hint);
    } else {
      direct.push(file);
    }
  }
  return { direct, hints };
}
