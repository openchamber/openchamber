import fs from 'node:fs/promises';
import path from 'node:path';

import { requestedGuestCapabilities, resolveAttachEntry, resolveAttachMode, toPublicService, toPublicIntegration, hostMeetsOpenChamberEngine, openChamberEngineMinimum } from '@openchamber/sdk';
import { parseManifestJson } from '@openchamber/sdk/schemas';

import { listRelativeGuestScriptHrefs, resolveGuestHtmlRelativePath } from './html-tokens.js';
import { onExtensionStoreWrite, readExtensionStore } from './persist.js';
import { buildPublicSocketBindings } from './sockets.js';

const PANEL_ID = /^[a-z][a-z0-9-]*$/;

const MIME_BY_EXT = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.png': 'image/png',
};

export const isGuestPanelId = (value) => typeof value === 'string' && PANEL_ID.test(value);

export const resolveGuestAssetPath = async (packageRoot, relativePath) => {
  if (typeof relativePath !== 'string' || relativePath.includes('\0') || relativePath.includes('\\')) {
    return null;
  }
  const segments = relativePath.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return null;
  }
  if (relativePath.startsWith('/') || relativePath.includes('://')) {
    return null;
  }

  const rootReal = await fs.realpath(packageRoot);
  const candidate = path.resolve(rootReal, ...segments);
  if (candidate !== rootReal && !candidate.startsWith(rootReal + path.sep)) {
    return null;
  }

  try {
    const resolved = await fs.realpath(candidate);
    if (resolved !== rootReal && !resolved.startsWith(rootReal + path.sep)) {
      return null;
    }
    const stat = await fs.stat(resolved);
    if (!stat.isFile()) {
      return null;
    }
    return resolved;
  } catch {
    return null;
  }
};

export const guestAssetContentType = (filePath) => {
  return MIME_BY_EXT[path.extname(filePath).toLowerCase()] ?? null;
};

/** A `.js` URL can be served from a sibling `.ts` that the host compiles. */
export const resolveGuestServedFile = async (packageRoot, relativePath) => {
  const filePath = await resolveGuestAssetPath(packageRoot, relativePath);
  const contentType = filePath ? guestAssetContentType(filePath) : null;
  if (filePath && contentType) {
    return { filePath, contentType };
  }
  if (!relativePath.endsWith('.js')) {
    return null;
  }
  const tsPath = await resolveGuestAssetPath(packageRoot, `${relativePath.slice(0, -3)}.ts`);
  if (!tsPath) {
    return null;
  }
  return {
    filePath: `${tsPath.slice(0, -3)}.js`,
    contentType: MIME_BY_EXT['.js'],
  };
};

export const resolveGuestPackageRoot = async (rawPath) => {
  if (rawPath === '' || rawPath == null) {
    return null;
  }
  const text = `${rawPath}`;
  if (!path.isAbsolute(text) || text.includes('\0')) {
    return null;
  }
  try {
    const real = await fs.realpath(text);
    const stat = await fs.stat(real);
    if (!stat.isDirectory()) {
      return null;
    }
    return real;
  } catch {
    return null;
  }
};

/** Every relative `script src` on the entry page must be a real `.js` file. TypeScript is not enough. */
const guestBuiltScriptsReady = async (packageRoot, entry) => {
  const entryPath = await resolveGuestAssetPath(packageRoot, entry);
  if (!entryPath) {
    return false;
  }
  const html = await fs.readFile(entryPath, 'utf8');
  for (const href of listRelativeGuestScriptHrefs(html)) {
    const relativePath = resolveGuestHtmlRelativePath(entry, href);
    if (!relativePath || !relativePath.endsWith('.js')) {
      return false;
    }
    const filePath = await resolveGuestAssetPath(packageRoot, relativePath);
    if (!filePath) {
      return false;
    }
  }
  return true;
};

