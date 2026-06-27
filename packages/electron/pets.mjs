// Desktop pet catalog: discovery, asset loading, and import for Codex-compatible
// pets stored under the OpenChamber config dir:
//   <configDir>/pets/<slug>/{ pet.json, <spritesheetPath> }
//
// pet.json is the Codex/petdex manifest: { id, displayName, description,
// spritesheetPath }. It carries no geometry — the 192x208 frame size is
// convention, derived by the renderer from the loaded image.
//
// The pet window loads from the local UI origin, so a file:// spritesheet would
// be cross-origin. We avoid a custom protocol by reading the bytes here and
// handing the renderer a data URL over IPC (no CORS, no new dependency).

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

// Slugs map 1:1 to folder names; restrict the charset so a slug coming back
// over IPC can never traverse outside the pets dir.
const SLUG_RE = /^[A-Za-z0-9._-]+$/;

// Cap the inlined spritesheet so a pathological file can't bloat the data URL
// (a typical 1536x1872 webp sheet is a few hundred KB).
const MAX_SPRITESHEET_BYTES = 8 * 1024 * 1024;

const SPRITESHEET_MIME = {
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.apng': 'image/apng',
  '.gif': 'image/gif',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};

// Validate a user-chosen spritesheet image before we copy or read it: non-empty
// path, allowed image type, existing regular file, within the size cap. Shared by
// create/edit/preview so those three paths can't drift. Returns the trimmed
// source path plus its resolved extension + MIME type.
const statValidatedImage = (imagePath) => {
  const source = typeof imagePath === 'string' ? imagePath.trim() : '';
  if (!source) {
    throw new Error('A spritesheet image is required');
  }
  const ext = path.extname(source).toLowerCase();
  const mime = SPRITESHEET_MIME[ext];
  if (!mime) {
    throw new Error('Unsupported spritesheet image type');
  }
  let stat;
  try {
    stat = fs.statSync(source);
  } catch {
    throw new Error('Spritesheet image not found');
  }
  if (!stat.isFile()) {
    throw new Error('Spritesheet image not found');
  }
  if (stat.size > MAX_SPRITESHEET_BYTES) {
    throw new Error('Spritesheet exceeds the maximum allowed size');
  }
  return { source, ext, mime };
};

const sanitizeSlug = (value) => {
  const slug = typeof value === 'string' ? value.trim() : '';
  if (!slug || slug === '.' || slug === '..' || !SLUG_RE.test(slug)) return '';
  return slug;
};

const readPetManifest = (petDir) => {
  // Throws ENOENT when there's no pet.json — callers treat that as "not a pet".
  const raw = fs.readFileSync(path.join(petDir, 'pet.json'), 'utf8');
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid pet.json');
  }
  const spritesheetPath = typeof parsed.spritesheetPath === 'string' ? parsed.spritesheetPath.trim() : '';
  if (!spritesheetPath) {
    throw new Error('pet.json is missing spritesheetPath');
  }
  return {
    id: typeof parsed.id === 'string' ? parsed.id : '',
    displayName: typeof parsed.displayName === 'string' && parsed.displayName.trim()
      ? parsed.displayName.trim()
      : '',
    description: typeof parsed.description === 'string' ? parsed.description : '',
    spritesheetPath,
  };
};

// Resolve the spritesheet inside its pet folder, rejecting any spritesheetPath
// that would escape the folder (e.g. "../../secret").
const resolveSpritesheetFile = (petDir, spritesheetPath) => {
  const root = path.resolve(petDir);
  const resolved = path.resolve(root, spritesheetPath);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error('spritesheetPath escapes the pet folder');
  }
  return resolved;
};

// List installed pets (metadata only — no spritesheet bytes). Display-only, so
// a missing/unreadable dir yields [] rather than throwing.
export const listPets = (petsDir) => {
  let entries;
  try {
    entries = fs.readdirSync(petsDir, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    throw error;
  }

  const pets = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const slug = sanitizeSlug(entry.name);
    if (!slug) continue;
    try {
      const manifest = readPetManifest(path.join(petsDir, slug));
      pets.push({
        slug,
        displayName: manifest.displayName || slug,
        description: manifest.description,
      });
    } catch {
      // Not every subfolder is a valid pet — skip silently.
    }
  }

  pets.sort((a, b) => a.displayName.localeCompare(b.displayName));
  return pets;
};

// Load one pet with its spritesheet inlined as a data URL. Returns null when the
// pet doesn't exist (so the renderer can fall back), throws on real read errors
// (e.g. oversized sheet) so failures aren't silently swallowed.
export const getPet = (petsDir, rawSlug) => {
  const slug = sanitizeSlug(rawSlug);
  if (!slug) return null;

  const petDir = path.join(petsDir, slug);
  let manifest;
  try {
    manifest = readPetManifest(petDir);
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }

  const file = resolveSpritesheetFile(petDir, manifest.spritesheetPath);
  const stat = fs.statSync(file);
  if (stat.size > MAX_SPRITESHEET_BYTES) {
    throw new Error('Spritesheet exceeds the maximum allowed size');
  }

  const mime = SPRITESHEET_MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const bytes = fs.readFileSync(file);
  return {
    slug,
    spritesheetDataUrl: `data:${mime};base64,${bytes.toString('base64')}`,
  };
};

