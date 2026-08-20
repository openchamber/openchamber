import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAuthFile } from '../opencode/auth.js';
import { DEFAULT_VISION_PROMPT } from '../opencode/settings-helpers.js';
import { getModelCatalog } from '../small-model/catalog.js';
import { callSmallModel } from '../small-model/call.js';
import { OpenChamberControlError } from '../openchamber-control/error.js';

// Vision tool: lets models without image input "see" an image by calling a
// user-configured vision model directly (no child session). The configured
// model and prompt live in settings.vision; the image is read from disk,
// sniffed for its real mime type, capped in size, and sent as a data URL.

const MAX_VISION_IMAGE_BYTES = 20 * 1024 * 1024;
const VISION_MAX_OUTPUT_TOKENS = 2_000;
const VISION_REQUEST_TIMEOUT_MS = 120_000;
const MAX_VISION_RESULT_CHARS = 60_000;

// Extension can lie; the magic bytes are authoritative. The allowlist is the
// union of the officially documented vision input formats across the provider
// families this tool can call (OpenAI: PNG/JPEG/WebP/non-animated GIF,
// Anthropic: JPEG/PNG/GIF/WebP, Google: PNG/JPEG/WebP/HEIC/HEIF). BMP, AVIF,
// ICO, and SVG are refused — no major vision API documents them as supported
// (SVG can also carry scripts). A format a specific provider rejects anyway
// surfaces as that provider's own error.
const sniffImageMime = (buffer) => {
  if (buffer.length >= 8 && buffer.readUInt32BE(0) === 0x89504e47) return 'image/png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 6) {
    const header = buffer.toString('ascii', 0, 6);
    if (header === 'GIF87a' || header === 'GIF89a') return 'image/gif';
  }
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
};

const asNonEmptyString = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const splitModel = (value) => {
  const model = asNonEmptyString(value);
  if (!model) return null;
  const slashIndex = model.indexOf('/');
  if (slashIndex <= 0 || slashIndex === model.length - 1) return null;
  return { providerID: model.slice(0, slashIndex), modelID: model.slice(slashIndex + 1) };
};

const providerModels = (provider) => {
  if (Array.isArray(provider?.models)) return provider.models;
  if (provider?.models && typeof provider.models === 'object') return Object.values(provider.models);
  return [];
};

