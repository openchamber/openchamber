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
  const relativePath = path.join(
    SCREENSHOT_DIRECTORY,
    `${screenshotSlug(label)}-${screenshotStamp(now)}${extension}`,
  );
  const absolutePath = path.join(directory, relativePath);

  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, Buffer.from(base64, 'base64'));

  return { path: relativePath.split(path.sep).join('/'), absolutePath };
};

const capturedSchema = z.object({ path: z.string().trim().min(1) });

export const capturedScreenshotPaths = (text: string) => {
  const envelope = readToolEnvelope(text);
  if (envelope?.ok !== true || envelope.action !== 'browser.capture') return [];
  const captured = capturedSchema.safeParse(envelope.data);
  return captured.success ? [captured.data.path] : [];
};
