import fs from 'node:fs/promises';
import path from 'node:path';

import { GUEST_PROVIDER_LOGO_BYTES_MAX, hasGuestPage, requestedGuestCapabilities, resolveAttachEntry, resolveAttachMode, resolvePageEntry, resolvePageMobile, resolveStatusSectionEntry, resolveStatusSectionSource, toPublicNotifications,
  toPublicQuota, toPublicTracker, toPublicService, toPublicSessionEvents, toPublicSourceControl, toPublicIntegration, toPublicWaits, hostMeetsOpenChamberEngine, openChamberEngineMinimum } from '@openchamber/sdk';
import { parseManifestJson } from '@openchamber/sdk/schemas';

import { listRelativeGuestScriptHrefs, resolveGuestHtmlRelativePath } from './html-tokens.js';
import { effectiveGrants, guestGrantScope } from './grant-scope.js';
import { enterpriseBlockedCapabilities } from './enterprise.js';
import { readEnterprisePolicy } from '../enterprise-mode.js';
import { recoverGuestCheckouts, recoverIdleGuestCheckouts } from './checkout-swap.js';
import { ensureGuestStorageIds, onExtensionStoreWrite, readExtensionStore } from './persist.js';
import { buildPublicSocketBindings } from './sockets.js';
import { isReservedBuiltInId, readBuiltInRegistry } from './builtins.js';
import { resolveOpenCodePluginFolder } from './opencode-plugin.js';
import { toPublicLinks } from './links.js';
import type { GuestCapability } from '@openchamber/sdk';
import type { GuestPackage, GuestRecord } from './contracts.js';
import { hasErrorMessage, isString } from './input-guards.js';

const builtInsByStore = new Map<string, Awaited<ReturnType<typeof readBuiltInRegistry>>>();

export const registerBuiltInGuests = async ({ persistPath, root }: { persistPath: string; root?: string | undefined }) => {
  const registry = await readBuiltInRegistry(root);
  builtInsByStore.set(persistPath, registry);
  invalidateGuestCatalog(persistPath);
  return () => {
    if (builtInsByStore.get(persistPath) !== registry) return;
    builtInsByStore.delete(persistPath);
    invalidateGuestCatalog(persistPath);
  };
};

const PANEL_ID = /^[a-z][a-z0-9-]*$/;

const MIME_BY_EXT = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.png': 'image/png',
};
const isGuestAssetExtension = (extension: string): extension is keyof typeof MIME_BY_EXT => extension in MIME_BY_EXT;

export const isGuestPanelId = (value: unknown): value is string => typeof value === 'string' && PANEL_ID.test(value);

const isGuestPackageFolder = async (packageRoot: string, relativePath: string) => {
  try {
    const rootReal = await fs.realpath(packageRoot);
    const candidate = await fs.realpath(path.resolve(rootReal, relativePath));
    return candidate.startsWith(rootReal + path.sep) && (await fs.stat(candidate)).isDirectory();
  } catch {
    return false;
  }
};

