import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createProjectIdFromPath } from './project-id.js';

const execFileAsync = promisify(execFile);

/**
 * Project bootstrap actions used by the messenger bridge when a channel
 * arrives with no project bound. The user picks one of:
 *
 *   action: 'clone'  — git clone <url> into a fresh dir under OPENCHAMBER_DATA_DIR/projects/<name>
 *           'path'   — register an existing absolute directory as a project
 *           'new'    — mkdir -p OPENCHAMBER_DATA_DIR/projects/<name> and register it
 *
 * In every case we end up writing a single new entry into the persisted
 * projects array so the rest of OpenChamber (web UI, listProjects, etc.)
 * sees the new project immediately.
 */

const DEFAULT_PROJECTS_ROOT = () =>
  path.join(
    process.env.OPENCHAMBER_DATA_DIR
      ? path.resolve(process.env.OPENCHAMBER_DATA_DIR)
      : path.join(os.homedir(), '.config', 'openchamber'),
    'projects',
  );

function deriveRepoName(input) {
  if (!input) return null;
  const stripped = String(input)
    .replace(/\.git$/, '')
    .replace(/\/$/, '');
  const tail = stripped.split(/[\\/]/).pop();
  if (!tail) return null;
  return tail.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || null;
}

async function pathExists(p) {
  try {
    await fs.stat(p);
    return true;
  } catch (err) {
    if (err && err.code === 'ENOENT') return false;
    throw err;
  }
}

async function ensureUniqueDir(baseDir, name) {
  await fs.mkdir(baseDir, { recursive: true });
  let candidate = path.join(baseDir, name);
  let n = 1;
  while (await pathExists(candidate)) {
    candidate = path.join(baseDir, `${name}-${++n}`);
    if (n > 100) throw new Error('could not find a free directory name');
  }
  return candidate;
}

/**
 * @param {object} args
 * @param {'clone'|'path'|'new'} args.action
 * @param {string} [args.url]
 * @param {string} [args.path]
 * @param {string} [args.label]
 * @param {string} [args.projectsRoot]
 * @param {() => Promise<object>} args.readSettings - readSettingsFromDiskMigrated
 * @param {(changes: object) => Promise<object>} args.persistSettings
 * @param {(input: unknown) => any[] | undefined} args.sanitizeProjects
 * @param {number} [args.cloneTimeoutMs]
 * @returns {Promise<{ ok: boolean, project?: { id, path, label }, error?: string, log?: string }>}
 */
export async function bootstrapProject({
  action,
  url,
  path: explicitPath,
  label,
  projectsRoot = DEFAULT_PROJECTS_ROOT(),
  readSettings,
  persistSettings,
  sanitizeProjects,
  cloneTimeoutMs = 5 * 60_000,
}) {
  if (!readSettings || !persistSettings || !sanitizeProjects) {
    return { ok: false, error: 'project bootstrap is not wired into the server' };
  }

  let finalPath;
  let logTrail = '';

  try {
    if (action === 'clone') {
      if (!url || typeof url !== 'string') return { ok: false, error: 'clone requires a git url' };
      const repoName = deriveRepoName(url);
      if (!repoName) return { ok: false, error: `could not derive a repo name from "${url}"` };
      const dest = explicitPath
        ? path.resolve(explicitPath)
        : await ensureUniqueDir(projectsRoot, repoName);
      // If the user passed an explicit path, validate it does not already exist
      // so we don't clone into a populated folder.
      if (explicitPath && (await pathExists(dest))) {
        const stat = await fs.stat(dest).catch(() => null);
        const empty = stat?.isDirectory() ? (await fs.readdir(dest)).length === 0 : false;
        if (!empty) return { ok: false, error: `path already exists and is non-empty: ${dest}` };
      }
      await fs.mkdir(path.dirname(dest), { recursive: true });
      const result = await execFileAsync('git', ['clone', '--depth=50', url, dest], {
        timeout: cloneTimeoutMs,
        maxBuffer: 8 * 1024 * 1024,
      }).catch((e) => ({ error: e }));
      if (result.error) {
        const stderr = result.error?.stderr ? String(result.error.stderr).slice(0, 500) : '';
        return { ok: false, error: `git clone failed: ${result.error.message}\n${stderr}` };
      }
      logTrail = String(result.stderr ?? result.stdout ?? '').slice(0, 1200);
      finalPath = dest;
    } else if (action === 'path') {
      if (!explicitPath || typeof explicitPath !== 'string') {
        return { ok: false, error: 'path action requires an absolute path' };
      }
      const resolved = path.resolve(explicitPath);
      const exists = await pathExists(resolved);
      if (!exists) return { ok: false, error: `path does not exist: ${resolved}` };
      const stat = await fs.stat(resolved);
      if (!stat.isDirectory()) return { ok: false, error: `not a directory: ${resolved}` };
      finalPath = resolved;
    } else if (action === 'new') {
      const name = (label && deriveRepoName(label)) || deriveRepoName(explicitPath) || 'openchamber-agent-project';
      const dest = explicitPath
        ? path.resolve(explicitPath)
        : await ensureUniqueDir(projectsRoot, name);
      await fs.mkdir(dest, { recursive: true });
      finalPath = dest;
    } else {
      return { ok: false, error: `unknown action: ${action}` };
    }
  } catch (err) {
    return { ok: false, error: err?.message ?? 'bootstrap failed' };
  }

  if (!finalPath) return { ok: false, error: 'bootstrap produced no path' };

  // Register the project in persisted settings.
  let current = {};
  try {
    current = (await readSettings()) ?? {};
  } catch (err) {
    return { ok: false, error: `failed to read settings: ${err?.message ?? err}` };
  }

  const existing = Array.isArray(current.projects) ? current.projects : [];
  const projectId = createProjectIdFromPath(finalPath);
  const alreadyKnown = existing.find((p) => p?.id === projectId || p?.path === finalPath);

  let project;
  let projects;
  if (alreadyKnown) {
    // Re-use the existing entry but refresh lastOpenedAt.
    project = { ...alreadyKnown, lastOpenedAt: Date.now() };
    projects = existing.map((p) => (p?.id === project.id ? project : p));
  } else {
    project = {
      id: projectId,
      path: finalPath,
      label:
        (typeof label === 'string' && label.trim().length > 0
          ? label.trim()
          : path.basename(finalPath)) || finalPath,
      addedAt: Date.now(),
      lastOpenedAt: Date.now(),
    };
    projects = [...existing, project];
  }

  const sanitized = sanitizeProjects(projects) ?? projects;
  try {
    await persistSettings({ projects: sanitized, activeProjectId: project.id });
  } catch (err) {
    return { ok: false, error: `failed to persist project: ${err?.message ?? err}` };
  }

  return {
    ok: true,
    project: { id: project.id, path: project.path, label: project.label },
    log: logTrail,
  };
}
