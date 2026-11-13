// allow: SIZE_OK — existing route registry; loopback resolution belongs to loopback-target.js, not a new proxy here.
import express from 'express';
import { requestOrigin, renderOauthCallbackPage } from '../shared/oauth-callback.js';
export { requestOrigin, renderOauthCallbackPage } from '../shared/oauth-callback.js';
import { guestStorageRequestSchema } from '@openchamber/sdk/schemas';
import { runGuestStorage } from './storage.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import { z } from 'zod';

import {
  GUEST_CAPABILITIES,
  GUEST_GENERATE_OUTPUT_TOKENS_MAX,
  GUEST_GENERATE_PROMPT_MAX,
  GUEST_GENERATE_SYSTEM_MAX,
  GUEST_GENERATE_TEXT_MAX,
  GUEST_FILE_CONTENT_MAX,
  GUEST_FILE_PATH_MAX,
  GUEST_PLAN_CONTENT_MAX,
  guestFramePolicy,
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
import { createGuestPackageWatch } from './package-watch.js';
import { runGuestFileOperation } from './files.js';
import { authorizeGuestPlanProvider, listGuestPlans, readGuestPlan, writeGuestPlan } from './plans.js';
import { createGuestFileWatchRegistry, GUEST_FILE_WATCH_LEASE_MS, GUEST_FILE_WATCH_PATHS_MAX, resolveWatchPaths } from './file-watch.js';
import { createGuestFrameGrants } from './frame-grants.js';
import { injectGuestAssetTokens, parseGuestUrlToken } from './html-tokens.js';
import { injectGuestDocumentStyles } from './html-styles.js';
import { installGuest, installGuestFromZipBuffer, parseInstallRequest, uninstallGuest } from './install.js';
import { guestUploadMaxBytes, readGuestUploadBody } from './upload.js';
import { checkAllGuestUpdates, updateGuest, withGuestUpdate } from './updates.js';
import { extensionsPersistPath, readExtensionStore, setCapabilityGrants } from './persist.js';
import { guestGrantScope, sameCredentialTarget } from './grant-scope.js';
import { dropGuestTokens, forgetGuestAuth, getGuestAuth, guestAuthPersistPath, patchGuestAuth } from './auth-store.js';
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
} from './oauth.js';
import { proxyGuestRequest } from './request.js';
import { registerLoopbackRoutes } from './loopback-routes.js';
import {
  GuestServiceError,
  getServiceStatus,
  proxyGuestServiceRequest,
  setServiceSocketOverride,
  setGuestEnabled,
  stopGuestService,
} from './service.js';

const json16 = express.json({ limit: '16kb' });
const json80 = express.json({ limit: '80kb' });
// GUEST_FILE_CONTENT_MAX characters can be several bytes each once JSON-escaped.
const jsonFiles = express.json({ limit: '12mb' });
// A 64k-character prompt in a multi-byte script is a few hundred KB of JSON.
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
  // The shared-surface viewer open in the same window, if any. The host
  // resolves it; an id that is not a live viewer of this extension is ignored.
  viewerId: z.string().min(1).max(128).optional(),
});

const fileBodySchema = z.object({
  op: z.enum(['read', 'write', 'list', 'stat']),
  path: z.string().min(1).max(GUEST_FILE_PATH_MAX),
  content: z.string().max(GUEST_FILE_CONTENT_MAX).optional(),
}).refine((value) => value.op !== 'write' || typeof value.content === 'string', { path: ['content'] });

const planProviderIdSchema = z.string().regex(/^[a-z][a-z0-9-]*$/).max(64);
const planListBodySchema = z.object({ provider: planProviderIdSchema }).strict();
const planFileBodySchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('read'), provider: planProviderIdSchema, path: z.string().min(1).max(GUEST_FILE_PATH_MAX) }).strict(),
  z.object({
    op: z.literal('write'),
    provider: planProviderIdSchema,
    path: z.string().min(1).max(GUEST_FILE_PATH_MAX),
    content: z.string().max(GUEST_PLAN_CONTENT_MAX),
    expectedHash: z.string().regex(/^[0-9a-f]{64}$/),
  }).strict(),
]);

