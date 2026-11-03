import fs from 'node:fs/promises';
import path from 'node:path';

import { resolveAttachEntry, resolvePageEntry, resolveStatusSectionEntry } from '@openchamber/sdk';
import { parseManifestJson } from '@openchamber/sdk/schemas';

import { listRelativeGuestAssetHrefs, resolveGuestHtmlRelativePath } from './html-tokens.js';
import { createFolderChangeWatch } from '../fs/folder-change-watch.js';

const POLL_MS = 500;
const SCRIPT_MODULE = /\.[cm]?js$/;

/** Every script a service can import: `.js`, `.mjs` and `.cjs` under its entry's folder, outside `node_modules` and dot folders. */
const serviceModules = async (root, folder, fs) => {
  const found = [];
  const entries = await fs.readdir(path.join(root, folder), { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const child = path.posix.join(folder, entry.name);
    if (entry.isDirectory()) found.push(...await serviceModules(root, child, fs));
    else if (SCRIPT_MODULE.test(entry.name)) found.push(child);
  }
  return found;
};

/**
 * What the host loads from a package: the manifest, the panel icon, each
 * page with the scripts, links, and images it loads, and the service's
 * scripts. Read from the manifest itself, so a package that does not load yet
 * still names the files its build will write. Anything else a service writes
 * beside them does not count.
 */
const loadedFiles = async (root, fs) => {
  const files = ['package.json'];
  const raw = await fs.readFile(path.join(root, 'package.json'), 'utf8').catch(() => null);
  const parsed = raw === null ? null : parseManifestJson(raw);
  if (!parsed?.ok) return files;
  const contributes = parsed.manifest.contributes;
  if (contributes.panel.icon.toLowerCase().endsWith('.svg')) files.push(contributes.panel.icon);
  const pages = [
    contributes.panel.entry,
    contributes.background?.entry,
    resolveAttachEntry(contributes),
    resolvePageEntry(contributes),
    resolveStatusSectionEntry(contributes),
    ...(contributes.fileEditors ?? []).map((editor) => editor.entry),
  ].filter(Boolean);
  for (const page of pages) {
    files.push(page);
    const html = await fs.readFile(path.join(root, page), 'utf8').catch(() => '');
    for (const href of listRelativeGuestAssetHrefs(html)) {
      const file = resolveGuestHtmlRelativePath(page, href);
      if (file) files.push(file);
    }
  }
  if (contributes.service?.entry) {
    files.push(contributes.service.entry, ...await serviceModules(root, path.posix.dirname(contributes.service.entry), fs));
  }
  return [...new Set(files)];
};

const fingerprint = async (root, fs) => {
  const files = await loadedFiles(root, fs);
  const stamps = await Promise.all(files.map((file) => fs.stat(path.join(root, file)).then(
    (stat) => `${stat.mtimeMs}:${stat.size}`,
    () => 'missing',
  )));
  return files.map((file, index) => `${file}=${stamps[index]}`).join('\n');
};

/**
 * Watches folder installs, the packages an author rebuilds in place, and calls
 * `onChange(root)` when the files the host loads have changed and then held
 * still for one check. Copies (ZIP, Git) change only through install and
 * update, which report themselves.
 *
 * Tree signals trigger fingerprints of loaded files only. A slow safety check
 * reopens watchers so deleted and recreated roots recover on every platform.
 * `sync()` follows the installed folders; calls run one after another.
 */
export const createGuestPackageWatch = ({ listFolderInstalls, onChange, pollMs = POLL_MS, fsPromises = fs, fsWatch, timers }) => {
  const watched = new Map();
  let syncing = Promise.resolve();
  let stopped = false;

  const apply = async () => {
    const roots = new Set(await listFolderInstalls());
    if (stopped) return;
    for (const [root, entry] of [...watched]) {
      if (roots.has(root)) continue;
      entry.stop();
      watched.delete(root);
    }
    for (const root of roots) {
      if (watched.has(root)) continue;
      if (stopped) return;
      const entry = createFolderChangeWatch({
        root, fingerprint: () => fingerprint(root, fsPromises), onChange: () => onChange(root),
        recursive: true, pollMs, fsWatch, timers,
      });
      watched.set(root, entry);
      await entry.ready;
    }
  };

  const sync = () => {
    syncing = syncing.then(apply).catch((error) => {
      console.warn('Failed to watch extension folders:', error?.message ?? error);
    });
    return syncing;
  };

  return {
    sync,
    stop: () => {
      stopped = true;
      for (const entry of watched.values()) entry.stop();
      watched.clear();
    },
  };
};