export const inspectGuestPackage = async (packageRoot, { openchamberVersion, skipEngineCheck } = {}) => {
  let raw;
  try {
    raw = await fs.readFile(path.join(packageRoot, 'package.json'), 'utf8');
  } catch {
    return { ok: false, code: 'invalid-manifest' };
  }
  const parsed = parseManifestJson(raw);
  if (!parsed.ok) {
    return { ok: false, code: 'invalid-manifest' };
  }
  if (!skipEngineCheck && !parsed.version) {
    return { ok: false, code: 'invalid-manifest' };
  }
  const engine = parsed.manifest.engines?.openchamber;
  if (engine && !skipEngineCheck) {
    const hostVersion = typeof openchamberVersion === 'string' ? openchamberVersion : '';
    if (!hostMeetsOpenChamberEngine(hostVersion, engine)) {
      return {
        ok: false,
        code: 'host-too-old',
        required: openChamberEngineMinimum(engine) ?? engine,
      };
    }
  }
  const panel = parsed.manifest.contributes.panel;
  const entryPath = await resolveGuestAssetPath(packageRoot, panel.entry);
  if (!entryPath) {
    return { ok: false, code: 'invalid-manifest' };
  }
  if (panel.icon.toLowerCase().endsWith('.svg')) {
    const iconPath = await resolveGuestAssetPath(packageRoot, panel.icon);
    if (!iconPath) {
      return { ok: false, code: 'invalid-manifest' };
    }
  }
  if (!await guestBuiltScriptsReady(packageRoot, panel.entry)) {
    return { ok: false, code: 'missing-build' };
  }
  const guest = {
    id: panel.id,
    name: panel.name,
    icon: panel.icon,
    entry: panel.entry,
    packageRoot,
  };
  if (parsed.version) {
    guest.version = parsed.version;
  }
  if (parsed.manifest.engines) {
    guest.engines = parsed.manifest.engines;
  }
  const attach = resolveAttachMode(parsed.manifest.contributes.attach);
  if (attach) {
    guest.attach = attach;
  }
  // A dialog page is checked like panel.entry: the HTML must exist and every
  // relative script it loads must already be built.
  const attachEntry = resolveAttachEntry(parsed.manifest.contributes);
  if (attachEntry) {
    if (!await resolveGuestAssetPath(packageRoot, attachEntry)) {
      return { ok: false, code: 'invalid-manifest' };
    }
    if (!await guestBuiltScriptsReady(packageRoot, attachEntry)) {
      return { ok: false, code: 'missing-build' };
    }
    guest.attachEntry = attachEntry;
  }
  if (parsed.manifest.contributes.capabilities?.length) {
    guest.capabilities = [...parsed.manifest.contributes.capabilities];
  }
  if (parsed.manifest.contributes.integration) {
    guest.integration = parsed.manifest.contributes.integration;
  }
  if (parsed.manifest.contributes.filesystem?.length) {
    guest.filesystem = [...parsed.manifest.contributes.filesystem];
  }
  if (parsed.manifest.contributes.actions?.length) {
    guest.actions = parsed.manifest.contributes.actions.map((action) => ({ ...action }));
  }
  if (parsed.manifest.contributes.commands?.length) {
    guest.commands = parsed.manifest.contributes.commands.map((command) => ({ ...command }));
  }
  if (parsed.manifest.contributes.service) {
    const serviceEntry = await resolveGuestAssetPath(packageRoot, parsed.manifest.contributes.service.entry);
    if (!serviceEntry) {
      return { ok: false, code: 'missing-build' };
    }
    guest.service = parsed.manifest.contributes.service;
  }
  return { ok: true, guest };
};

const loadGuestFromPackageRoot = async (packageRoot, options) => {
  const result = await inspectGuestPackage(packageRoot, options);
  return result.ok ? result.guest : null;
};

const withSource = (guest, source, displayPath) => ({
  ...guest,
  source,
  path: displayPath,
});