const generateBodySchema = z.object({
  prompt: z.string().trim().min(1).max(GUEST_GENERATE_PROMPT_MAX),
  system: z.string().trim().min(1).max(GUEST_GENERATE_SYSTEM_MAX).optional(),
  maxOutputTokens: z.number().int().min(1).max(GUEST_GENERATE_OUTPUT_TOKENS_MAX).optional(),
});

const providerHeaderSchema = z.string().trim().min(1).max(200);

// A Host header safe to echo into a CSP source: hostname or [IPv6], optional port.
const guestHostSchema = z.string().regex(/^(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$/);

const socketOverrideBodySchema = z.object({
  id: z.string().trim().regex(/^[a-z][a-z0-9-]*$/).max(64),
  path: z.union([
    z.string().trim().min(1).max(512).refine((value) => !value.includes('\0')),
    z.literal(''),
    z.null(),
  ]).optional(),
});

const enabledBodySchema = z.object({
  enabled: z.boolean(),
});

const updateCheckBodySchema = z.object({
  force: z.boolean().optional(),
});

const queryValue = (req, key) => {
  const raw = req.query?.[key];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' ? value.trim() : '';
};

const sendInstallResult = (res, result) => {
  if (!result.ok) {
    const conflict = result.code === 'id-taken' || result.code === 'already-installed';
    const body = { error: result.code };
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
    return res.status(conflict ? 409 : 400).json(body);
  }
  res.status(result.replaced ? 200 : 201).json({ guest: result.guest });
};

const declaredSettings = (guest) => {
  const fields = guest.integration?.settings ?? [];
  return new Map(fields.map((field) => [field.id, field]));
};

/**
 * One `onGuestDeactivated` listener from several: every listener runs, and
 * one that fails is logged under its name and never skips the others.
 * @param {Array<{ name: string, listener: (event: { guestId: string, guestName: string, removed?: boolean }) => unknown }>} listeners
 */
export const settleGuestDeactivationListeners = (listeners) => async (event) => {
  const results = await Promise.allSettled(listeners.map(async ({ listener }) => listener(event)));
  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      console.warn(`Failed to ${listeners[index].name}:`, result.reason?.message ?? result.reason);
    }
  });
};

