/**
 * `image.generate`: an image model the user chose in Settings makes or edits
 * pictures for any agent, through OpenCode's `POST
 * /api/experimental/generate/image` (OpenCode 2.2). The session keeps its own
 * model; the request names the image model itself, and OpenCode resolves its
 * provider and credentials.
 *
 * The bytes go to a file, never back into the conversation: a picture inline
 * would be stored with the session and synced to every client, a few
 * megabytes per call. The agent gets the path and reads the file when it
 * wants to look. Without a path of its own the file lands in OpenCode's
 * temporary folder, which OpenCode tells agents they may read and write
 * without asking. The chat draws the files from the call's result
 * (`../markdown-image-grants/routes.js`).
 */

import { constants as fsConstants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { z } from 'zod';

import { asNonEmptyString } from '../shared/guards.js';
import { OpenChamberControlError } from './error.js';

/** OpenCode's temporary folder (`paths.tmp` of `/api/info`), the default home of a generated file. */
export const GENERATED_IMAGE_DIRECTORY = path.join(os.tmpdir(), 'opencode', 'generated-images');

const MAX_PROMPT_LENGTH = 8_000;
const MAX_SOURCE_IMAGES = 8;
const MAX_SOURCE_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_COUNT = 4;
// Image models take tens of seconds; a stuck provider must not hold the turn forever.
const GENERATION_TIMEOUT_MS = 5 * 60 * 1000;

// A harness can stringify a number or send one path bare on the way.
const countSchema = z.union([z.number(), z.string().regex(/^\d+$/).transform(Number)])
  .pipe(z.number().int().min(1).max(MAX_COUNT));
const sourcesSchema = z.union([z.string().transform((source) => [source]), z.array(z.string())])
  .pipe(z.array(z.string().trim().min(1)).max(MAX_SOURCE_IMAGES));

const EXTENSION_BY_MIME = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

const sniffImageMime = (bytes) => {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes.subarray(1, 4).toString('ascii') === 'PNG') return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  const header = bytes.subarray(0, 12).toString('ascii');
  if (header.startsWith('GIF87a') || header.startsWith('GIF89a')) return 'image/gif';
  if (header.startsWith('RIFF') && header.slice(8, 12) === 'WEBP') return 'image/webp';
  return null;
};

const resolvePath = (value, directory) => {
  if (path.isAbsolute(value)) return value;
  if (!directory) throw new OpenChamberControlError(`${value} is relative and the session has no directory; pass an absolute path`, 400);
  return path.resolve(directory, value);
};

const readSourceImage = async (fsPromises, value, directory) => {
  const file = resolvePath(value, directory);
  let handle;
  try {
    handle = await fsPromises.open(file, fsConstants.O_RDONLY);
  } catch (error) {
    throw new OpenChamberControlError(
      error?.code === 'ENOENT' ? `Image not found: ${file}` : `Could not read ${file}: ${error?.message ?? error}`,
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

const pad = (value, length = 2) => String(value).padStart(length, '0');

/** File-safe local timestamp, the time the user's clock showed, that sorts chronologically. */
const stamp = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  + `T${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}-${pad(date.getMilliseconds(), 3)}`;

/**
 * Where image `index` of `count` goes. A path the agent named takes the first
 * image; the rest get `-2`, `-3` before the extension. A path without an
 * extension gets the one of the image's format.
 */
const targetPath = ({ requested, directory, index, count, mime, now }) => {
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

/** OpenCode's tagged generation errors, as the agent can act on them. */
const toControlError = (error, model) => {
  const tag = error?._tag;
  const message = asNonEmptyString(error?.message) || 'Image generation failed';
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

/** `provider/model`; the model id may hold slashes of its own. */
const parseModel = (value) => {
  const text = asNonEmptyString(value);
  const separator = text ? text.indexOf('/') : -1;
  if (separator <= 0 || separator === text.length - 1) return null;
  return { providerID: text.slice(0, separator), id: text.slice(separator + 1) };
};

/**
 * @param {object} options
 * @param {() => Promise<any>} options.getClient OpenCode client
 * @param {() => Promise<object | null>} options.readSettings
 * @param {typeof import('node:fs/promises')} options.fsPromises
 * @param {() => Date} [options.now]
 */
export const createImageGenerationAction = ({ getClient, readSettings, fsPromises, now = () => new Date() }) => (
  async (input, { directory, signal } = {}) => {
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
    const aspect = asNonEmptyString(input.aspect);
    if (aspect && !/^\d+(?:\.\d+)?:\d+(?:\.\d+)?$/.test(aspect)) {
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
    // A path the call cannot save to is refused before the provider bills the image.
    if (requestedPath) resolvePath(requestedPath, workDirectory);
    const images = await Promise.all(sources.map((source) => readSourceImage(fsPromises, source, workDirectory)));

    // Generation takes no location: OpenCode resolves the model in its global config.
    const client = await getClient();
    const deadline = AbortSignal.timeout(GENERATION_TIMEOUT_MS);
    // Only what the agent set travels, so the model's own defaults apply to the rest.
    const request = { model, prompt };
    if (images.length > 0) request.images = images;
    if (count > 1) request.n = count;
    if (aspect) request.aspect = aspect;
    if (resolution) request.resolution = resolution;
    let result;
    try {
      result = await client.experimental.generate.image(request, { signal: signal ? AbortSignal.any([signal, deadline]) : deadline });
    } catch (error) {
      if (deadline.aborted) throw new OpenChamberControlError(`${modelName} did not finish within 5 minutes`, 504);
      if (signal?.aborted) throw error;
      throw toControlError(error, modelName);
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
    const output = { model: modelName, images: saved };
    // The provider reports cost only sometimes; the agent hears it when it does.
    if (Number.isFinite(result.cost)) output.cost = result.cost;
    return output;
  }
);

/**
 * The files an `image.generate` result names, from the text the tool stored:
 * the plugin's JSON envelope. Anything else names none.
 */
export const generatedImagePaths = (text) => {
  let envelope;
  try {
    envelope = JSON.parse(text);
  } catch {
    return [];
  }
  const images = envelope?.ok === true ? envelope.data?.images : null;
  return Array.isArray(images)
    ? images.map((image) => asNonEmptyString(image?.path)).filter(Boolean)
    : [];
};