/** Catalog JSON. Drops packageRoot. Keeps attach only when true. */
export const toPublicGuest = (guest) => {
  const row = {
    id: guest.id,
    name: guest.name,
    icon: guest.icon,
    entry: guest.entry,
    source: guest.source,
    path: guest.path ?? null,
    enabled: guest.enabled !== false,
  };
  if (typeof guest.version === 'string' && guest.version) {
    row.version = guest.version;
  }
  const attach = resolveAttachMode(guest.attach);
  if (attach) {
    row.attach = attach;
  }
  if (attach === 'dialog' && typeof guest.attachEntry === 'string' && guest.attachEntry) {
    row.attachEntry = guest.attachEntry;
  }
  if (guest.integration) {
    row.integration = toPublicIntegration(guest.integration);
  }
  if (Array.isArray(guest.filesystem) && guest.filesystem.length > 0) {
    row.filesystem = [...guest.filesystem];
  }
  // Actions and commands are the parsed manifest entries as they are: the
  // UI decides which ones to show from the grant and the enabled flag.
  if (Array.isArray(guest.actions) && guest.actions.length > 0) {
    row.actions = guest.actions.map((action) => ({ ...action }));
  }
  if (Array.isArray(guest.commands) && guest.commands.length > 0) {
    row.commands = guest.commands.map((command) => ({ ...command }));
  }
  const granted = Array.isArray(guest.capabilityGrants) ? guest.capabilityGrants : [];
  row.capabilities = {
    requested: requestedGuestCapabilities(guest),
    granted,
  };
  const service = toPublicService(
    guest.service,
    granted.includes('service'),
    guest.socketBindings,
  );
  if (service) {
    row.service = service;
  }
  return row;
};

/**
 * The rail asks for every panel file through `findInstalledGuest`, and each
 * listing re-reads every package's manifest and HTML. A short-lived cache per
 * store file absorbs that burst; any store write drops it, and the TTL bounds
 * how long an on-disk edit to a folder-installed package goes unnoticed.
 */
const CATALOG_CACHE_TTL_MS = 5_000;
/** @type {Map<string, { expiresAt: number, guests: Awaited<ReturnType<typeof listInstalledGuestsUncached>> }>} */
const catalogCache = new Map();

export const invalidateGuestCatalog = (persistPath) => {
  if (persistPath) {
    catalogCache.delete(persistPath);
  } else {
    catalogCache.clear();
  }
};
onExtensionStoreWrite(invalidateGuestCatalog);

export const listInstalledGuests = async ({ persistPath } = {}) => {
  const cached = persistPath ? catalogCache.get(persistPath) : undefined;
  if (cached && cached.expiresAt > Date.now()) {
    return cached.guests;
  }
  const guests = await listInstalledGuestsUncached({ persistPath });
  if (persistPath) {
    catalogCache.set(persistPath, { guests, expiresAt: Date.now() + CATALOG_CACHE_TTL_MS });
  }
  return guests;
};

const listInstalledGuestsUncached = async ({ persistPath } = {}) => {
  const guests = [];
  const seen = new Set();

  const stored = await readExtensionStore(persistPath);
  for (const storedPath of stored.paths) {
    const root = await resolveGuestPackageRoot(storedPath);
    if (!root) {
      continue;
    }
    // Already-installed packages stay listed even if engines.openchamber is newer
    // than this host. Install is the gate.
    const guest = await loadGuestFromPackageRoot(root, { skipEngineCheck: true });
    if (!guest || seen.has(guest.id)) {
      continue;
    }
    seen.add(guest.id);
    const source = stored.sources[root] ?? stored.sources[storedPath] ?? 'path';
    const socketBindings = guest.service?.permissions?.sockets?.length
      ? await buildPublicSocketBindings(
        guest.service.permissions.sockets,
        stored.serviceSocketOverrides?.[guest.id] ?? {},
      )
      : undefined;
    guests.push({
      ...withSource(guest, source, root),
      capabilityGrants: stored.capabilityGrants?.[guest.id] ?? [],
      enabled: !stored.disabledGuests?.[guest.id],
      socketBindings,
    });
  }

  return guests;
};

export const findInstalledGuest = async (id, persistPath) => {
  if (!isGuestPanelId(id)) {
    return null;
  }
  const guests = await listInstalledGuests({ persistPath });
  return guests.find((guest) => guest.id === id) ?? null;
};
