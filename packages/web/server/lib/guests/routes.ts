import express from 'express';
import { guestStorageRequestSchema } from '@openchamber/sdk/schemas';
import { runGuestStorage } from './storage.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import { z } from 'zod';
import type { Application, Request, Response, QueryValue } from '../shared/http-contracts.js';
import type { InstalledGuest } from './catalog.js';
import type { GuestRecord, JsonValue } from './contracts.js';
import type { TrackerRegistry } from '../trackers/tracker-contract.js';
import { hasErrorCode, hasErrorMessage, hasErrorName, hasStatusCode, isString } from './input-guards.js';
import { isRecord } from '../shared/object-guards.js';

import {
  GUEST_CAPABILITIES,
  GUEST_GENERATE_OUTPUT_TOKENS_MAX,
  GUEST_GENERATE_PROMPT_MAX,
  GUEST_GENERATE_SYSTEM_MAX,
  GUEST_GENERATE_TEXT_MAX,
  GUEST_FILE_CONTENT_MAX,
  GUEST_FILE_PATH_MAX,
  guestFramePolicy,
  guestToolLinkSettingIds,
  isGuestRequestPath,
  requestedGuestCapabilities,
  resolveIntegrationAuth,
} from '@openchamber/sdk';

import {
  findInstalledGuest,
  hasGuestFrame,
  inspectGuestPackage,
  invalidateGuestCatalog,
  isGuestPanelId,
  lastLoadedGuestAt,
  listInstalledGuests,
  noteGuestPackageChanged,
  resolveGuestServedFile,
  toPublicGuest,
} from './catalog.js';
import { readInstallFolders, readUploadFolders, registerGuestAvailabilityRoutes } from './availability-routes.js';
import { guestMarks, mayGuestShowMarks } from './marks.js';
import { createGuestPackageWatch } from './package-watch.js';
import { runGuestFileOperation } from './files.js';
import { createGuestFrameGrants } from './frame-grants.js';
import { injectGuestAssetTokens, parseGuestUrlToken } from './html-tokens.js';
import { injectGuestDocumentStyles } from './html-styles.js';
import { installGuest, installGuestFromZipBuffer, parseInstallRequest, uninstallGuest } from './install.js';
import { enterpriseBlockedCapabilities } from './enterprise.js';
import { resolveOpenCodePluginFolder } from './opencode-plugin.js';
import { themedLogoSvg } from '../appearance/provider-logo-routes.js';
import { guestUploadMaxBytes, readGuestUploadBody } from './upload.js';
import { checkAllGuestUpdates, updateGuest, withGuestUpdate } from './updates.js';
import { extensionsPersistPath, readExtensionStore, setCapabilityGrants } from './persist.js';
import { guestGrantScope, sameCredentialTarget } from './grant-scope.js';
import { dropGuestTokens, forgetGuestAuth, getGuestAuth, guestAuthPersistPath, patchGuestAuth, readGuestAuthStore } from './auth-store.js';
import {
  disconnectHostGuest,
  startHostGuestAuthorization,
  toGuestAuthResponse,
} from './host-session.js';
import {
  GuestOAuthError,
  consumeGuestAuthorization,
  disconnectGuestAuth,
  saveGuestOAuthClient,
  guestRedirectUri,
  saveGuestAccessToken,
  startGuestAuthorization,
  takeUsableGuestAuth,
  toPublicGuestAuth,
  toolLinkSettingsOf,
} from './oauth.js';
import { isMentionGuest, resolveGuestMention, searchGuestMentions } from './mentions.js';
import { proxyGuestRequest } from './request.js';
import {
  GuestServiceError,
  getServiceFailure,
  getServiceStatus,
  proxyGuestServiceRequest,
  setServiceSocketOverride,
  stopGuestService,
} from './service.js';

const json16 = express.json({ limit: '16kb' });
const json80 = express.json({ limit: '80kb' });
const jsonFiles = express.json({ limit: '12mb' });
const jsonGenerate = express.json({ limit: '512kb' });

const clientBodySchema = z.object({
  clientId: z.string().trim().min(1).max(400),
  clientSecret: z.string().trim().min(1).max(400).optional(),
});

const tokenBodySchema = z.object({
  token: z.string().trim().min(1).max(800),
  username: z.string().trim().max(200).optional(),
});

const capabilityGrantSchema = z.object({
  granted: z.array(z.enum(GUEST_CAPABILITIES)).max(GUEST_CAPABILITIES.length),
});

const requestBodySchema = z.object({
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  path: z.string().trim().min(1).refine(isGuestRequestPath),
  query: z.record(z.string().min(1).max(128), z.string().max(2000)).optional(),
  body: z.string().max(64_000).optional(),
});

const serviceRequestBodySchema = requestBodySchema.extend({
  viewerId: z.string().min(1).max(128).optional(),
});

const fileBodySchema = z.object({
  op: z.enum(['read', 'write', 'list', 'stat']),
  path: z.string().min(1).max(GUEST_FILE_PATH_MAX),
  content: z.string().max(GUEST_FILE_CONTENT_MAX).optional(),
}).refine((value) => value.op !== 'write' || value.content !== undefined, { path: ['content'] });

const generateBodySchema = z.object({
  prompt: z.string().trim().min(1).max(GUEST_GENERATE_PROMPT_MAX),
  system: z.string().trim().min(1).max(GUEST_GENERATE_SYSTEM_MAX).optional(),
  maxOutputTokens: z.number().int().min(1).max(GUEST_GENERATE_OUTPUT_TOKENS_MAX).optional(),
});

const providerHeaderSchema = z.string().trim().min(1).max(200);

