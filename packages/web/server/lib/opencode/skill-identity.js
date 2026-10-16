/**
 * Selecting one skill by OpenCode skill id on the name-keyed skill routes
 * (`/api/config/skills/:name`, its `files/*` routes). Display names can
 * collide; the id (the folder of `SKILL.md`) cannot within one listing. Shared
 * by the web server and the VS Code extension host so both select alike.
 */
import fs from 'fs';
import path from 'path';
import { isValidSkillPolicyId } from './skill-policy.js';

/**
 * The optional `?id=` selector: `{ id: null }` when absent (legacy name
 * lookup), `{ id }` when valid, `{ error }` otherwise.
 */
export function readSkillIdSelector(value) {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined || raw === null || raw === '') return { id: null, error: null };
  return isValidSkillPolicyId(raw) ? { id: raw, error: null } : { id: null, error: 'Invalid skill id' };
}

/**
 * The listed skill with this id and display name, or `null`. Never falls back
 * to another skill with the same name: a caller that named an id gets that id
 * or nothing.
 */
export function selectSkillById(skills, id, name) {
  return skills.find((skill) => skill?.id === id && skill?.name === name) ?? null;
}

const relativeInside = (candidate, parent) => {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative.startsWith('..') || path.isAbsolute(relative) ? null : relative;
};

const isStrictlyInside = (candidate, parent) => {
  const relative = relativeInside(candidate, parent);
  return relative !== null && relative !== '';
};

const realpathOrNull = (target) => {
  try {
    return fs.realpathSync(target);
  } catch {
    return null;
  }
};

// The folder's parent, followed through every symlink, is still the root or
// inside it. A root that is itself a symlink counts as its target, since the
// user placed it there; a group folder linking out of the root does not.
const parentStaysInsideRoot = (folder, root) => {
  const realRoot = realpathOrNull(root);
  const realParent = realpathOrNull(path.dirname(folder));
  return realRoot !== null && realParent !== null && relativeInside(realParent, realRoot) !== null;
};

/**
 * The folder a delete may remove for one skill file: the folder of a
 * `SKILL.md` that sits strictly inside a managed skill root, nested groups
 * included. `null` for anything else, so a `SKILL.md` placed directly in a
 * root never takes the whole root with it, and a group folder that is a
 * symlink leading out of the root never takes a folder outside it.
 */
export function skillFolderToDelete(skillMdPath, managedRoots) {
  if (!skillMdPath || path.basename(skillMdPath) !== 'SKILL.md') return null;
  const folder = path.dirname(path.resolve(skillMdPath));
  return managedRoots.some((root) => isStrictlyInside(folder, root) && parentStaysInsideRoot(folder, root)) ? folder : null;
}

/**
 * Whether `name` can name one folder directly inside a skill root: a single
 * path segment, never `.` or `..`. Deletes by display name or location join
 * it onto a root, so anything else could reach outside the root.
 */
export function isSkillFolderName(name) {
  return typeof name === 'string'
    && name.length > 0
    && name !== '.'
    && name !== '..'
    && !name.includes('/')
    && !name.includes('\\');
}

/**
 * Removes one skill folder. A folder that is itself a symlink loses only the
 * link; the folder it points at stays. A real folder goes with its contents,
 * and symlinks inside it are removed without being followed.
 */
export function removeSkillFolder(folder) {
  if (fs.lstatSync(folder).isSymbolicLink()) {
    fs.unlinkSync(folder);
    return;
  }
  fs.rmSync(folder, { recursive: true, force: true });
}
