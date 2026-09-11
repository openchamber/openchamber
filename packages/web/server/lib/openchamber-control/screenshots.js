/**
 * Where an agent's page screenshots land.
 *
 * The image is written on the server, next to the code it is evidence for,
 * because that is the machine holding the repository — the client that took the
 * picture may be somewhere else entirely. A file in the project is also the
 * only form of this that survives past the chat: it can be referenced from an
 * answer, committed, or attached to a review.
 *
 * A screenshot nobody can place is not evidence, so the name carries the label
 * the agent chose and the moment it was taken, and the caller is handed back
 * the page and layout it shows.
 */
import path from 'node:path';
import fsPromises from 'node:fs/promises';

/** Project-relative home for agent screenshots. */
export const SCREENSHOT_DIRECTORY = path.join('.openchamber', 'screenshots');

const MAX_LABEL_LENGTH = 48;

/**
 * Turns a label into a filename fragment.
 *
 * Everything outside a small safe set is dropped rather than escaped: this
 * value reaches the filesystem, and a label is a name, never a path. `..`, a
 * separator, or a leading dot cannot survive this.
 */
export const screenshotSlug = (label) => {
  const slug = String(label ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_LABEL_LENGTH)
    .replace(/-+$/g, '');
  return slug || 'page';
};

/** File-safe timestamp: sorts chronologically and reads as a date. */
const screenshotStamp = (date) => date.toISOString().replace(/[:.]/g, '-').replace('Z', '');

const EXTENSIONS = new Map([
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
]);

/**
 * Writes one capture into the project and reports where it went.
 *
 * Returns both the project-relative path — what belongs in an answer or a
 * commit — and the absolute one, so a caller that needs the file itself does
 * not have to rebuild it.
 */
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

  // Posix separators in the reported path: it is written into Markdown and
  // commit messages, where a Windows separator is an escape character.
  return { path: relativePath.split(path.sep).join('/'), absolutePath };
};
