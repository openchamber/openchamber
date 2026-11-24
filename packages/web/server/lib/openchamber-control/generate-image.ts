
import { constants as fsConstants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { z } from 'zod';

import { asNonEmptyString } from '../shared/guards.js';
import { OpenChamberControlError, controlErrorFields } from './error.js';
import type fs from 'node:fs/promises';
import type { OpenCode, ExperimentalGenerateImageInput } from '@opencode/client';
import type { ActionContext, ControlInput } from './contracts.js';

export interface ImageSettings {
  agentImageToolEnabled?: unknown;
  agentImageModel?: unknown;
}

export interface ImageGenerationDependencies {
  getClient: () => Promise<Pick<ReturnType<typeof OpenCode.make>, 'experimental'>>;
  readSettings: () => Promise<ImageSettings | null>;
  fsPromises: typeof fs;
  now?: () => Date;
  catalogRetryDelaysMs?: readonly number[];
}

export interface GeneratedImages {
  model: string;
  images: { path: string; mime: string }[];
  cost?: number;
}

export const GENERATED_IMAGE_DIRECTORY = path.join(os.tmpdir(), 'opencode', 'generated-images');

const MAX_PROMPT_LENGTH = 8_000;
const MAX_SOURCE_IMAGES = 8;
const MAX_SOURCE_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_COUNT = 4;
const GENERATION_TIMEOUT_MS = 5 * 60 * 1000;
// external: https://github.com/anomalyco/opencode/blob/v2.4.1/packages/server/src/handlers/generate.ts Generation runs in OpenCode's global config location, which answers before its plugins load since 2.4.0, so a cold one does not know the model yet.
const CATALOG_RETRY_DELAYS_MS = [500, 1_000, 2_000, 4_000];

const countSchema = z.union([z.number(), z.string().regex(/^\d+$/).transform(Number)])
  .pipe(z.number().int().min(1).max(MAX_COUNT));
const sourcesSchema = z.union([z.string().transform((source) => [source]), z.array(z.string())])
  .pipe(z.array(z.string().trim().min(1)).max(MAX_SOURCE_IMAGES));

const isAspect = (value: string): value is `${number}:${number}` => /^\d+(?:\.\d+)?:\d+(?:\.\d+)?$/.test(value);
const isFiniteCost = (value: unknown): value is number => Number.isFinite(value);

interface ImageExtensions {
  readonly [mime: string]: string;
}

const EXTENSION_BY_MIME: ImageExtensions = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

type ImageRequest = { -readonly [Key in keyof ExperimentalGenerateImageInput]: ExperimentalGenerateImageInput[Key] };

const sniffImageMime = (bytes: Buffer) => {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes.subarray(1, 4).toString('ascii') === 'PNG') return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  const header = bytes.subarray(0, 12).toString('ascii');
  if (header.startsWith('GIF87a') || header.startsWith('GIF89a')) return 'image/gif';
  if (header.startsWith('RIFF') && header.slice(8, 12) === 'WEBP') return 'image/webp';
  return null;
};

const resolvePath = (value: string, directory: string | null) => {
  if (path.isAbsolute(value)) return value;
  if (!directory) throw new OpenChamberControlError(`${value} is relative and the session has no directory; pass an absolute path`, 400);
  return path.resolve(directory, value);
};

const readSourceImage = async (fsPromises: typeof fs, value: string, directory: string | null) => {
  const file = resolvePath(value, directory);
  let handle;
  try {
    handle = await fsPromises.open(file, fsConstants.O_RDONLY);
  } catch (error) {
    throw new OpenChamberControlError(
      controlErrorFields(error)?.code === 'ENOENT' ? `Image not found: ${file}` : `Could not read ${file}: ${controlErrorFields(error)?.message ?? error}`,
      400,
    );
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new OpenChamberControlError(`Not a file: ${file}`, 400);
    if (stats.size > MAX_SOURCE_IMAGE_BYTES) throw new OpenChamberControlError(`${file} is larger than 10 MB`, 400);
    const bytes = await handle.readFile();
    const mime = sniffImageMime(bytes);
    if (!mime) throw new OpenChamberControlError(`${file} is not a PNG, JPEG, GIF or WebP image`, 400);
    return { data: bytes.toString('base64'), mime, name: path.basename(file) };
  } finally {
    await handle.close();
  }
};

const pad = (value: number, length = 2) => String(value).padStart(length, '0');

const stamp = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  + `T${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}-${pad(date.getMilliseconds(), 3)}`;

const targetPath = ({ requested, directory, index, count, mime, now }: {
  requested: string | null; directory: string | null; index: number; count: number; mime: string; now: Date;
}) => {
  const extension = EXTENSION_BY_MIME[mime] ?? 'png';
  if (!requested) {
    const suffix = count > 1 ? `-${index + 1}` : '';
    return path.join(GENERATED_IMAGE_DIRECTORY, `image-${stamp(now)}${suffix}.${extension}`);
  }
  const resolved = resolvePath(requested, directory);
  const parsed = path.parse(resolved);
  const ext = parsed.ext || `.${extension}`;
  const suffix = index > 0 ? `-${index + 1}` : '';
  return path.join(parsed.dir, `${parsed.name}${suffix}${ext}`);
};

const toControlError = (cause: unknown, model: string) => {
  const tag = controlErrorFields(cause)?._tag;
  const message = asNonEmptyString(controlErrorFields(cause)?.message) || 'Image generation failed';
  if (tag === 'ModelNotFoundError') {
    return new OpenChamberControlError(`The image model ${model} is no longer available. Ask the user to choose another in Settings > General > OpenChamber Tools`, 409);
  }
  if (tag === 'UnsupportedModelError') {
    return new OpenChamberControlError(`${model} cannot generate images. Ask the user to choose an image model in Settings > General > OpenChamber Tools`, 409);
  }
  if (tag === 'ProviderRequestError') return new OpenChamberControlError(`The provider refused: ${message}`, 502);
  if (tag === 'InvalidRequestError') return new OpenChamberControlError(message, 400);
  if (tag === 'ServiceUnavailableError') return new OpenChamberControlError(message, 503);
  return new OpenChamberControlError(message, 502);
};

