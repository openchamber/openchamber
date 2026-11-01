import fs from 'node:fs/promises';
import path from 'node:path';

import { resolveAttachEntry, resolvePageEntry, resolveStatusSectionEntry } from '@openchamber/sdk';
import { parseManifestJson } from '@openchamber/sdk/schemas';

import { listRelativeGuestScriptHrefs, resolveGuestHtmlRelativePath } from './html-tokens.js';

const POLL_MS = 500;
const LINK_HREF = /<link\b[^>]*?\shref=(["'])(?!https?:|\/\/|data:|#)([^"']+)\1/gi;
const SCRIPT_MODULE = /\.[cm]?js$/;

/** Every script a service can import: `.js`, `.mjs` and `.cjs` under its entry's folder, outside `node_modules` and dot folders. */
const serviceModules = async (root, folder) => {
  const found = [];
  const entries = await fs.readdir(path.join(root, folder), { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const child = path.posix.join(folder, entry.name);
    if (entry.isDirectory()) found.push(...await serviceModules(root, child));
    else if (SCRIPT_MODULE.test(entry.name)) found.push(child);
  }
  return found;
};

/**
 * What the host loads from a package: the manifest, the panel icon, each
 * page with the scripts and links it loads, and the service's scripts. Read
 * from the manifest itself, so a package that does not load yet still names
 * the files its build will write. Anything else a service writes beside them
 * does not count.
 */
const loadedFiles = async (root) => {
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
    const links = [...html.matchAll(LINK_HREF)].map((match) => match[2]);
    for (const href of [...listRelativeGuestScriptHrefs(html), ...links]) {
      const file = resolveGuestHtmlRelativePath(page, href);
      if (file) files.push(file);
    }
  }
  if (contributes.service?.entry) {
    files.push(contributes.service.entry, ...await serviceModules(root, path.posix.dirname(contributes.service.entry)));
  }
  return [...new Set(files)];
};

const fingerprint = async (root) => {
  const files = await loadedFiles(root);
  const stamps = await Promise.all(files.map((file) => fs.stat(path.join(root, file)).then(
    (stat) => `${stat.mtimeMs}:${stat.size}`,
    () => 'missing',
  )));
  return files.map((file, index) => `${file}=${stamps[index]}`).join('\n');
};

/**
 * Watches folder installs, the packages an author rebuilds in place, and calls
 * `onChange(root)` when the files the host loads have changed and then held
 * still for one poll. Copies (ZIP, Git) change only through install and
 * update, which report themselves.
 *
 * It polls `stat` on those files instead of using `fs.watch`: a service that
 * writes into its own folder changes nothing it loads, and a build that
 * deletes and recreates its output folder is seen on every platform, where a
 * Linux or Windows folder watcher goes silent with the folder it watched.
 * `sync()` follows the installed folders; calls run one after another.
 */
export const createGuestPackageWatch = ({ listFolderInstalls, onChange, pollMs = POLL_MS }) => {
  /** @type {Map<string, { timer: ReturnType<typeof setInterval>, reported: string, seen: string, polling: boolean }>} */
  const watched = new Map();
  let syncing = Promise.resolve();

  const poll = async (root, entry) => {
    if (entry.polling) return;
    entry.polling = true;
    try {
      const current = await fingerprint(root);
      if (watched.get(root) !== entry) return;
      const settled = current === entry.seen;
      entry.seen = current;
      if (!settled || current === entry.reported) return;
      entry.reported = current;
      onChange(root);
    } finally {
      entry.polling = false;
    }
  };

  const apply = async () => {
    const roots = new Set(await listFolderInstalls());
    for (const [root, entry] of [...watched]) {
      if (roots.has(root)) continue;
      clearInterval(entry.timer);
      watched.delete(root);
    }
    for (const root of roots) {
      if (watched.has(root)) continue;
      const initial = await fingerprint(root);
      const entry = { timer: undefined, reported: initial, seen: initial, polling: false };
      entry.timer = setInterval(() => {
        poll(root, entry).catch((error) => console.warn('Failed to check an extension folder:', error?.message ?? error));
      }, pollMs);
      entry.timer.unref();
      watched.set(root, entry);
    }
  };

  const sync = () => {
    syncing = syncing.then(apply).catch((error) => {
      console.warn('Failed to watch extension folders:', error?.message ?? error);
    });
    return syncing;
  };

  return { sync };
};