export const registerGuestRoutes = (app, {
  openchamberDataDir,
  openchamberVersion,
  resolveGitBinaryForSpawn,
  resolveOptionalProjectDirectory,
  getSmallModelService,
  onGuestDeactivated = async () => false,
  // After a package may have gained a role: approval, enable, install or
  // replace, update. The listener reads the catalog itself.
  onGuestActivated = async () => undefined,
  // After any change to the catalog; every client reads it again.
  onGuestsChanged = () => undefined,
  // Report edits to folder installs as package changes. Off in tests that write into packages.
  watchFolderInstalls = false,
  surfaceViewerHeaders = () => null,
  isRequestOriginAllowed,
  // Delivers `openchamber:guest-files-changed` to connected clients.
  emitGuestFilesChanged = () => undefined,
  // Whether a canonical directory is a registered project or one of its
  // worktrees. Plan routes refuse every other directory.
  isPlanDirectoryAllowed = async () => false,
  // The tracker registry: a host-auth guest borrows its tracker's sign-in.
  trackers = null,
}) => {
  const fileWatches = createGuestFileWatchRegistry({ emit: emitGuestFilesChanged });
  const persistPath = extensionsPersistPath(openchamberDataDir);
  const authPath = guestAuthPersistPath(openchamberDataDir);
  const frameGrants = createGuestFrameGrants();
  const versionOptions = { openchamberVersion };
  const installOptions = () => ({ openchamberVersion, gitBinary: resolveGitBinaryForSpawn() });

  // The change already happened; a listener that fails must not turn it into an error answer.
  const announce = () => {
    try {
      onGuestsChanged();
    } catch (error) {
      console.warn('Failed to announce an extension change:', error?.message ?? error);
    }
    void packageWatch?.sync();
  };
  const activated = async (guestId) => {
    try {
      await onGuestActivated({ guestId });
    } catch (error) {
      console.warn('Failed to apply an extension activation:', error?.message ?? error);
    }
    announce();
  };
  const deactivated = async (event) => {
    try {
      await onGuestDeactivated(event);
    } catch (error) {
      console.warn('Failed to apply an extension deactivation:', error?.message ?? error);
    }
    announce();
  };
  // New files under a known id: frames key on the revision and reload, and
  // the service starts again from the new files on its next request.
  const packageChanged = async (guestId) => {
    noteGuestPackageChanged(persistPath, guestId);
    await stopGuestService(guestId);
    await activated(guestId);
  };
  // A build that empties its output first leaves the package unloadable for a
  // moment. Nothing is announced then: clients keep the running version until
  // a later write completes the build.
  const folderChanged = async (storedPath) => {
    // The catalog lists a folder by its real path; the store may name it through a link.
    const root = await fs.realpath(storedPath).catch(() => storedPath);
    const previous = lastLoadedGuestAt(root);
    const inspected = await inspectGuestPackage(root, { skipEngineCheck: true });
    if (!inspected.ok) return;
    const { id } = inspected.guest;
    // A renamed panel id leaves the old id's service and roles behind. They go
    // as with a pause, which keeps the old id's accounts in case the rename is undone.
    if (previous && previous.id !== id) {
      await stopGuestService(previous.id);
      await deactivated({ guestId: previous.id, guestName: previous.name });
    }
    // An id another package already holds keeps that package listed; this folder changed nothing it serves.
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

  const loadGuest = async (id) => {
    if (!isGuestPanelId(id)) {
      return null;
    }
    return findInstalledGuest(id, persistPath);
  };

  app.get('/api/guests', async (_req, res) => {
    try {
      const guests = await listInstalledGuests({ persistPath });
      res.json({
        guests: guests.map((guest) => toPublicGuest(withGuestUpdate(guest, persistPath))),
      });
    } catch (error) {
      console.error('Failed to list guests:', error);
      res.status(500).json({ error: 'Failed to list guests' });
    }
  });

  app.post('/api/guests', json16, async (req, res) => {
    try {
      const request = parseInstallRequest(req.body);
      if (!request) {
        const hasUrl = typeof req.body?.url === 'string';
        return res.status(400).json({ error: hasUrl ? 'invalid-url' : 'invalid-path' });
      }
      const result = await installGuest(request, persistPath, installOptions());
      if (result.ok) await packageChanged(result.guest.id);
      sendInstallResult(res, result);
    } catch (error) {
      console.error('Failed to install guest:', error);
      res.status(500).json({ error: 'Failed to install guest' });
    }
  });

  // Raw zip body from the browser (Settings → Extensions file picker or
  // drop) for hosts the user cannot name a path on. Registered ahead of the
  // `:id` routes because `upload` is a valid panel id shape. Same result
  // and error codes as `POST /api/guests` with a local `.zip`.
  app.post('/api/guests/upload', async (req, res) => {
    try {
      const body = await readGuestUploadBody(req, guestUploadMaxBytes());
      if (!body.ok) {
        return res.status(body.status).json({ error: body.error });
      }
      const replace = req.query?.replace === 'true';
      const result = await installGuestFromZipBuffer(body.buffer, persistPath, { openchamberVersion, replace });
      if (result.ok) await packageChanged(result.guest.id);
      sendInstallResult(res, result);
    } catch (error) {
      console.error('Failed to install uploaded guest:', error);
      res.status(500).json({ error: 'Failed to install guest' });
    }
  });

  // Registered ahead of the `:id` routes so `updates` is never read as a guest id.
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
        const body = { error: result.code };
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
      // Remove means forget: tokens, client secret, and settings go with the package.
      await forgetGuestAuth(id, authPath);
      // A role this package stood in for (the agent's browser) goes back to
      // the host's own, and the user is told rather than finding out mid-task.
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
      // Tokens minted for addresses the package no longer names are dropped
      // here, so the card shows disconnected instead of a stale account.
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
      if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
        return res.status(400).json({ error: 'invalid-settings' });
      }
      const allowed = declaredSettings(guest);
      const settings = {};
      for (const [key, value] of Object.entries(req.body)) {
        if (!allowed.has(key) || typeof value !== 'string') {
          continue;
        }
        settings[key] = value.trim().slice(0, 2000);
      }
      const stored = await patchGuestAuth(guest.id, { settings }, authPath);
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
    const finish = (status, title, message) => {
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
      // No project header is a valid state (a filesystem-scope call); the
      // runner answers NO_DIRECTORY for a relative path in that case.
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
      // Only the failure class is logged: never the path or the file content.
      console.error('Failed to run guest file operation:', error?.code ?? error?.name ?? 'error');
      res.status(500).json({ error: 'Failed to run guest file operation' });
    }
  });

  // Plan providers (`contributes.plans`). The UI names the worktree in
  // `x-opencode-directory`; it must be a registered project or one of its
  // worktrees. The answer never includes a path outside the provider's root.
  const resolvePlanRequest = async (req, res) => {
    const guest = await loadGuest(req.params.id);
    if (!guest) {
      res.status(404).json({ error: 'not-found' });
      return null;
    }
    const store = await readExtensionStore(persistPath);
    const providerId = typeof req.body?.provider === 'string' ? req.body.provider : '';
    const authorized = authorizeGuestPlanProvider(guest, providerId, { disabled: Boolean(store.disabledGuests?.[guest.id]) });
    if (!authorized.ok) {
      res.status(authorized.code === 'NOT_FOUND' ? 404 : 400).json({ error: authorized.code, message: authorized.message });
      return null;
    }
    const { directory, error } = await resolveOptionalProjectDirectory(req);
    if (!directory || error) {
      res.status(400).json({ error: 'NO_DIRECTORY', message: 'No worktree is open.' });
      return null;
    }
    if (!(await isPlanDirectoryAllowed(directory))) {
      res.status(400).json({ error: 'BAD_PATH', message: 'That folder is not a registered project or worktree.' });
      return null;
    }
    return { provider: authorized.provider, directory };
  };

  const sendPlanResult = (res, result) => {
    if (result.ok) return res.json({ ok: true, result: result.result });
    const status = result.code === 'NOT_FOUND' ? 404 : result.code === 'CONFLICT' ? 409 : 400;
    const body = { error: result.code, message: result.message };
    if (result.code === 'CONFLICT') body.hash = result.hash ?? null;
    return res.status(status).json(body);
  };

  app.post('/api/guests/:id/plans/list', json16, async (req, res) => {
    try {
      if (!planListBodySchema.safeParse(req.body).success) return res.status(400).json({ error: 'invalid-request' });
      const context = await resolvePlanRequest(req, res);
      if (!context) return;
      sendPlanResult(res, await listGuestPlans(context));
    } catch (error) {
      console.error('Failed to list guest plans:', error?.code ?? error?.name ?? 'error');
      res.status(500).json({ error: 'Failed to list plans' });
    }
  });

  app.post('/api/guests/:id/plans/file', jsonFiles, async (req, res) => {
    try {
      const parsed = planFileBodySchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'invalid-request' });
      const context = await resolvePlanRequest(req, res);
      if (!context) return;
      const result = parsed.data.op === 'read'
        ? await readGuestPlan({ ...context, path: parsed.data.path })
        : await writeGuestPlan({ ...context, path: parsed.data.path, content: parsed.data.content, expectedHash: parsed.data.expectedHash });
      sendPlanResult(res, result);
    } catch (error) {
      // Only the failure class is logged: never the path or the plan text.
      console.error('Failed to run guest plan operation:', error?.code ?? error?.name ?? 'error');
      res.status(500).json({ error: 'Failed to run plan operation' });
    }
  });

  // Push for `host.watchFiles`: the client holds a lease on a set of project
  // files (renewing it with the same watchId) and gets
  // `openchamber:guest-files-changed` when one of them is written. Only the
  // paths the guest named go out, never contents.
  const watchBodySchema = z.object({
    paths: z.array(z.string().min(1).max(1024)).min(1).max(GUEST_FILE_WATCH_PATHS_MAX),
    watchId: z.string().min(1).max(128).optional(),
  });
  app.post('/api/guests/:id/files/watch', json16, async (req, res) => {
    try {
      const guest = await loadGuest(req.params.id);
      if (!guest) return res.status(404).json({ error: 'not-found' });
      const store = await readExtensionStore(persistPath);
      if (store.disabledGuests?.[guest.id]) {
        return res.status(400).json({ error: 'DISABLED', message: `${guest.name} is disabled in Settings → Extensions.` });
      }
      if (!(guest.capabilityGrants ?? []).includes('files')) {
        return res.status(400).json({ error: 'NOT_GRANTED', message: 'This extension has not been allowed to read and write project files.' });
      }
      const parsed = watchBodySchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'invalid-request' });
      const { directory } = await resolveOptionalProjectDirectory(req);
      if (!directory) return res.status(400).json({ error: 'NO_DIRECTORY', message: 'No project is open.' });
      const files = resolveWatchPaths(directory, parsed.data.paths);
      if (!files) return res.status(400).json({ error: 'HOST_REJECTED', message: 'Only project-relative paths can be watched.' });
      const watchId = fileWatches.watch({ guestId: guest.id, files, watchId: parsed.data.watchId });
      if (!watchId) return res.status(429).json({ error: 'HOST_REJECTED', message: 'Too many file watches for this extension.' });
      res.json({ watchId, leaseMs: GUEST_FILE_WATCH_LEASE_MS });
    } catch (error) {
      console.error('Failed to watch guest files:', error?.code ?? error?.name ?? 'error');
      res.status(500).json({ error: 'Failed to watch guest files' });
    }
  });

  app.delete('/api/guests/:id/files/watch/:watchId', (req, res) => {
    fileWatches.unwatch({ guestId: req.params.id, watchId: req.params.watchId });
    res.json({ ok: true });
  });

  // One-off text generation with the user's Small Model. The model is
  // resolved and authenticated by the small-model service exactly as for the
  // app's own background actions (session titles, notes); the guest never
  // picks a provider and no session is involved. Prompt and answer are never
  // logged.
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
      // The host names the composer's provider, which the model stays on, and
      // its model, used when that provider has no small one.
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
        const statusCode = Number(error?.statusCode) || 500;
        if (statusCode === 404 || statusCode === 422) {
          return res.status(400).json({
            error: 'NO_MODEL',
            message: 'No Small Model is available. Choose one in Settings → Sessions → Small Model.',
          });
        }
        // The provider's error line names the model and status, never the prompt.
        console.error('Guest small-model generation failed:', error?.message ?? error?.code ?? 'error');
        return res.status(502).json({ error: 'MODEL_FAILED', message: 'The Small Model could not complete this request.' });
      }
      res.json({ ok: true, result: { text: String(generated?.text ?? '').slice(0, GUEST_GENERATE_TEXT_MAX) } });
    } catch (error) {
      console.error('Failed to run guest generation:', error?.code ?? error?.name ?? 'error');
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
      // Approval covers exactly what the installed package asks for. A grant
      // for something the manifest does not request is meaningless and a
      // partial grant would leave the guest half-working, so both are refused.
      const requested = requestedGuestCapabilities(guest);
      const granted = parsed.data.granted;
      // Enterprise mode refuses these for this package; approving cannot lift that.
      if (guest.enterpriseBlocked?.some((capability) => granted.includes(capability))) {
        return res.status(403).json({ error: 'enterprise-mode', capabilities: guest.enterpriseBlocked });
      }
      const matchesRequest = granted.length === requested.length && requested.every((capability) => granted.includes(capability));
      if (granted.length > 0 && !matchesRequest) {
        return res.status(400).json({ error: 'invalid-request' });
      }
      const scope = guestGrantScope(guest);
      if (granted.includes('loopback') && !scope.loopback) {
        return res.status(400).json({ error: 'config-invalid', message: 'The server loopback port configuration is invalid.' });
      }
      const store = await readExtensionStore(persistPath);
      const previousScope = store.capabilityScopes?.[guest.id];
      await setCapabilityGrants(guest.id, persistPath, granted, granted.length > 0 ? scope : null);
      if (granted.length === 0) {
        await stopGuestService(guest.id);
        await deactivated({ guestId: guest.id, guestName: guest.name });
      } else {
        await activated(guest.id);
      }
      // Credentials were stored for one API origin and one pair of OAuth
      // endpoints. When a newer version points the integration somewhere
      // else, they must not follow it.
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

  app.put('/api/guests/:id/enabled', json16, async (req, res) => {
    try {
      const guest = await loadGuest(req.params.id);
      if (!guest) {
        return res.status(404).json({ error: 'not-found' });
      }
      const parsed = enabledBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: 'invalid-request' });
      }
      await setGuestEnabled(guest.id, persistPath, parsed.data.enabled);
      if (parsed.data.enabled) {
        await activated(guest.id);
      } else {
        await deactivated({ guestId: guest.id, guestName: guest.name });
      }
      const next = await loadGuest(guest.id);
      if (!next) {
        return res.status(404).json({ error: 'not-found' });
      }
      res.json({ guest: toPublicGuest(next) });
    } catch (error) {
      console.error('Failed to update guest enabled state:', error);
      res.status(500).json({ error: 'Failed to update guest enabled state' });
    }
  });

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

  const loopbackRuntime = registerLoopbackRoutes(app, { persistPath, isRequestOriginAllowed });
  // One extension file, as a frame loads it. `token` is the legacy query
  // credential copied onto the page's relative URLs; `connectSource` is the
  // one path the page may fetch from.
  const sendGuestFile = async (res, guest, rawPath, { token = '', connectSource }) => {
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
    const body = contentType.startsWith('text/html')
      ? injectGuestDocumentStyles(injectGuestAssetTokens(raw.toString('utf8'), token))
      : raw;
    res.setHeader('Content-Type', contentType);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    // Guest files are third-party code served from the OpenChamber origin.
    // The rail embeds them in a sandboxed iframe; `sandbox` makes the
    // document sandboxed even when opened directly, so a guest page can
    // never run with the user's session on the app origin. The rest keeps
    // it off the network (`guestFramePolicy`).
    // Origins the user approved for this exact list (`effectiveGrants`) open too.
    const origins = guest.capabilityGrants?.includes('origins') && Array.isArray(guest.origins) ? guest.origins : [];
    res.setHeader('Content-Security-Policy', `sandbox allow-scripts; ${guestFramePolicy(connectSource, origins)}`);
    // The sandboxed frame's origin is `null`, and fonts (always) and fetch
    // are CORS requests: without this its own package fonts and files are
    // refused. `null`, not `*`: only opaque-origin documents may read them.
    // The app UI's own origin, already allowed by the server's CORS layer,
    // keeps its answer: the rail draws a package icon as a CSS mask, which is
    // a CORS fetch from openchamber-ui:// or the dev origin.
    if (!res.getHeader('Access-Control-Allow-Origin')) {
      res.setHeader('Access-Control-Allow-Origin', 'null');
    }
    return res.send(body);
  };

  // A sandboxed document has no origin of its own to say `'self'` with, so
  // its connections are named by the host the browser used.
  const connectSourceFor = (req, packagePath) => {
    const hostHeader = guestHostSchema.safeParse(req.headers.host);
    return hostHeader.success ? `${hostHeader.data}${packagePath}` : null;
  };

  // A frame's own credential for `/api/guest-files/` (`frame-grants.js`).
  // Minted under normal API auth, by the page that mounts the frame.
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

  // The path extension frames load from. The grant in the path is its only
  // credential (`core-routes.js` lets these reads past API auth), and it
  // opens nothing but that extension's own package files, so a sign-in
  // proxy can leave this prefix alone without exposing any API.
  app.get('/api/guest-files/:grant/{*filePath}', async (req, res) => {
    try {
      const guestId = frameGrants.use(req.params.grant);
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

  // The query-token path frames used before grants. A newer server keeps it
  // for older clients connecting as a remote host; relay frames read through
  // it with the runtime's own credential.
  app.get('/api/guests/:id/{*filePath}', async (req, res) => {
    try {
      const guest = await loadGuest(req.params.id);
      if (!guest) {
        return res.status(404).end();
      }
      return await sendGuestFile(res, guest, req.params.filePath, {
        token: parseGuestUrlToken(req.query.oc_url_token),
        connectSource: connectSourceFor(req, `/api/guests/${guest.id}/`),
      });
    } catch (error) {
      console.error('Failed to serve guest asset:', error);
      res.status(500).json({ error: 'Failed to serve guest asset' });
    }
  });
  // The runtime stops the watch on shutdown and before registering the routes again.
  return { ...loopbackRuntime, stopPackageWatch: () => packageWatch?.stop() };
};