const guestHostSchema = z.string().regex(/^(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$/);

const socketOverrideBodySchema = z.object({
  id: z.string().trim().regex(/^[a-z][a-z0-9-]*$/).max(64),
  path: z.union([
    z.string().trim().min(1).max(512).refine((value) => !value.includes('\0')),
    z.literal(''),
    z.null(),
  ]).optional(),
});

const updateCheckBodySchema = z.object({
  force: z.boolean().optional(),
});

const queryValue = (req: Request, key: string) => {
  const raw = req.query?.[key];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return isString(value) ? value.trim() : '';
};

export const requestOrigin = (req: Pick<Request, 'headers' | 'secure'>) => {
  const forwarded = req.headers['x-forwarded-proto'];
  const proto = isString(forwarded) && forwarded.split(',')[0]
    ? forwarded.split(',')[0]?.trim()
    : req.secure
      ? 'https'
      : 'http';
  const hostHeader = req.headers['x-forwarded-host'] || req.headers.host;
  const host = isString(hostHeader) ? hostHeader.split(',')[0]?.trim() : '';
  if (!host) {
    return null;
  }
  return `${proto}://${host}`;
};

const escapeHtml = <Value>(value: Value) => String(value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

export const renderOauthCallbackPage = <Message>({ title, message }: { title: string; message: Message }) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} — OpenChamber</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
         font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
         background: Canvas; color: CanvasText; }
  main { max-width: 34rem; padding: 2.5rem 2rem; text-align: center; }
  h1 { font-size: 1.25rem; margin: 0 0 0.75rem; }
  p { margin: 0; line-height: 1.5; opacity: 0.85; }
