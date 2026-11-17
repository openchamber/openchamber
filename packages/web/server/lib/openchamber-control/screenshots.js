import path from 'node:path';
import fsPromises from 'node:fs/promises';
import { z } from 'zod';
import { readToolEnvelope } from './tool-envelope.js';

export const SCREENSHOT_DIRECTORY = path.join('.openchamber', 'screenshots');

const MAX_LABEL_LENGTH = 48;

export const screenshotSlug = (label) => {
  const slug = String(label ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_LABEL_LENGTH)
    .replace(/-+$/g, '');
  return slug || 'page';
};

const screenshotStamp = (date) => date.toISOString().replace(/[:.]/g, '-').replace('Z', '');

const EXTENSIONS = new Map([
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
]);

export const writeScreenshot = async ({
  directory,
  base64,
  mime = 'image/jpeg',
  label,
  now = new Date(),
  fs = fsPromises,
}) => {
  if (typeof directory !== 'string' || directory.trim().length === 0) {
    throw new Error('A project directory is required to save a screenshot');
  }
  if (typeof base64 !== 'string' || base64.length === 0) {
    throw new Error('The browser returned no image');
  }

  const extension = EXTENSIONS.get(mime) || '.jpg';
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

export const capturedScreenshotPaths = (text) => {
  const envelope = readToolEnvelope(text);
  if (envelope?.ok !== true || envelope.action !== 'browser.capture') return [];
  const captured = capturedSchema.safeParse(envelope.data);
  return captured.success ? [captured.data.path] : [];
};