export const createVisionRuntime = (dependencies) => {
  const {
    readSettingsFromDiskMigrated,
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    statFile = (filePath) => fs.promises.stat(filePath),
    readFile = (filePath) => fs.promises.readFile(filePath),
  } = dependencies;

  const resolveImagePath = (rawPath, directory) => {
    const input = asNonEmptyString(rawPath);
    if (!input) throw new OpenChamberControlError('imagePath is required', 400);
    let candidate = input;
    if (candidate.startsWith('file://')) {
      candidate = fileURLToPath(candidate);
    } else if (candidate === '~' || candidate.startsWith('~/')) {
      candidate = path.join(os.homedir(), candidate.slice(2));
    }
    if (!path.isAbsolute(candidate)) {
      const base = asNonEmptyString(directory);
      if (!base) {
        throw new OpenChamberControlError('imagePath must be an absolute path when no directory context is available', 400);
      }
      candidate = path.resolve(base, candidate);
    }
    return candidate;
  };

  // A non-empty provider list is authoritative: the configured model must
  // exist and advertise image input. An empty list means the lookup failed or
  // returned nothing authoritative — it must not turn a valid selection into
  // a rejection (mirrors the fusion runner's fail-open rule).
  const validateConfiguredModel = async ({ model, directory }) => {
    const url = new URL(buildOpenCodeUrl('/config/providers', ''));
    url.searchParams.set('directory', directory);
    const response = await fetch(url.toString(), {
      headers: {
        ...getOpenCodeAuthHeaders(),
        ...(directory ? { 'x-opencode-directory': directory } : {}),
        accept: 'application/json',
      },
    });
    if (!response.ok) return;
    const body = await response.json().catch(() => null);
    const providers = Array.isArray(body?.providers) ? body.providers : [];
    if (providers.length === 0) return;
    const match = providers
      .filter((provider) => provider?.id === model.providerID)
      .flatMap(providerModels)
      .find((entry) => entry?.id === model.modelID);
    if (!match) {
      throw new OpenChamberControlError(
        `Configured vision model ${model.providerID}/${model.modelID} was not found for ${directory || 'this directory'} — it may be renamed, removed, or hidden`,
        400,
      );
    }
    if (match.capabilities?.input?.image !== true) {
      throw new OpenChamberControlError(
        `Configured vision model ${model.providerID}/${model.modelID} does not support image input — pick a vision-capable model in Settings → OpenChamber → Vision`,
        400,
      );
    }
  };

  const execute = async ({ imagePath, question, directory, signal }) => {
    const settings = await readSettingsFromDiskMigrated();
    const model = splitModel(settings?.vision?.model);
    if (!model) {
      throw new OpenChamberControlError(
        'No vision model configured — open Settings → OpenChamber → Vision and pick a vision-capable model',
        400,
      );
    }

    const resolvedPath = resolveImagePath(imagePath, directory);
    let stat;
    let buffer;
    try {
      stat = await statFile(resolvedPath);
      if (!stat.isFile()) {
        throw new OpenChamberControlError(`Image path is not a file: ${resolvedPath}`, 400);
      }
      if (stat.size > MAX_VISION_IMAGE_BYTES) {
        throw new OpenChamberControlError(
          `Image is larger than ${MAX_VISION_IMAGE_BYTES / 1024 / 1024} MB: ${resolvedPath}`,
          400,
        );
      }
      buffer = await readFile(resolvedPath);
    } catch (error) {
      if (error instanceof OpenChamberControlError) throw error;
      if (error?.code === 'ENOENT') {
        throw new OpenChamberControlError(`Image file not found: ${resolvedPath}`, 400);
      }
      throw new OpenChamberControlError(`Failed to read image: ${resolvedPath}`, 400);
    }

    const mime = sniffImageMime(buffer);
    if (!mime || buffer.length === 0) {
      throw new OpenChamberControlError(
        'Unsupported image type — provide a PNG, JPEG, GIF, or WebP file',
        400,
      );
    }

    await validateConfiguredModel({ model, directory });

    const configuredPrompt = settings.vision?.prompt ? settings.vision.prompt : DEFAULT_VISION_PROMPT;
    const extraQuestion = asNonEmptyString(question);
    const prompt = extraQuestion
      ? `${configuredPrompt}\n\nAnswer this additional question about the image:\n${extraQuestion}`
      : configuredPrompt;

    const catalog = await getModelCatalog().catch(() => ({}));
    const auth = readAuthFile();

    let text;
    try {
      text = await callSmallModel({
        auth,
        catalog,
        workingDirectory: asNonEmptyString(directory) || undefined,
        providerID: model.providerID,
        modelID: model.modelID,
        prompt,
        images: [{ mimeType: mime, base64: buffer.toString('base64') }],
        maxOutputTokens: VISION_MAX_OUTPUT_TOKENS,
        timeoutMs: VISION_REQUEST_TIMEOUT_MS,
        signal,
      });
    } catch (error) {
      if (signal?.aborted) throw new OpenChamberControlError('OpenChamber action was cancelled', 499);
      throw error;
    }

    const truncated = text.length > MAX_VISION_RESULT_CHARS;
    return {
      description: truncated ? `${text.slice(0, MAX_VISION_RESULT_CHARS)}\n… (truncated)` : text,
      truncated,
      model: `${model.providerID}/${model.modelID}`,
      providerID: model.providerID,
      modelID: model.modelID,
      imagePath: resolvedPath,
      imageFilename: path.basename(resolvedPath),
      imageMime: mime,
      imageSize: stat.size,
      ...(extraQuestion ? { question: extraQuestion } : {}),
    };
  };

  return { execute };
};