export const resolveGuestAssetPath = async (packageRoot: string, relativePath: string | undefined) => {
  if (!isString(relativePath) || relativePath.includes('\0') || relativePath.includes('\\')) {
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

export const guestAssetContentType = (filePath: string) => {
  const extension = path.extname(filePath).toLowerCase();
  return isGuestAssetExtension(extension) ? MIME_BY_EXT[extension] ?? null : null;
};

const isGuestFrameContentType = (contentType: string) => (
  contentType.startsWith('text/html') || contentType.startsWith('text/javascript')
);

export const resolveGuestServedFile = async (packageRoot: string, relativePath: string, { hasRuntime = true } = {}) => {
  const filePath = await resolveGuestAssetPath(packageRoot, relativePath);
  const contentType = filePath ? guestAssetContentType(filePath) : null;
  if (contentType && !hasRuntime && isGuestFrameContentType(contentType)) {
    return null;
  }
  if (filePath && contentType) {
    return { filePath, contentType };
  }
  if (!hasRuntime || !relativePath.endsWith('.js')) {
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

export const resolveGuestPackageRoot = async (rawPath: string | null | undefined) => {
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

const guestBuiltScriptsReady = async (packageRoot: string, entry: string) => {
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

const isDrawableProviderLogo = async (packageRoot: string, relativePath: string) => {
  const resolved = await resolveGuestAssetPath(packageRoot, relativePath);
  if (!resolved) return false;
  const { size } = await fs.stat(resolved);
  return size > 0 && size <= GUEST_PROVIDER_LOGO_BYTES_MAX;
};

type InspectionOptions = { openchamberVersion?: string | undefined; skipEngineCheck?: boolean };
type InspectionResult = { ok: true; guest: GuestPackage } | { ok: false; code: string; reason?: string; required?: string };

export const inspectGuestPackage = async (packageRoot: string, { openchamberVersion, skipEngineCheck }: InspectionOptions = {}): Promise<InspectionResult> => {
  let raw;
  try {
    raw = await fs.readFile(path.join(packageRoot, 'package.json'), 'utf8');
  } catch {
    return { ok: false, code: 'invalid-manifest' };
  }
  const parsed = parseManifestJson(raw);
  if (!parsed.ok) {
    return { ok: false, code: 'invalid-manifest', reason: parsed.message };
  }
  if (!skipEngineCheck && !parsed.version) {
    return { ok: false, code: 'invalid-manifest' };
  }
  const engine = parsed.manifest.engines?.openchamber;
  if (engine && !skipEngineCheck) {
    const hostVersion = openchamberVersion ?? '';
    if (!hostMeetsOpenChamberEngine(hostVersion, engine)) {
      return {
        ok: false,
        code: 'host-too-old',
        required: openChamberEngineMinimum(engine) ?? engine,
      };
    }
  }
  const panel = parsed.manifest.contributes.panel;
  if (hasGuestPage(parsed.manifest.contributes)) {
    const entryPath = await resolveGuestAssetPath(packageRoot, panel.entry);
    if (!entryPath) {
      return { ok: false, code: 'invalid-manifest' };
    }
  }
  if (panel.icon.toLowerCase().endsWith('.svg')) {
    const iconPath = await resolveGuestAssetPath(packageRoot, panel.icon);
    if (!iconPath) {
      return { ok: false, code: 'invalid-manifest' };
    }
  }
  if (panel.entry && !await guestBuiltScriptsReady(packageRoot, panel.entry)) {
    return { ok: false, code: 'missing-build' };
  }
  const guest: GuestPackage = {
    id: panel.id,
    name: panel.name,
    icon: panel.icon,
    packageRoot,
  };
  if (panel.entry) {
    guest.entry = panel.entry;
  }
  if (panel.dock !== undefined) {
    guest.entryDock = panel.dock;
  }
  if (panel.size !== undefined) {
    guest.entrySize = panel.size;
  }
  if (panel.entry && panel.mobile === true) {
    guest.entryMobile = true;
  }
  const backgroundEntry = parsed.manifest.contributes.background?.entry;
  if (backgroundEntry) {
    if (!await resolveGuestAssetPath(packageRoot, backgroundEntry)) {
      return { ok: false, code: 'invalid-manifest' };
    }
    if (!await guestBuiltScriptsReady(packageRoot, backgroundEntry)) {
      return { ok: false, code: 'missing-build' };
    }
    guest.backgroundEntry = backgroundEntry;
  }
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
  const pageEntry = resolvePageEntry(parsed.manifest.contributes);
  if (pageEntry) {
    if (!await resolveGuestAssetPath(packageRoot, pageEntry)) {
      return { ok: false, code: 'invalid-manifest' };
    }
    if (!await guestBuiltScriptsReady(packageRoot, pageEntry)) {
      return { ok: false, code: 'missing-build' };
    }
    guest.pageEntry = pageEntry;
    const page = parsed.manifest.contributes.page;
    if (page !== true && page?.title) guest.pageTitle = page.title;
    if (resolvePageMobile(parsed.manifest.contributes)) guest.pageMobile = true;
  }
  const statusEntry = resolveStatusSectionEntry(parsed.manifest.contributes);
  if (statusEntry) {
    if (!await resolveGuestAssetPath(packageRoot, statusEntry)) {
      return { ok: false, code: 'invalid-manifest' };
    }
    if (!await guestBuiltScriptsReady(packageRoot, statusEntry)) {
      return { ok: false, code: 'missing-build' };
    }
    guest.statusEntry = statusEntry;
  }
  const statusSource = resolveStatusSectionSource(parsed.manifest.contributes);
  if (statusSource) guest.statusSource = statusSource;
  if (statusEntry || statusSource) {
    const section = parsed.manifest.contributes.statusSection;
    if (section !== true && section?.title) guest.statusTitle = section.title;
    if (section !== true && section?.height !== undefined) guest.statusHeight = section.height;
    if (section !== true && section?.defaultExpanded !== undefined) guest.statusDefaultExpanded = section.defaultExpanded;
    if (section !== true && section?.requiresProject !== undefined) guest.statusRequiresProject = section.requiresProject;
  }
  const fileEditors = parsed.manifest.contributes.fileEditors ?? [];
  for (const editor of fileEditors) {
    if (!await resolveGuestAssetPath(packageRoot, editor.entry)) {
      return { ok: false, code: 'invalid-manifest' };
    }
    if (!await guestBuiltScriptsReady(packageRoot, editor.entry)) {
      return { ok: false, code: 'missing-build' };
    }
  }
  const blocks = parsed.manifest.contributes.blocks ?? [];
  for (const block of blocks) {
    if (!await resolveGuestAssetPath(packageRoot, block.entry)) {
      return { ok: false, code: 'invalid-manifest' };
    }
    if (!await guestBuiltScriptsReady(packageRoot, block.entry)) {
      return { ok: false, code: 'missing-build' };
    }
  }
  if (blocks.length > 0) {
    guest.blocks = blocks.map((block) => ({ ...block, args: [...block.args] }));
  }
  if (fileEditors.length > 0) {
    guest.fileEditors = fileEditors.map((editor) => ({ ...editor, match: [...editor.match] }));
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
  if (parsed.manifest.contributes.origins?.length) {
    guest.origins = [...parsed.manifest.contributes.origins];
  }
  if (parsed.manifest.contributes.actions?.length) {
    guest.actions = parsed.manifest.contributes.actions.map((action) => ({ ...action }));
  }
  if (parsed.manifest.contributes.commands?.length) {
    guest.commands = parsed.manifest.contributes.commands.map((command) => ({ ...command }));
  }
  if (parsed.manifest.contributes.tools?.length) {
    guest.tools = parsed.manifest.contributes.tools.map((tool) => ({ ...tool }));
  }
  const providerLogos = parsed.manifest.contributes.providerLogos;
  if (providerLogos) {
    for (const logo of new Set(Object.values(providerLogos))) {
      if (!await isDrawableProviderLogo(packageRoot, logo)) {
        return { ok: false, code: 'invalid-manifest' };
      }
    }
    guest.providerLogos = { ...providerLogos };
  }
  if (parsed.manifest.contributes.service) {
    const serviceEntry = await resolveGuestAssetPath(packageRoot, parsed.manifest.contributes.service.entry);
    if (!serviceEntry) {
      return { ok: false, code: 'missing-build' };
    }
    guest.service = parsed.manifest.contributes.service;
  }
  if (parsed.manifest.contributes.sourceControl) {
    guest.sourceControl = parsed.manifest.contributes.sourceControl;
  }
  if (parsed.manifest.contributes.sessionEvents) {
    guest.sessionEvents = parsed.manifest.contributes.sessionEvents;
  }
  if (parsed.manifest.contributes.waits) {
    guest.waits = parsed.manifest.contributes.waits;
  }
  if (parsed.manifest.contributes.notifications) {
    guest.notifications = parsed.manifest.contributes.notifications;
  }
  if (parsed.manifest.contributes.tracker) {
    guest.tracker = parsed.manifest.contributes.tracker;
  }
  if (parsed.manifest.contributes.quota) {
    guest.quota = parsed.manifest.contributes.quota;
  }
  if (parsed.manifest.contributes.sessionControl) {
    guest.sessionControl = parsed.manifest.contributes.sessionControl;
  }
  if (parsed.manifest.contributes.instructions) {
    guest.instructions = true;
  }
  if (parsed.manifest.contributes.marks) {
    guest.marks = true;
  }
  if (parsed.manifest.contributes.mentions) {
    guest.mentions = parsed.manifest.contributes.mentions;
  }
  if (parsed.manifest.contributes.links) {
    guest.links = parsed.manifest.contributes.links;
  }
  if (parsed.manifest.contributes.skills) {
    if (!await isGuestPackageFolder(packageRoot, parsed.manifest.contributes.skills)) {
      return { ok: false, code: 'invalid-manifest' };
    }
    guest.skills = parsed.manifest.contributes.skills;
  }
  if (parsed.manifest.contributes.opencodePlugin) {
    if (!await resolveOpenCodePluginFolder(fs, packageRoot, parsed.manifest.contributes.opencodePlugin)) {
      return { ok: false, code: 'invalid-opencode-plugin' };
    }
    guest.opencodePlugin = parsed.manifest.contributes.opencodePlugin;
  }
  return { ok: true, guest };
};

const loadGuestFromPackageRoot = async (packageRoot: string, options: InspectionOptions) => {
  const result = await inspectGuestPackage(packageRoot, options);
  return result.ok ? result.guest : null;
};

const withSource = (guest: GuestPackage, source: string, displayPath: string | null) => ({
  ...guest,
  source,
  path: displayPath,
});

export const hasGuestFrame = (guest: GuestPackage) => Boolean(
  guest.entry || guest.backgroundEntry || guest.pageEntry || guest.statusEntry
    || (Array.isArray(guest.fileEditors) && guest.fileEditors.length > 0)
    || (Array.isArray(guest.blocks) && guest.blocks.length > 0),
);

const configurationNotes = new Map<string, string>();

export const setGuestConfigurationNote = (guestId: string, message: string | null) => {
  const previous = configurationNotes.get(guestId) ?? null;
  if (previous === message) return false;
  if (message === null) configurationNotes.delete(guestId);
  else configurationNotes.set(guestId, message);
  return true;
};

export type PublicGuest = Omit<GuestRecord, 'source' | 'packageRoot' | 'service' | 'sourceControl' | 'sessionEvents' | 'waits' | 'notifications' | 'tracker' | 'quota' | 'integration' | 'links' | 'skills' | 'opencodePlugin' | 'capabilities' | 'sessionControl' | 'mentions'> & {
  source: string | undefined;
  path: string | null;
  enabled: boolean;
  service?: NonNullable<ReturnType<typeof toPublicService>>;
  sourceControl?: ReturnType<typeof toPublicSourceControl>;
  sessionEvents?: ReturnType<typeof toPublicSessionEvents>;
  waits?: ReturnType<typeof toPublicWaits>;
  notifications?: ReturnType<typeof toPublicNotifications>;
  tracker?: ReturnType<typeof toPublicTracker>;
  quota?: ReturnType<typeof toPublicQuota>;
  integration?: ReturnType<typeof toPublicIntegration>;
  links?: ReturnType<typeof toPublicLinks>;
  capabilities?: { requested: GuestCapability[]; granted: GuestCapability[] };
  skills?: true;
  opencodePlugin?: true;
  sessionControl?: { content: boolean };
  mentions?: { label: string };
  toolLinkSettings?: Record<string, string>;
  origin?: { url: string; ref?: string };
  needsConfiguration?: string;
};

export const toPublicGuest = (guest: GuestRecord, toolLinkSettings: Record<string, string> | null = null) => {
  const row: PublicGuest = {
    id: guest.id,
    name: guest.name,
    icon: guest.icon,
    source: guest.source,
    path: guest.path ?? null,
    enabled: guest.enabled !== false,
  };
  if (guest.enterpriseBlocked?.length) {
    row.enterpriseBlocked = [...guest.enterpriseBlocked];
  }
  if (guest.folders?.length) {
    row.folders = [...guest.folders];
  }
  if (guest.entry) {
    row.entry = guest.entry;
  }
  if (guest.entryDock) {
    row.entryDock = guest.entryDock;
  }
  if (guest.entrySize !== undefined) {
    row.entrySize = guest.entrySize;
  }
  if (guest.entryMobile === true) {
    row.entryMobile = true;
  }
  if (guest.backgroundEntry) {
    row.backgroundEntry = guest.backgroundEntry;
  }
  if (guest.version) {
    row.version = guest.version;
  }
  if (guest.revision !== undefined && guest.revision > 0) {
    row.revision = guest.revision;
  }
  if (guest.source === 'git' && guest.gitOrigin) {
    row.origin = guest.gitOrigin.ref
      ? { url: guest.gitOrigin.url, ref: guest.gitOrigin.ref }
      : { url: guest.gitOrigin.url };
  }
  if (guest.update?.version) {
    row.update = { version: guest.update.version };
  }
  const attach = resolveAttachMode(guest.attach);
  if (guest.pageEntry) row.pageEntry = guest.pageEntry;
  if (guest.pageTitle) row.pageTitle = guest.pageTitle;
  if (guest.pageMobile === true) row.pageMobile = true;
  if (guest.statusEntry) row.statusEntry = guest.statusEntry;
  if (guest.statusSource) row.statusSource = { path: guest.statusSource.path, interval: guest.statusSource.interval };
  if (guest.statusTitle) row.statusTitle = guest.statusTitle;
  if (guest.statusHeight !== undefined && Number.isInteger(guest.statusHeight)) row.statusHeight = guest.statusHeight;
  if (guest.statusDefaultExpanded !== undefined) row.statusDefaultExpanded = guest.statusDefaultExpanded;
  if (guest.statusRequiresProject !== undefined) row.statusRequiresProject = guest.statusRequiresProject;
  if (attach) {
    row.attach = attach;
  }
  if (attach === 'dialog' && guest.attachEntry) {
    row.attachEntry = guest.attachEntry;
  }
  if (guest.integration) {
    row.integration = toPublicIntegration(guest.integration);
  }
  if (Array.isArray(guest.filesystem) && guest.filesystem.length > 0) {
    row.filesystem = [...guest.filesystem];
  }
  if (Array.isArray(guest.origins) && guest.origins.length > 0) {
    row.origins = [...guest.origins];
  }
  if (Array.isArray(guest.actions) && guest.actions.length > 0) {
    row.actions = guest.actions.map((action) => ({ ...action }));
  }
  if (Array.isArray(guest.commands) && guest.commands.length > 0) {
    row.commands = guest.commands.map((command) => ({ ...command }));
  }
  if (Array.isArray(guest.blocks) && guest.blocks.length > 0) {
    row.blocks = guest.blocks.map((block) => ({ ...block, args: [...block.args] }));
  }
  if (Array.isArray(guest.fileEditors) && guest.fileEditors.length > 0) {
    row.fileEditors = guest.fileEditors.map((editor) => ({ ...editor, match: [...editor.match] }));
  }
  if (Array.isArray(guest.tools) && guest.tools.length > 0) {
    row.tools = guest.tools.map((tool) => ({ ...tool }));
  }
  if (toolLinkSettings && Object.keys(toolLinkSettings).length > 0) {
    row.toolLinkSettings = { ...toolLinkSettings };
  }
  if (guest.providerLogos) {
    row.providerLogos = { ...guest.providerLogos };
  }
  const granted = Array.isArray(guest.capabilityGrants) ? guest.capabilityGrants : [];
  row.capabilities = {
    requested: requestedGuestCapabilities(guest),
    granted,
  };
  if (guest.storageId && requestedGuestCapabilities(guest).every((capability) => granted.includes(capability))) {
    row.storageId = guest.storageId;
  }
  const service = toPublicService(
    guest.service,
    granted.includes('service'),
    guest.socketBindings,
  );
  if (service) {
    row.service = service;
  }
  if (guest.sourceControl) {
    row.sourceControl = toPublicSourceControl(guest.sourceControl);
  }
  if (guest.sessionEvents) {
    row.sessionEvents = toPublicSessionEvents(guest.sessionEvents);
  }
  if (guest.waits) {
    row.waits = toPublicWaits(guest.waits);
  }
  if (guest.notifications) {
    row.notifications = toPublicNotifications(guest.notifications);
  }
  if (guest.tracker) {
    row.tracker = toPublicTracker(guest.tracker);
  }
  if (guest.quota) {
    row.quota = toPublicQuota(guest.quota);
  }
  if (guest.sessionControl) {
    row.sessionControl = { content: guest.sessionControl.content === true };
  }
  if (guest.instructions) {
    row.instructions = true;
  }
  if (guest.marks) {
    row.marks = true;
  }
  if (guest.skills) {
    row.skills = true;
  }
  if (guest.opencodePlugin) {
    row.opencodePlugin = true;
  }
  if (guest.mentions) {
    row.mentions = { label: guest.mentions.label };
  }
  if (guest.links) {
    try {
      row.links = toPublicLinks(guest.links);
    } catch (error) {
      console.warn(`[guests] links of ${guest.id} left out: ${hasErrorMessage(error) ? error.message ?? error : error}`);
    }
  }
  const configurationNote = configurationNotes.get(guest.id);
  if (configurationNote) {
    row.needsConfiguration = configurationNote;
  }
  return row;
};

const CATALOG_CACHE_TTL_MS = 5_000;
const catalogCache = new Map<string, { expiresAt: number; guests: InstalledGuest[] }>();
const catalogVersions = new Map<string, number>();

const catalogVersionOf = (persistPath: string) => catalogVersions.get(persistPath) ?? 0;

export const invalidateGuestCatalog = (persistPath?: string) => {
  if (persistPath) {
    catalogCache.delete(persistPath);
    catalogVersions.set(persistPath, catalogVersionOf(persistPath) + 1);
  } else {
    for (const key of catalogCache.keys()) {
      catalogVersions.set(key, catalogVersionOf(key) + 1);
    }
    catalogCache.clear();
  }
};
onExtensionStoreWrite(invalidateGuestCatalog);

const packageRevisions = new Map<string, Map<string, number>>();

const lastLoadedGuests = new Map<string, { guest: GuestPackage; unloaded: boolean }>();

export const lastLoadedGuestAt = (packageRoot: string) => lastLoadedGuests.get(packageRoot)?.guest ?? null;

export const isGuestPackageUnloaded = (packageRoot: string) => lastLoadedGuests.get(packageRoot)?.unloaded === true;

export const noteGuestPackageChanged = (persistPath: string, id: string) => {
  const revisions = packageRevisions.get(persistPath) ?? new Map();
  revisions.set(id, (revisions.get(id) ?? 0) + 1);
  packageRevisions.set(persistPath, revisions);
  invalidateGuestCatalog(persistPath);
};

export type InstalledGuest = GuestRecord & { source: string; capabilityGrants: GuestCapability[] };

const withEnterprisePolicy = (guests: InstalledGuest[]) => {
  const policy = readEnterprisePolicy();
  if (!policy.enterpriseMode) return guests;
  return guests.map((guest) => {
    const blocked = enterpriseBlockedCapabilities(guest, { source: guest.source, gitUrl: guest.gitOrigin?.url }, policy);
    if (blocked.length === 0) return guest;
    return {
      ...guest,
      capabilityGrants: guest.capabilityGrants.filter((capability) => !blocked.includes(capability)),
      enterpriseBlocked: blocked,
    };
  });
};

const recoveryListeners = new Map<string, (guestId: string) => void>();

export const onGuestCheckoutRecovered = (persistPath: string, listener: (guestId: string) => void) => {
  recoveryListeners.set(persistPath, listener);
};

export const listInstalledGuests = async ({ persistPath, underCheckoutLock = false }: { persistPath: string; underCheckoutLock?: boolean }) => {
  const cached = persistPath && !underCheckoutLock ? catalogCache.get(persistPath) : undefined;
  if (cached && cached.expiresAt > Date.now()) {
    return withEnterprisePolicy(cached.guests);
  }
  const recovered = persistPath ? await (underCheckoutLock ? recoverGuestCheckouts : recoverIdleGuestCheckouts)(persistPath) : [];
  if (recovered.length > 0) invalidateGuestCatalog(persistPath);
  for (const id of recovered) recoveryListeners.get(persistPath)?.(id);
  const version = persistPath ? catalogVersionOf(persistPath) : 0;
  const guests = await listInstalledGuestsUncached({ persistPath });
  if (persistPath && catalogVersionOf(persistPath) === version) {
    catalogCache.set(persistPath, { guests, expiresAt: Date.now() + CATALOG_CACHE_TTL_MS });
  }
  return withEnterprisePolicy(guests);
};

const listInstalledGuestsUncached = async ({ persistPath }: { persistPath: string }): Promise<InstalledGuest[]> => {
  const guests: Array<InstalledGuest & { storageDescriptor?: { id: string; storedPath: string | null; builtIn: boolean } }> = [];
  const seen = new Set();

  const stored = await readExtensionStore(persistPath);
  const builtIns = builtInsByStore.get(persistPath);
  if (builtIns) {
    for (const entry of builtIns.extensions) {
      seen.add(entry.id);
      const root = await fs.realpath(path.join(builtIns.root, entry.directory)).catch(() => null);
      if (!root || !root.startsWith(builtIns.root + path.sep)) {
        console.warn(`Built-in extension is unavailable: ${entry.id}`);
        continue;
      }
      const guest = await loadGuestFromPackageRoot(root, { skipEngineCheck: true }).catch(() => null);
      if (!guest || guest.id !== entry.id) {
        console.warn(`Built-in extension is invalid: ${entry.id}`);
        continue;
      }
      const socketBindings = guest.service?.permissions?.sockets?.length
        ? await buildPublicSocketBindings(guest.service.permissions.sockets, stored.serviceSocketOverrides?.[guest.id] ?? {})
        : undefined;
      guests.push({
        ...withSource(guest, 'bundled', null),
        capabilityGrants: requestedGuestCapabilities(guest),
        enabled: !stored.disabledGuests?.[guest.id],
        folders: stored.guestFolders?.[guest.id],
        socketBindings,
        storageDescriptor: { id: guest.id, storedPath: null, builtIn: true },
      });
    }
  }
  for (const storedPath of stored.paths) {
    const root = await resolveGuestPackageRoot(storedPath);
    if (!root) {
      continue;
    }
    const loaded = await loadGuestFromPackageRoot(root, { skipEngineCheck: true });
    const previous = lastLoadedGuests.get(root);
    if (loaded) lastLoadedGuests.set(root, { guest: loaded, unloaded: false });
    else if (previous) lastLoadedGuests.set(root, { guest: previous.guest, unloaded: true });
    const guest = loaded ?? previous?.guest;
    if (!guest || seen.has(guest.id) || isReservedBuiltInId(guest.id)) {
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
    const gitOrigin = source === 'git'
      ? stored.gitOrigins[root] ?? stored.gitOrigins[storedPath]
      : undefined;
    guests.push({
      ...withSource(guest, source, root),
      gitOrigin,
      capabilityGrants: effectiveGrants(
        stored.capabilityGrants?.[guest.id] ?? [],
        stored.capabilityScopes?.[guest.id],
        guestGrantScope(guest),
      ),
      enabled: !stored.disabledGuests?.[guest.id],
      folders: stored.guestFolders?.[guest.id],
      socketBindings,
      revision: packageRevisions.get(persistPath)?.get(guest.id) ?? 0,
      storageDescriptor: { id: guest.id, storedPath, builtIn: false },
    });
  }

  const descriptors = guests.flatMap((guest) => guest.storageDescriptor ? [guest.storageDescriptor] : []);
  if (descriptors.some(({ id }) => !stored.storageIds?.[id])) {
    try {
      const identities = await ensureGuestStorageIds(persistPath, descriptors);
      for (const guest of guests) guest.storageId = identities[guest.id];
    } catch {
      console.warn('Guest storage identities are temporarily unavailable.');
    }
  } else {
    for (const guest of guests) guest.storageId = stored.storageIds?.[guest.id];
  }
  for (const guest of guests) delete guest.storageDescriptor;
  return guests;
};

export const findInstalledGuest = async (id: string, persistPath: string) => {
  if (!isGuestPanelId(id)) {
    return null;
  }
  const guests = await listInstalledGuests({ persistPath });
  return guests.find((guest) => guest.id === id) ?? null;
};
