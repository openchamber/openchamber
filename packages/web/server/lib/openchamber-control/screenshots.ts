import path from 'node:path';
import fsPromises from 'node:fs/promises';
import { z } from 'zod';
import { readToolEnvelope } from './tool-envelope.js';

export const SCREENSHOT_DIRECTORY = path.join('.openchamber', 'screenshots');

const MAX_LABEL_LENGTH = 48;

export const screenshotSlug = (label: ScreenshotRequest['label']) => {
  const slug = String(label ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_LABEL_LENGTH)
    .replace(/-+$/g, '');
  return slug || 'page';
};

const screenshotStamp = (date: Date) => date.toISOString().replace(/[:.]/g, '-').replace('Z', '');

const EXTENSIONS = new Map([
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
]);

export interface ScreenshotRequest {
  directory: unknown;
  base64: unknown;
  mime?: unknown;
  label?: unknown;
  now?: Date;
  fs?: Pick<typeof fsPromises, 'mkdir' | 'writeFile'>;
}

const isImageText = (value: unknown): value is string => typeof value === 'string';

export const writeScreenshot = async ({
  directory,
  base64,
  mime = 'image/jpeg',
  label,
  now = new Date(),
  fs = fsPromises,
}: ScreenshotRequest) => {
  if (!isImageText(directory) || directory.trim().length === 0) {
    throw new Error('A project directory is required to save a screenshot');
  }
  if (!isImageText(base64) || base64.length === 0) {
    throw new Error('The browser returned no image');
  }

  const extension = (isImageText(mime) ? EXTENSIONS.get(mime) : undefined) || '.jpg';
  const stem = `${screenshotSlug(label)}-${screenshotStamp(now)}`;
  const data = Buffer.from(base64, 'base64');

  await fs.mkdir(path.join(directory, SCREENSHOT_DIRECTORY), { recursive: true });

  // Exclusive-create ('wx') so a capture can never truncate an existing
  // one: two captures with the same label in the same millisecond would
  // otherwise share a path and the later write would silently replace
  // the earlier image. The loser retries with a numeric suffix until it
  // owns a fresh path.
  for (let attempt = 1; ; attempt += 1) {
    const fileName = attempt === 1 ? `${stem}${extension}` : `${stem}-${attempt}${extension}`;
    const relativePath = path.join(SCREENSHOT_DIRECTORY, fileName);
    const absolutePath = path.join(directory, relativePath);
    try {
      await fs.writeFile(absolutePath, data, { flag: 'wx' });
      return { path: relativePath.split(path.sep).join('/'), absolutePath };
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error;
    }
  }
};

const capturedSchema = z.object({ path: z.string().trim().min(1) });

export const capturedScreenshotPaths = (text: string) => {
  const envelope = readToolEnvelope(text);
  if (envelope?.ok !== true || envelope.action !== 'browser.capture') return [];
  const captured = capturedSchema.safeParse(envelope.data);
  return captured.success ? [captured.data.path] : [];
};