const parseModel = (value: ImageSettings['agentImageModel']) => {
  const text = asNonEmptyString(value);
  if (!text) return null;
  const separator = text.indexOf('/');
  if (separator <= 0 || separator === text.length - 1) return null;
  return { providerID: text.slice(0, separator), id: text.slice(separator + 1) };
};

export const createImageGenerationAction = ({
  getClient, readSettings, fsPromises, now = () => new Date(), catalogRetryDelaysMs = CATALOG_RETRY_DELAYS_MS,
}: ImageGenerationDependencies) => (
  async (input: ControlInput, { directory, signal }: ActionContext = {}) => {
    const settings = await readSettings().catch(() => null);
    if (settings?.agentImageToolEnabled !== true) {
      throw new OpenChamberControlError('The image tool is turned off in OpenChamber settings', 403);
    }
    const model = parseModel(settings?.agentImageModel);
    if (!model) {
      throw new OpenChamberControlError('No image model is chosen. Ask the user to pick one in Settings > General > OpenChamber Tools > Image model', 409);
    }
    const modelName = `${model.providerID}/${model.id}`;

    const prompt = asNonEmptyString(input.prompt);
    if (!prompt) throw new OpenChamberControlError('prompt is required', 400);
    if (prompt.length > MAX_PROMPT_LENGTH) throw new OpenChamberControlError(`prompt is longer than ${MAX_PROMPT_LENGTH} characters`, 400);
    const parsedCount = input.count === undefined ? { success: true, data: 1 } : countSchema.safeParse(input.count);
    if (!parsedCount.success) {
      throw new OpenChamberControlError(`count must be a whole number from 1 to ${MAX_COUNT}`, 400);
    }
    const count = parsedCount.data;
    const rawAspect = asNonEmptyString(input.aspect);
    const aspect = rawAspect && isAspect(rawAspect) ? rawAspect : null;
    if (rawAspect && !aspect) {
      throw new OpenChamberControlError('aspect is width:height, such as 16:9', 400);
    }
    const resolution = asNonEmptyString(input.resolution);
    if (resolution && !/^[0-9A-Za-z]{1,8}$/.test(resolution)) {
      throw new OpenChamberControlError('resolution is a size tier such as 1K, 2K or 4K', 400);
    }
    const parsedSources = input.images === undefined ? { success: true, data: [] } : sourcesSchema.safeParse(input.images);
    if (!parsedSources.success) {
      throw new OpenChamberControlError(`images is a list of at most ${MAX_SOURCE_IMAGES} image file paths`, 400);
    }
    const sources = parsedSources.data;
    const requestedPath = asNonEmptyString(input.path);
    const workDirectory = asNonEmptyString(directory);
    if (requestedPath) resolvePath(requestedPath, workDirectory);
    const images = await Promise.all(sources.map((source) => readSourceImage(fsPromises, source, workDirectory)));

    const client = await getClient();
    const deadline = AbortSignal.timeout(GENERATION_TIMEOUT_MS);
    const request: ImageRequest = { model, prompt };
    if (images.length > 0) request.images = images;
    if (count > 1) request.n = count;
    if (aspect) request.aspect = aspect;
    if (resolution) request.resolution = resolution;
    const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    let result;
    for (let attempt = 0; ; attempt += 1) {
      try {
        result = await client.experimental.generate.image(request, { signal: requestSignal });
        break;
      } catch (error) {
        if (deadline.aborted) throw new OpenChamberControlError(`${modelName} did not finish within 5 minutes`, 504);
        if (signal?.aborted) throw error;
        const retry = controlErrorFields(error)?._tag === 'ModelNotFoundError' ? catalogRetryDelaysMs[attempt] : undefined;
        if (retry === undefined) throw toControlError(error, modelName);
        await delay(retry, undefined, { signal: requestSignal });
      }
    }

    const generated = Array.isArray(result?.images) ? result.images : [];
    if (generated.length === 0) throw new OpenChamberControlError(`${modelName} returned no image`, 502);
    const moment = now();
    const saved = [];
    for (const [index, image] of generated.entries()) {
      const file = targetPath({ requested: requestedPath, directory: workDirectory, index, count: generated.length, mime: image.mime, now: moment });
      await fsPromises.mkdir(path.dirname(file), { recursive: true });
      await fsPromises.writeFile(file, Buffer.from(image.data, 'base64'));
      saved.push({ path: file, mime: image.mime });
    }
    const output: GeneratedImages = { model: modelName, images: saved };
    if (isFiniteCost(result.cost)) output.cost = result.cost;
    return output;
  }
);

const isEnvelope = (value: unknown): value is { ok?: unknown; data?: unknown } => value !== null && typeof value === 'object';
const isImageData = (value: unknown): value is { images?: unknown } => value !== null && typeof value === 'object';
const isImagePath = (value: unknown): value is { path?: unknown } => value !== null && typeof value === 'object';

export const generatedImagePaths = (text: string) => {
  let envelope: unknown;
  try {
    envelope = JSON.parse(text);
  } catch {
    return [];
  }
  const images = isEnvelope(envelope) && envelope.ok === true
    ? (isImageData(envelope.data) ? envelope.data.images : undefined) : null;
  return Array.isArray(images)
    ? images.map((image) => asNonEmptyString(isImagePath(image) ? image.path : undefined)).filter((file) => file !== null)
    : [];
};