const SLUG_MAX_LEN = 64;

// Derive a folder-safe slug from a display name. Falls back to a timestamp slug
// when the name has no usable characters (e.g. all emoji / CJK stripped).
const slugifyName = (value) => {
  const base = (typeof value === 'string' ? value : '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, SLUG_MAX_LEN);
  return base || `pet-${Date.now().toString(36)}`;
};

const uniqueSlug = (petsDir, desired) => {
  let candidate = desired;
  let counter = 2;
  while (fs.existsSync(path.join(petsDir, candidate))) {
    candidate = `${desired}-${counter}`;
    counter += 1;
  }
  return candidate;
};

// Create a pet from a chosen spritesheet image + metadata (Settings → Create).
// Writes a fresh pet.json next to a copy of the image. Validates the image
// before writing so a bad input leaves no folder.
export const createPet = async (petsDir, { displayName, description, imagePath } = {}) => {
  const name = typeof displayName === 'string' ? displayName.trim() : '';
  if (!name) {
    throw new Error('A pet name is required');
  }

  const { source, ext } = statValidatedImage(imagePath);

  const slug = uniqueSlug(petsDir, slugifyName(name));
  const destDir = path.join(petsDir, slug);
  const spritesheetName = `spritesheet${ext}`;

  await fsp.mkdir(destDir, { recursive: true });
  await fsp.copyFile(source, path.join(destDir, spritesheetName));
  const manifest = {
    id: slug,
    displayName: name,
    description: typeof description === 'string' ? description.trim() : '',
    spritesheetPath: spritesheetName,
  };
  await fsp.writeFile(path.join(destDir, 'pet.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  return { slug, displayName: name, description: manifest.description };
};

// Edit an existing pet's manifest (Settings → row → Edit). The slug/folder is
// the stable id, so only displayName/description change here; the spritesheet is
// replaced only when a new image is chosen. Validates before writing so a bad
// input leaves the existing pet untouched. Returns the updated metadata.
export const editPet = async (petsDir, rawSlug, { displayName, description, imagePath } = {}) => {
  const slug = sanitizeSlug(rawSlug);
  if (!slug) {
    throw new Error('Invalid pet id');
  }

  const petDir = path.join(petsDir, slug);
  // Throws ENOENT when the pet no longer exists — surface it rather than
  // silently recreating a folder.
  const manifest = readPetManifest(petDir);

  const name = typeof displayName === 'string' ? displayName.trim() : '';
  if (!name) {
    throw new Error('A pet name is required');
  }

  let spritesheetPath = manifest.spritesheetPath;
  const hasNewImage = typeof imagePath === 'string' && imagePath.trim().length > 0;
  if (hasNewImage) {
    const { source, ext } = statValidatedImage(imagePath);

    const newName = `spritesheet${ext}`;
    await fsp.copyFile(source, path.join(petDir, newName));
    // Drop the previous spritesheet when the filename changed, so a swapped
    // image (e.g. webp -> png) doesn't leave an orphan in the folder.
    if (manifest.spritesheetPath && manifest.spritesheetPath !== newName) {
      const oldFile = resolveSpritesheetFile(petDir, manifest.spritesheetPath);
      await fsp.rm(oldFile, { force: true }).catch(() => {});
    }
    spritesheetPath = newName;
  }

  const updated = {
    id: manifest.id || slug,
    displayName: name,
    description: typeof description === 'string' ? description.trim() : '',
    spritesheetPath,
  };
  await fsp.writeFile(path.join(petDir, 'pet.json'), `${JSON.stringify(updated, null, 2)}\n`, 'utf8');

  return { slug, displayName: name, description: updated.description };
};

// Delete an installed pet folder (Settings → row → Delete). The slug charset is
// already restricted, but we re-resolve and assert containment so a deletion can
// never escape the pets directory.
export const deletePet = async (petsDir, rawSlug) => {
  const slug = sanitizeSlug(rawSlug);
  if (!slug) {
    throw new Error('Invalid pet id');
  }

  const root = path.resolve(petsDir);
  const resolved = path.resolve(root, slug);
  if (resolved === root || !resolved.startsWith(root + path.sep)) {
    throw new Error('Refusing to delete outside the pets directory');
  }

  await fsp.rm(resolved, { recursive: true, force: true });
  return { slug };
};

// Read a chosen spritesheet image and return it as a data URL, so the Create
// dialog can render a live animated preview before the pet is written. Mirrors
// getPet's validation (MIME allowlist + size cap) but never copies anything.
export const loadSpritesheetPreview = (imagePath) => {
  const { source, mime } = statValidatedImage(imagePath);
  const bytes = fs.readFileSync(source);
  return `data:${mime};base64,${bytes.toString('base64')}`;
};