</style>
</head>
<body>
<main>
<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(message)}</p>
</main>
</body>
</html>`;

type GuestUpdateErrorResponse = { error: string; required?: string };
type GuestInstallErrorResponse = GuestUpdateErrorResponse & { capabilities?: string[] | undefined; id?: string; reason?: string };

const sendInstallResult = (res: Response, result: Awaited<ReturnType<typeof installGuest>>) => {
  if (!result.ok) {
    const conflict = result.code === 'id-taken' || result.code === 'already-installed';
    const body: GuestInstallErrorResponse = { error: result.code };
    if (result.code === 'host-too-old' && result.required) {
      body.required = result.required;
    }
    if (result.code === 'enterprise-mode') {
      body.capabilities = result.capabilities;
      return res.status(403).json(body);
    }
    if (conflict && result.id) {
      body.id = result.id;
    }
    if (result.code === 'invalid-manifest' && result.reason) {
      body.reason = result.reason.slice(0, 1000);
    }
    return res.status(conflict ? 409 : 400).json(body);
  }
  res.status(result.replaced ? 200 : 201).json({ guest: result.guest });
};

const declaredSettings = (guest: GuestRecord) => {
  const fields = guest.integration?.settings ?? [];
  return new Map(fields.map((field) => [field.id, field]));
};

export type GuestDeactivation = { guestId: string; guestName: string; removed?: boolean };
export const settleGuestDeactivationListeners = (listeners: { name: string; listener: (event: GuestDeactivation) => void }[]) => async (event: GuestDeactivation) => {
  const results = await Promise.allSettled(listeners.map(async ({ listener }) => listener(event)));
  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      console.warn(`Failed to ${listeners[index]?.name}:`, result.reason?.message ?? result.reason);
    }
  });
};

const PANEL_SERVICE_IDLE_MS = 10 * 60_000;

export type GuestRoutesOptions = {
  openchamberDataDir: string;
  openchamberVersion?: string;
  resolveGitBinaryForSpawn: () => string;
  resolveOptionalProjectDirectory: (req: Request) => Promise<{ directory: string | null }> | { directory: string | null };
  getSmallModelService: () => Promise<{
    generateSmallModelText: (input: z.infer<typeof generateBodySchema> & {
      directory: string | undefined;
      preferredProviderID: string | undefined;
      preferredModelID: string | undefined;
    }) => Promise<{ text: string }>;
  }>;
  onGuestDeactivated?: (event: GuestDeactivation) => void;
  onGuestActivated?: (event: { guestId: string }) => void;
  onGuestsChanged?: () => void;
  watchFolderInstalls?: boolean;
  surfaceViewerHeaders?: (guestId: string, viewerId: string) => Record<string, string> | null;
  trackers?: TrackerRegistry | null;
  opencodePlugins?: {
    delivery: () => string;
    readGlobalEntries: () => { path: string; targets: string[] };
    addGlobalEntry: (directory: string) => { path: string; added: boolean };
  };
  marks?: typeof guestMarks;
};

export const registerGuestRoutes = (app: Application, {
  openchamberDataDir,
  openchamberVersion,
  resolveGitBinaryForSpawn,
  resolveOptionalProjectDirectory,
  getSmallModelService,
  onGuestDeactivated = async () => false,
  onGuestActivated = async () => undefined,
  onGuestsChanged = () => undefined,
  watchFolderInstalls = false,
  surfaceViewerHeaders = () => null,
  trackers = null,
  opencodePlugins = {
    delivery: () => 'file',
    readGlobalEntries: () => ({ path: '', targets: [] }),
    addGlobalEntry: () => { throw new Error('No global OpenCode config here.'); },
  },
  marks = guestMarks,
}: GuestRoutesOptions) => {
  const persistPath = extensionsPersistPath(openchamberDataDir);
  const authPath = guestAuthPersistPath(openchamberDataDir);
  const frameGrants = createGuestFrameGrants();
  const installOptions = () => ({ openchamberVersion, gitBinary: resolveGitBinaryForSpawn() });

  const announce = () => {
    try {
      onGuestsChanged();
    } catch (error) {
      console.warn('Failed to announce an extension change:', (hasErrorMessage(error) ? error.message : undefined) ?? error);
    }
    void packageWatch?.sync();
  };
  const activated = async (guestId: string) => {
    try {
      await onGuestActivated({ guestId });
    } catch (error) {
      console.warn('Failed to apply an extension activation:', (hasErrorMessage(error) ? error.message : undefined) ?? error);
    }
    announce();
  };
  const deactivated = async (event: GuestDeactivation) => {
    try {
      await onGuestDeactivated(event);
    } catch (error) {
      console.warn('Failed to apply an extension deactivation:', (hasErrorMessage(error) ? error.message : undefined) ?? error);
    }
    announce();
  };
  const packageChanged = async (guestId: string) => {
    noteGuestPackageChanged(persistPath, guestId);
    await stopGuestService(guestId);
    await activated(guestId);
  };
  const folderChanged = async (storedPath: string) => {
    const root = await fs.realpath(storedPath).catch(() => storedPath);
    const previous = lastLoadedGuestAt(root);
    const inspected = await inspectGuestPackage(root, { skipEngineCheck: true });
    if (!inspected.ok) return;
    const { id } = inspected.guest;
    if (previous && previous.id !== id) {
      await stopGuestService(previous.id);
      await deactivated({ guestId: previous.id, guestName: previous.name });
    }
    invalidateGuestCatalog(persistPath);
    const listed = (await listInstalledGuests({ persistPath })).find((guest) => guest.id === id);
    if (listed?.packageRoot !== root) return;
    await packageChanged(id);
  };
  const packageWatch = watchFolderInstalls
    ? createGuestPackageWatch({
      listFolderInstalls: async () => {
        const stored = await readExtensionStore(persistPath);
        return stored.paths.filter((storedPath) => (stored.sources[storedPath] ?? 'path') === 'path');
      },
      onChange: (root) => void folderChanged(root).catch((error) => {
        console.warn('Failed to reload a changed extension:', error?.message ?? error);
      }),
    })
    : null;
  void packageWatch?.sync();

  const loadGuest = async (id: string | undefined) => {
    if (!isGuestPanelId(id)) {
      return null;
    }
    return findInstalledGuest(id, persistPath);
  };

  app.post('/api/guests/mentions/search', json16, async (req, res) => {
    const body = isRecord(req.body) ? req.body : {};
    const query = isString(body.query) ? body.query.slice(0, 200) : '';
    const directory = isString(body.directory) && body.directory ? body.directory : null;
    try {
      const guests = await listInstalledGuests({ persistPath });
      const abort = new AbortController();
      res.on('close', () => { if (!res.writableEnded) abort.abort(); });
      const groups = await searchGuestMentions({ guests, query, directory, persistPath, signal: abort.signal });
      if (!abort.signal.aborted) res.json({ groups });
    } catch (error) {
      console.error('Failed to search extension mentions:', error);
      res.status(500).json({ error: 'Failed to search extension mentions' });
    }
  });

  app.get(/^\/api\/guests\/marks$/, async (_req, res) => {
    try {
      const guests = await listInstalledGuests({ persistPath });
      res.json({
        marks: guests.filter(mayGuestShowMarks).flatMap((guest) => marks.list(guest.id).map(({ target, mark }) => ({ guestId: guest.id, target, mark }))),
      });
    } catch (error) {
      console.error('Failed to list extension marks:', error);
      res.status(500).json({ error: 'Failed to list extension marks' });
    }
  });

  app.post('/api/guests/:id/mentions/resolve', json16, async (req, res) => {
    const body = isRecord(req.body) ? req.body : {};
    const id = isString(body.id) ? body.id : '';
    if (!id) return res.status(400).json({ error: 'BAD_REQUEST' });
    try {
      const guest = await loadGuest(req.params.id);
      if (!guest?.mentions || !isMentionGuest(guest)) return res.status(404).json({ error: 'NOT_FOUND' });
      const service = guest.service;
      if (!service) throw new TypeError("Cannot read properties of undefined (reading 'keepRunning')");
      res.json({ text: await resolveGuestMention({ guest: { ...guest, service }, id, persistPath }) });
    } catch (error) {
      console.warn(`[mentions] ${req.params.id}: reading a picked row failed (${(hasErrorCode(error) ? error.code : undefined) ?? 'error'})`);
      res.status(502).json({ error: 'MENTION_FAILED' });
    }
  });

  const describeOpenCodePlugins = async (guests: InstalledGuest[]) => {
    const delivery = opencodePlugins.delivery();
    const withPlugin = guests.filter((guest): guest is InstalledGuest & { opencodePlugin: string } => !!guest.opencodePlugin);
    if (withPlugin.length === 0) return { delivery, globalConfigPath: null, inGlobalConfig: [] };
    let globalEntries;
    try {
      globalEntries = opencodePlugins.readGlobalEntries();
    } catch (error) {
      console.warn('Could not read the global OpenCode config for the extension list:', (hasErrorMessage(error) ? error.message : undefined) ?? error);
      return { delivery, globalConfigPath: null, inGlobalConfig: [] };
    }
    const { path: globalConfigPath, targets } = globalEntries;
    const inGlobalConfig = [];
    for (const guest of withPlugin) {
      const directory = await resolveOpenCodePluginFolder(fs, guest.packageRoot, guest.opencodePlugin);
      if (directory && targets.includes(directory)) inGlobalConfig.push(guest.id);
    }
    return { delivery, globalConfigPath, inGlobalConfig };
  };

  const storedLinkSettings = async (guests: InstalledGuest[]) => {
    if (!guests.some((guest) => guestToolLinkSettingIds(guest.tools).length > 0)) return {};
    try {
      return (await readGuestAuthStore(authPath)).guests;
    } catch (error) {
      console.warn('Failed to read extension settings for card links:', (hasErrorMessage(error) ? error.message : undefined) ?? error);
      return {};
    }
  };

  app.get('/api/guests', async (_req, res) => {
    try {
      const guests = await listInstalledGuests({ persistPath });
      const stored = await storedLinkSettings(guests);
      res.json({
        guests: guests.map((guest) => toPublicGuest(withGuestUpdate(guest, persistPath), toolLinkSettingsOf(stored[guest.id], guest))),
        opencodePlugins: await describeOpenCodePlugins(guests),
      });
    } catch (error) {
      console.error('Failed to list guests:', error);
      res.status(500).json({ error: 'Failed to list guests' });
    }
  });

  const pluginRefusal = (guest: InstalledGuest) => {
    if (guest.enterpriseBlocked?.includes('opencodePlugin')) return { status: 403, body: { error: 'enterprise-mode' } };
    const approved = requestedGuestCapabilities(guest).every((capability) => guest.capabilityGrants.includes(capability));
    if (guest.enabled === false || !approved || !guest.capabilityGrants.includes('opencodePlugin')) {
      return { status: 409, body: { error: 'inactive' } };
    }
    return null;
  };

  app.post('/api/guests/:id/opencode-plugin/global-config', async (req, res) => {
    try {
      const guest = await loadGuest(req.params.id);
      if (!guest) return res.status(404).json({ error: 'not-found' });
      if (!guest.opencodePlugin) return res.status(404).json({ error: 'no-plugin' });
      const refused = pluginRefusal(guest);
      if (refused) {
        return res.status(refused.status).json(refused.body);
      }
      const delivery = opencodePlugins.delivery();
      if (delivery !== 'restart' && delivery !== 'none') {
        return res.status(409).json({ error: 'not-needed', delivery });
      }
      const directory = await resolveOpenCodePluginFolder(fs, guest.packageRoot, guest.opencodePlugin);
      if (!directory) {
        return res.status(409).json({ error: 'plugin-missing' });
      }
      const current = await loadGuest(guest.id);
      if (!current) return res.status(404).json({ error: 'not-found' });
      if (!current.opencodePlugin) return res.status(404).json({ error: 'no-plugin' });
      const refusedNow = pluginRefusal(current);
      if (refusedNow) {
        return res.status(refusedNow.status).json(refusedNow.body);
      }
      if (enterpriseBlockedCapabilities(current, { source: current.source, gitUrl: current.gitOrigin?.url }).includes('opencodePlugin')) {
        return res.status(403).json({ error: 'enterprise-mode' });
      }
      let written;
      try {
        written = opencodePlugins.addGlobalEntry(directory);
      } catch (error) {
        if (hasErrorCode(error) && error.code === 'CONFIG_INVALID') {
          return res.status(409).json({ error: 'config-invalid', message: hasErrorMessage(error) ? error.message : undefined });
        }
        throw error;
      }
      if (written.added) announce();
      res.json({ path: written.path });
    } catch (error) {
      console.error('Failed to add an extension plugin to the global OpenCode config:', error);
      res.status(500).json({ error: 'write-failed', message: (hasErrorMessage(error) ? error.message : undefined) ?? 'Failed to write the OpenCode config.' });
    }
  });

  app.post<JsonValue | undefined>('/api/guests', json16, async (req, res) => {
    try {
      const request = parseInstallRequest(req.body);
      if (!request) {
        const hasUrl = isRecord(req.body) && isString(req.body.url);
        return res.status(400).json({ error: hasUrl ? 'invalid-url' : 'invalid-path' });
      }
      const folders = readInstallFolders(isRecord(req.body) ? req.body.folders : undefined);
      if (folders === null) return res.status(400).json({ error: 'invalid-folders' });
      const result = await installGuest(request, persistPath, { ...installOptions(), folders });
      if (result.ok) await packageChanged(result.guest.id);
      sendInstallResult(res, result);
    } catch (error) {
      console.error('Failed to install guest:', error);
      res.status(500).json({ error: 'Failed to install guest' });
    }
  });

  app.post('/api/guests/upload', async (req, res) => {
    try {
      const folders = readUploadFolders(req.query?.folders);
      if (folders === null) return res.status(400).json({ error: 'invalid-folders' });
      const body = await readGuestUploadBody(req, guestUploadMaxBytes());
      if (!body.ok) {
        return res.status(body.status).json({ error: body.error });
      }
      const replace = req.query?.replace === 'true';
      const result = await installGuestFromZipBuffer(body.buffer, persistPath, { openchamberVersion, replace, folders });
      if (result.ok) await packageChanged(result.guest.id);
      sendInstallResult(res, result);
    } catch (error) {
      console.error('Failed to install uploaded guest:', error);
      res.status(500).json({ error: 'Failed to install guest' });
    }
  });

  app.post('/api/guests/updates/check', json16, async (req, res) => {
    try {
      const parsed = updateCheckBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res.status(400).json({ error: 'invalid-request' });
      }
      const updates = await checkAllGuestUpdates({
        persistPath,
        force: Boolean(parsed.data.force),
        gitBinary: resolveGitBinaryForSpawn(),
      });
      res.json({ updates });
    } catch (error) {
      console.error('Failed to check guest updates:', error);
      res.status(500).json({ error: 'Failed to check guest updates' });
    }
  });

  app.post('/api/guests/:id/update', async (req, res) => {
    try {
      const guest = await loadGuest(req.params.id);
      if (!guest) {
        return res.status(404).json({ error: 'not-found' });
      }
      const result = await updateGuest({
        guest,
        origin: guest.gitOrigin,
        persistPath,
        ...installOptions(),
      });
      if (!result.ok) {
        const body: GuestUpdateErrorResponse = { error: result.code };
        if (result.code === 'host-too-old' && result.required) {
          body.required = result.required;
        }
        return res.status(400).json(body);
      }
      await packageChanged(guest.id);
      const next = await loadGuest(guest.id);
      if (!next) {
        return res.status(404).json({ error: 'not-found' });
      }
      res.json({ guest: toPublicGuest(withGuestUpdate(next, persistPath)) });
    } catch (error) {
      console.error('Failed to update guest:', error);
      res.status(500).json({ error: 'Failed to update guest' });
    }
  });

  app.delete('/api/guests/:id', async (req, res) => {
    try {
      const id = req.params.id;
      if (!isGuestPanelId(id)) {
        return res.status(404).json({ error: 'not-found' });
      }
      const removed = await loadGuest(id);
      const result = await uninstallGuest(id, persistPath);
      if (!result.ok) {
        const status = result.code === 'bundled' ? 400 : 404;
        return res.status(status).json({ error: result.code });
      }
      await forgetGuestAuth(id, authPath);
      await deactivated({ guestId: id, guestName: removed?.name ?? id, removed: true });
      res.status(204).end();
    } catch (error) {
      console.error('Failed to uninstall guest:', error);
      res.status(500).json({ error: 'Failed to uninstall guest' });
    }
  });

  app.get('/api/guests/:id/oauth/status', async (req, res) => {
    try {
      const guest = await loadGuest(req.params.id);
      if (!guest) {
        return res.status(404).json({ error: 'not-found' });
      }
      const origin = requestOrigin(req);
      const stored = await takeUsableGuestAuth(guest, authPath);
      const auth = resolveIntegrationAuth(guest.integration ?? {});
      res.json({
        ...await toGuestAuthResponse(guest.integration, stored, trackers),
        redirectUri: auth === 'oauth' && origin ? guestRedirectUri(origin, guest.id) : '',
      });
    } catch (error) {
      console.error('Failed to read guest oauth status:', error);
      res.status(500).json({ error: 'Failed to read guest oauth status' });
    }
  });

  app.put('/api/guests/:id/oauth/client', json16, async (req, res) => {
    try {
      const guest = await loadGuest(req.params.id);
      if (!guest?.integration) {
        return res.status(404).json({ error: 'not-found' });
      }
      if (resolveIntegrationAuth(guest.integration) !== 'oauth') {
        return res.status(400).json({ error: 'NO_INTEGRATION' });
      }
      const parsed = clientBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: 'invalid-client' });
      }
      const stored = await saveGuestOAuthClient({
        guest,
        persistPath: authPath,
        clientId: parsed.data.clientId,
        clientSecret: parsed.data.clientSecret,
      });
      res.json(toPublicGuestAuth(stored, guest.integration));
    } catch (error) {
      console.error('Failed to save guest oauth client:', error);
      res.status(500).json({ error: 'Failed to save guest oauth client' });
    }
  });

  app.put('/api/guests/:id/token', json16, async (req, res) => {
    try {
      const guest = await loadGuest(req.params.id);
      if (!guest?.integration) {
        return res.status(404).json({ error: 'not-found' });
      }
      if (resolveIntegrationAuth(guest.integration) !== 'token') {
        return res.status(400).json({ error: 'NO_TOKEN_AUTH' });
      }
      const parsed = tokenBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: 'invalid-token' });
      }
      await saveGuestAccessToken({ guest, persistPath: authPath, token: parsed.data.token, username: parsed.data.username });
      const stored = await getGuestAuth(guest.id, authPath);
      res.json(await toGuestAuthResponse(guest.integration, stored, trackers));
    } catch (error) {
      if (error instanceof GuestOAuthError) {
        const status = 400;
        return res.status(status).json({ error: error.code, message: error.message });
      }
      console.error('Failed to save guest token:', error);
      res.status(500).json({ error: 'Failed to save guest token' });
    }
  });

  app.put('/api/guests/:id/settings', json16, async (req, res) => {
    try {
      const guest = await loadGuest(req.params.id);
      if (!guest?.integration) {
        return res.status(404).json({ error: 'not-found' });
      }
      if (!isRecord(req.body)) {
        return res.status(400).json({ error: 'invalid-settings' });
      }
      const allowed = declaredSettings(guest);
      const settings: Record<string, string> = {};
      for (const [key, value] of Object.entries(req.body)) {
        if (!allowed.has(key) || !isString(value)) {
          continue;
        }
        const trimmed = value.trim().slice(0, 2000);
        if (allowed.get(key)?.secret && !trimmed) continue;
        settings[key] = trimmed;
      }
      let linkSettingsBefore = {};
      const stored = await patchGuestAuth(guest.id, (current) => {
        linkSettingsBefore = toolLinkSettingsOf(current, guest);
        return {
          settings: {
            ...Object.fromEntries(Object.entries(current?.settings ?? {}).filter(([key]) => allowed.get(key)?.secret)),
            ...settings,
          },
        };
      }, authPath);
      if (JSON.stringify(linkSettingsBefore) !== JSON.stringify(toolLinkSettingsOf(stored, guest))) announce();
      res.json(await toGuestAuthResponse(guest.integration, stored, trackers));
    } catch (error) {
      console.error('Failed to save guest settings:', error);
      res.status(500).json({ error: 'Failed to save guest settings' });
    }
  });

  app.post('/api/guests/:id/oauth/start', json16, async (req, res) => {
    try {
      const guest = await loadGuest(req.params.id);
      if (!guest?.integration) {
        return res.status(404).json({ error: 'not-found' });
      }
      const auth = resolveIntegrationAuth(guest.integration);
      if (auth === 'host') {
        const started = await startHostGuestAuthorization(guest.integration, trackers);
        if (!started) {
          return res.status(400).json({ error: 'NO_INTEGRATION' });
        }
        return res.json(started);
      }
      const origin = requestOrigin(req);
      if (!origin) {
        return res.status(400).json({ error: 'missing-origin' });
      }
      const started = await startGuestAuthorization({ guest, persistPath: authPath, origin });
      res.json(started);
    } catch (error) {
      if (error instanceof GuestOAuthError) {
        const status = 400;
        return res.status(status).json({ error: error.code, message: error.message });
      }
      console.error('Failed to start guest oauth:', error);
      res.status(500).json({ error: 'Failed to start guest oauth' });
    }
  });

  app.get('/api/guests/:id/oauth/callback', async (req, res) => {
    const finish = (status: number, title: string, message: string) => {
      res.status(status).type('html').send(renderOauthCallbackPage({ title, message }));
    };
    try {
      const guest = await loadGuest(req.params.id);
      if (!guest?.integration) {
        return finish(404, 'Unknown extension', 'That extension is not installed.');
      }
      await consumeGuestAuthorization({
        guest,
        persistPath: authPath,
        code: queryValue(req, 'code'),
        state: queryValue(req, 'state'),
        error: queryValue(req, 'error'),
        errorDescription: queryValue(req, 'error_description'),
      });
      finish(200, 'Connected', 'You can close this tab and return to OpenChamber.');
    } catch (error) {
      if (error instanceof GuestOAuthError) {
        return finish(400, 'Could not connect', error.message);
      }
      console.error('Failed to finish guest oauth:', error);
      finish(500, 'Could not connect', 'The authorization callback failed.');
    }
  });

  app.delete('/api/guests/:id/oauth', async (req, res) => {
    try {
      const guest = await loadGuest(req.params.id);
      if (!guest) {
        return res.status(404).json({ error: 'not-found' });
      }
      await disconnectHostGuest(guest.integration, trackers);
      await disconnectGuestAuth(guest.id, authPath);
      const stored = await getGuestAuth(guest.id, authPath);
      res.json(await toGuestAuthResponse(guest.integration, stored, trackers));
    } catch (error) {
      console.error('Failed to disconnect guest oauth:', error);
      res.status(500).json({ error: 'Failed to disconnect guest oauth' });
    }
  });

  app.post('/api/guests/:id/request', json80, async (req, res) => {
    try {
      const guest = await loadGuest(req.params.id);
      if (!guest?.integration) {
        return res.status(404).json({ error: 'not-found' });
      }
      const store = await readExtensionStore(persistPath);
      if (store.disabledGuests?.[guest.id]) {
        throw new GuestOAuthError(
          `${guest.name} is disabled in Settings → Extensions.`,
          'DISABLED',
        );
      }
      if (!guest.capabilityGrants.includes('network')) {
        throw new GuestOAuthError(
          `${guest.name} has not been allowed to use external services. Review it in Settings → Extensions.`,
          'NOT_GRANTED',
        );
      }
      const parsed = requestBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: 'invalid-request' });
      }
      const result = await proxyGuestRequest({
        guest,
        trackers,
        persistPath: authPath,
        method: parsed.data.method,
        path: parsed.data.path,
        query: parsed.data.query,
        body: parsed.data.body,
      });
      res.json(result);
    } catch (error) {
      if (error instanceof GuestOAuthError) {
        const status = error.code === 'DISCONNECTED' ? 409 : error.code === 'RESPONSE_TOO_LARGE' ? 502 : 400;
        return res.status(status).json({ error: error.code, message: error.message });
      }
      console.error('Failed to proxy guest request:', error);
      res.status(500).json({ error: 'Failed to proxy guest request' });
    }
  });

  app.post('/api/guests/:id/service/request', json80, async (req, res) => {
    try {
      const guest = await loadGuest(req.params.id);
      if (!guest?.service) {
        return res.status(404).json({ error: 'not-found' });
      }
      const parsed = serviceRequestBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: 'invalid-request' });
      }
      const result = await proxyGuestServiceRequest({
        guestId: guest.id,
        guestName: guest.name,
        packageRoot: guest.packageRoot,
        service: guest.service,
        granted: guest.capabilityGrants,
        persistPath,
        idleStopMs: guest.service.keepRunning ? undefined : PANEL_SERVICE_IDLE_MS,
        method: parsed.data.method,
        path: parsed.data.path,
        query: parsed.data.query,
        body: parsed.data.body,
        headers: parsed.data.viewerId ? surfaceViewerHeaders(guest.id, parsed.data.viewerId) ?? undefined : undefined,
      });
      res.json(result);
    } catch (error) {
      if (error instanceof GuestServiceError) {
        const status = ['SERVICE_FAILED', 'REQUEST_FAILED', 'RESPONSE_TOO_LARGE'].includes(error.code) ? 502 : 400;
        return res.status(status).json({ error: error.code, message: error.message });
      }
      console.error('Failed to proxy guest service request:', error);
      res.status(500).json({ error: 'Failed to proxy guest service request' });
    }
  });

  app.post('/api/guests/:id/storage', json80, async (req, res) => {
    const parsed = guestStorageRequestSchema.safeParse(req.body);
    if (!parsed.success || !isGuestPanelId(req.params.id)) return res.status(400).json({ error: 'HOST_REJECTED', message: 'Invalid storage request.' });
    if (parsed.data.scope === 'device') return res.status(400).json({ error: 'HOST_REJECTED', message: 'Device storage is not available on this route.' });
    try {
      const result = await runGuestStorage(persistPath, req.params.id, parsed.data, async () => {
        const guest = await loadGuest(req.params.id);
        if (!guest || guest.enabled === false || !hasGuestFrame(guest)) throw new Error('Extension is unavailable.');
        if (!requestedGuestCapabilities(guest).every((capability) => guest.capabilityGrants.includes(capability))) throw new Error('Extension needs approval.');
      });
      return res.json(result);
    } catch {
      return res.status(400).json({ error: 'HOST_REJECTED', message: 'Storage operation failed. Check extension approval and storage limits.' });
    }
  });

  app.post('/api/guests/:id/files', jsonFiles, async (req, res) => {
    try {
      const guest = await loadGuest(req.params.id);
      if (!guest) {
        return res.status(404).json({ error: 'not-found' });
      }
      const store = await readExtensionStore(persistPath);
      if (store.disabledGuests?.[guest.id]) {
        return res.status(400).json({ error: 'DISABLED', message: `${guest.name} is disabled in Settings → Extensions.` });
      }
      const parsed = fileBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: 'invalid-request' });
      }
      const { directory } = await resolveOptionalProjectDirectory(req);
      const result = await runGuestFileOperation({
        op: parsed.data.op,
        path: parsed.data.path,
        content: parsed.data.content,
        projectDirectory: directory,
        patterns: guest.filesystem ?? [],
        grants: guest.capabilityGrants,
        homeDir: os.homedir(),
      });
      if (!result.ok) {
        return res.status(result.code === 'NOT_FOUND' ? 404 : 400).json({ error: result.code, message: result.message });
      }
      res.json({ ok: true, result: result.result });
    } catch (error) {
      console.error('Failed to run guest file operation:', (hasErrorCode(error) ? error.code : undefined) ?? (hasErrorName(error) ? error.name : undefined) ?? 'error');
      res.status(500).json({ error: 'Failed to run guest file operation' });
    }
  });

  app.post('/api/guests/:id/generate', jsonGenerate, async (req, res) => {
    try {
      const guest = await loadGuest(req.params.id);
      if (!guest) {
        return res.status(404).json({ error: 'not-found' });
      }
      const store = await readExtensionStore(persistPath);
      if (store.disabledGuests?.[guest.id]) {
        return res.status(400).json({ error: 'DISABLED', message: `${guest.name} is disabled in Settings → Extensions.` });
      }
      if (!guest.capabilityGrants.includes('model')) {
        return res.status(400).json({
          error: 'NOT_GRANTED',
          message: `${guest.name} has not been allowed to use the Small Model. Review it in Settings → Extensions.`,
        });
      }
      const parsed = generateBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: 'invalid-request' });
      }
      const { directory } = await resolveOptionalProjectDirectory(req);
      const provider = providerHeaderSchema.safeParse(req.get('x-openchamber-provider'));
      const composerModel = providerHeaderSchema.safeParse(req.get('x-openchamber-model'));
      const { generateSmallModelText } = await getSmallModelService();
      let generated;
      try {
        generated = await generateSmallModelText({
          prompt: parsed.data.prompt,
          system: parsed.data.system,
          maxOutputTokens: parsed.data.maxOutputTokens,
          directory: directory || undefined,
          preferredProviderID: provider.success ? provider.data : undefined,
          preferredModelID: provider.success && composerModel.success ? composerModel.data : undefined,
        });
      } catch (error) {
        const statusCode = Number(hasStatusCode(error) ? error.statusCode : undefined) || 500;
        if (statusCode === 404 || statusCode === 422) {
          return res.status(400).json({
            error: 'NO_MODEL',
            message: 'No Small Model is available. Choose one in Settings → Sessions → Small Model.',
          });
        }
        console.error('Guest small-model generation failed:', (hasErrorMessage(error) ? error.message : undefined) ?? (hasErrorCode(error) ? error.code : undefined) ?? 'error');
        return res.status(502).json({ error: 'MODEL_FAILED', message: 'The Small Model could not complete this request.' });
      }
      res.json({ ok: true, result: { text: String(generated?.text ?? '').slice(0, GUEST_GENERATE_TEXT_MAX) } });
    } catch (error) {
      console.error('Failed to run guest generation:', (hasErrorCode(error) ? error.code : undefined) ?? (hasErrorName(error) ? error.name : undefined) ?? 'error');
      res.status(500).json({ error: 'Failed to run guest generation' });
    }
  });

  app.get('/api/guests/:id/service/status', async (req, res) => {
    try {
      const guest = await loadGuest(req.params.id);
      if (!guest?.service) {
        return res.status(404).json({ error: 'not-found' });
      }
      res.json({ status: getServiceStatus(guest.id) });
    } catch (error) {
      console.error('Failed to read guest service status:', error);
      res.status(500).json({ error: 'Failed to read guest service status' });
    }
  });

  app.get('/api/guests/:id/service/failure', async (req, res) => {
    try {
      const guest = await loadGuest(req.params.id);
      if (!guest?.service) {
        return res.status(404).json({ error: 'not-found' });
      }
      res.json({ failure: getServiceFailure(guest.id) });
    } catch (error) {
      console.error('Failed to read guest service failure:', error);
      res.status(500).json({ error: 'Failed to read guest service failure' });
    }
  });

  app.put('/api/guests/:id/capabilities', json16, async (req, res) => {
    try {
      const guest = await loadGuest(req.params.id);
      if (!guest) {
        return res.status(404).json({ error: 'not-found' });
      }
      if (guest.source === 'bundled') {
        return res.status(400).json({ error: 'bundled' });
      }
      const parsed = capabilityGrantSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: 'invalid-request' });
      }
      const requested = requestedGuestCapabilities(guest);
      const granted = parsed.data.granted;
      if (guest.enterpriseBlocked?.some((capability) => granted.includes(capability))) {
        return res.status(403).json({ error: 'enterprise-mode', capabilities: guest.enterpriseBlocked });
      }
      const matchesRequest = granted.length === requested.length && requested.every((capability) => granted.includes(capability));
      if (granted.length > 0 && !matchesRequest) {
        return res.status(400).json({ error: 'invalid-request' });
      }
      const scope = guestGrantScope(guest);
      const store = await readExtensionStore(persistPath);
      const previousScope = store.capabilityScopes?.[guest.id];
      await setCapabilityGrants(guest.id, persistPath, granted, granted.length > 0 ? scope : null);
      if (granted.length === 0) {
        await stopGuestService(guest.id);
        await deactivated({ guestId: guest.id, guestName: guest.name });
      } else {
        await activated(guest.id);
      }
      if (previousScope?.apiOrigin && scope.apiOrigin && !sameCredentialTarget(previousScope, scope)) {
        await dropGuestTokens(guest.id, authPath);
      }
      const next = await loadGuest(guest.id);
      if (!next) {
        return res.status(404).json({ error: 'not-found' });
      }
      res.json({ guest: toPublicGuest(next) });
    } catch (error) {
      console.error('Failed to record guest capabilities:', error);
      res.status(500).json({ error: 'Failed to record guest capabilities' });
    }
  });

  registerGuestAvailabilityRoutes(app, { persistPath, loadGuest, activated, deactivated, announce });

  app.put('/api/guests/:id/service/sockets', json16, async (req, res) => {
    try {
      const guest = await loadGuest(req.params.id);
      if (!guest?.service) {
        return res.status(404).json({ error: 'not-found' });
      }
      const parsed = socketOverrideBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: 'invalid-request' });
      }
      const declared = guest.service.permissions?.sockets ?? [];
      if (!declared.some((binding) => binding.id === parsed.data.id)) {
        return res.status(400).json({ error: 'unknown-socket', message: 'Socket id is not declared by this service.' });
      }
      await setServiceSocketOverride(
        guest.id,
        parsed.data.id,
        persistPath,
        parsed.data.path ?? null,
      );
      announce();
      const next = await loadGuest(guest.id);
      if (!next) {
        return res.status(404).json({ error: 'not-found' });
      }
      res.json({ guest: toPublicGuest(next) });
    } catch (error) {
      console.error('Failed to update guest service socket path:', error);
      res.status(500).json({ error: 'Failed to update guest service socket path' });
    }
  });

  const sendGuestFile = async (res: Response, guest: InstalledGuest, rawPath: string | string[] | undefined, { token = '', connectSource, theme }: { token?: string; connectSource: string | null; theme?: QueryValue | undefined }) => {
    let relativePath;
    try {
      relativePath = decodeURIComponent(Array.isArray(rawPath) ? rawPath.join('/') : (rawPath || ''));
    } catch {
      return res.status(404).end();
    }
    const served = await resolveGuestServedFile(guest.packageRoot, relativePath, {
      hasRuntime: hasGuestFrame(guest),
    });
    if (!served) {
      return res.status(404).end();
    }
    const { filePath, contentType } = served;
    let raw;
    try {
      raw = await fs.readFile(filePath);
    } catch {
      return res.status(404).end();
    }
    const themedSvg = contentType === 'image/svg+xml' ? themedLogoSvg(raw, theme) : null;
    const body = contentType.startsWith('text/html')
      ? injectGuestDocumentStyles(injectGuestAssetTokens(raw.toString('utf8'), token))
      : themedSvg ?? raw;
    res.setHeader('Content-Type', contentType);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    const origins = guest.capabilityGrants?.includes('origins') && Array.isArray(guest.origins) ? guest.origins : [];
    res.setHeader('Content-Security-Policy', `sandbox allow-scripts; ${guestFramePolicy(connectSource, origins)}`);
    if (!res.getHeader('Access-Control-Allow-Origin')) {
      res.setHeader('Access-Control-Allow-Origin', 'null');
    }
    return res.send(body);
  };

  const connectSourceFor = (req: Request, packagePath: string) => {
    const hostHeader = guestHostSchema.safeParse(req.headers.host);
    return hostHeader.success ? `${hostHeader.data}${packagePath}` : null;
  };

  app.post('/api/guests/:id/frame-grant', async (req, res) => {
    try {
      const guest = await loadGuest(req.params.id);
      if (!guest || !hasGuestFrame(guest)) {
        return res.status(404).json({ error: 'not-found' });
      }
      res.setHeader('Cache-Control', 'no-store');
      res.json(frameGrants.mint(guest.id));
    } catch (error) {
      console.error('Failed to grant extension frame:', error);
      res.status(500).json({ error: 'Failed to grant extension frame' });
    }
  });

  app.get('/api/guest-files/:grant/{*filePath}', async (req, res) => {
    try {
      const guestId = frameGrants.use(req.params.grant ?? '');
      if (!guestId) {
        return res.status(403).end();
      }
      const guest = await loadGuest(guestId);
      if (!guest) {
        return res.status(404).end();
      }
      return await sendGuestFile(res, guest, req.params.filePath, {
        connectSource: connectSourceFor(req, `/api/guest-files/${req.params.grant}/`),
      });
    } catch (error) {
      console.error('Failed to serve guest asset:', error);
      res.status(500).end();
    }
  });

  app.get('/api/guests/:id/{*filePath}', async (req, res) => {
    try {
      const guest = await loadGuest(req.params.id);
      if (!guest) {
        return res.status(404).end();
      }
      return await sendGuestFile(res, guest, req.params.filePath, {
        token: parseGuestUrlToken(req.query.oc_url_token),
        connectSource: connectSourceFor(req, `/api/guests/${guest.id}/`),
        theme: req.query.theme,
      });
    } catch (error) {
      console.error('Failed to serve guest asset:', error);
      res.status(500).json({ error: 'Failed to serve guest asset' });
    }
  });

  return { stopPackageWatch: () => packageWatch?.stop() };
};
