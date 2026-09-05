import fs from 'node:fs/promises';
import path from 'node:path';

import { parseManifestJson, resolveAttachMode, toPublicAgent, toPublicIntegration, hostMeetsOpenChamberEngine, openChamberEngineMinimum } from '@openchamber/sdk';

import { listRelativeGuestScriptHrefs, resolveGuestHtmlRelativePath } from './html-tokens.js';
import { readExtensionStore } from './persist.js';
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
  if (parsed.manifest.contributes.integration) {
    guest.integration = parsed.manifest.contributes.integration;
  }
  if (parsed.manifest.contributes.agent) {
    const agentEntry = await resolveGuestAssetPath(packageRoot, parsed.manifest.contributes.agent.entry);
    if (!agentEntry) {
      return { ok: false, code: 'missing-build' };
    }
    guest.agent = parsed.manifest.contributes.agent;
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
  if (guest.integration) {
    row.integration = toPublicIntegration(guest.integration);
  }
  const agent = toPublicAgent(
    guest.agent,
    Boolean(guest.agentGranted),
    guest.socketBindings,
  );
  if (agent) {
    row.agent = agent;
  }
  return row;
};

export const listInstalledGuests = async ({ persistPath } = {}) => {
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
    const socketBindings = guest.agent?.permissions?.sockets?.length
      ? await buildPublicSocketBindings(
        guest.agent.permissions.sockets,
        stored.agentSocketOverrides?.[guest.id] ?? {},
      )
      : undefined;
    guests.push({
      ...withSource(guest, source, root),
      agentGranted: Boolean(stored.agentGrants?.[guest.id]),
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
