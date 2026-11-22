import express from 'express';
import { guestStorageRequestSchema } from '@openchamber/sdk/schemas';
import { runGuestStorage } from './storage.js';
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
  guestFramePolicy,
  isGuestRequestPath,
  requestedGuestCapabilities,
  resolveIntegrationAuth,
} from '@openchamber/sdk';

import {
  GUEST_ASSET_MAX_BYTES,
  findInstalledGuest,
  hasGuestFrame,
  isGuestPanelId,
  listInstalledGuests,
  resolveGuestServedFile,
  toPublicGuest,
} from './catalog.js';
import { runGuestFileOperation } from './files.js';
import { readBoundedFile } from '../shared/bounded-file-read.js';
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

const requestOrigin = (req) => {
  const forwarded = req.headers['x-forwarded-proto'];
  const proto = typeof forwarded === 'string' && forwarded.split(',')[0]
    ? forwarded.split(',')[0].trim()
    : req.secure
      ? 'https'
      : 'http';
  const hostHeader = req.headers['x-forwarded-host'] || req.headers.host;
  const host = typeof hostHeader === 'string' ? hostHeader.split(',')[0].trim() : '';
  if (!host) {
    return null;
  }
  return `${proto}://${host}`;
};

const escapeHtml = (value) => String(value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const renderOauthCallbackPage = ({ title, message }) => `<!doctype html>
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

// A plain slice at the cap can land between the halves of a surrogate pair,
// leaving a lone high surrogate that persists to the guest auth store and
// encodes as U+FFFD for every reader; move a cut inside a pair back to the
// pair boundary. Mirrors clipPairSafe in client-auth/pairing.js.
const clipPairSafe = (text, limit) => {
  if (text.length <= limit) {
    return text;
  }
  const clipped = text.slice(0, limit);
  const last = clipped.charCodeAt(clipped.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? clipped.slice(0, -1) : clipped;
};

export const registerGuestRoutes = (app, {
  openchamberDataDir,
  openchamberVersion,
  resolveGitBinaryForSpawn,
  resolveOptionalProjectDirectory,
  getSmallModelService,
  onGuestDeactivated = async () => false,
  surfaceViewerHeaders = () => null,
}) => {
  const persistPath = extensionsPersistPath(openchamberDataDir);
  const authPath = guestAuthPersistPath(openchamberDataDir);
  const versionOptions = { openchamberVersion };
  const installOptions = () => ({ openchamberVersion, gitBinary: resolveGitBinaryForSpawn() });

  const loadGuest = async (id) => {
    if (!isGuestPanelId(id)) {
      return null;
    }
    return findInstalledGuest(id, persistPath);
  };

  // The operations below are shared by the routes and the `openchamber` agent
  // tool (../openchamber-control/integration-service-actions.js). Those whose
  // route can refuse answer `{ status, body }`.
  const listGuests = async () => {
    const guests = await listInstalledGuests({ persistPath });
    return { guests: guests.map((guest) => toPublicGuest(withGuestUpdate(guest, persistPath))) };
  };

  app.get('/api/guests', async (_req, res) => {
    try {
      res.json(await listGuests());
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
      await onGuestDeactivated({ guestId: id, guestName: removed?.name ?? id });
      res.status(204).end();
    } catch (error) {
      console.error('Failed to uninstall guest:', error);
      res.status(500).json({ error: 'Failed to uninstall guest' });
    }
  });

  /** The integration card's status; `origin` is the address the redirect URI is built on, when there is one. */
  const readAuthStatus = async (id, origin = null) => {
    const guest = await loadGuest(id);
    if (!guest) {
      return { status: 404, body: { error: 'not-found' } };
    }
    // Tokens minted for addresses the package no longer names are dropped
    // here, so the card shows disconnected instead of a stale account.
    const stored = await takeUsableGuestAuth(guest, authPath);
    const auth = resolveIntegrationAuth(guest.integration ?? {});
    return {
      status: 200,
      body: {
        ...await toGuestAuthResponse(guest.integration, stored),
        redirectUri: auth === 'oauth' && origin ? guestRedirectUri(origin, guest.id) : '',
      },
    };
  };

  app.get('/api/guests/:id/oauth/status', async (req, res) => {
    try {
      const { status, body } = await readAuthStatus(req.params.id, requestOrigin(req));
      res.status(status).json(body);
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
      res.json(await toGuestAuthResponse(guest.integration, stored));
    } catch (error) {
      if (error instanceof GuestOAuthError) {
        const status = 400;
        return res.status(status).json({ error: error.code, message: error.message });
      }
      console.error('Failed to save guest token:', error);
      res.status(500).json({ error: 'Failed to save guest token' });
    }
  });

  /** Saves the declared keys of `values`; anything else in it is ignored, as on the card. */
  const saveSettings = async (id, values) => {
    const guest = await loadGuest(id);
    if (!guest?.integration) {
      return { status: 404, body: { error: 'not-found' } };
    }
    if (!values || typeof values !== 'object' || Array.isArray(values)) {
      return { status: 400, body: { error: 'invalid-settings' } };
    }
    const allowed = declaredSettings(guest);
    const settings = {};
    for (const [key, value] of Object.entries(values)) {
      if (!allowed.has(key) || typeof value !== 'string') {
        continue;
      }
      settings[key] = clipPairSafe(value.trim(), 2000);
    }
    const stored = await patchGuestAuth(guest.id, { settings }, authPath);
    return { status: 200, body: await toGuestAuthResponse(guest.integration, stored) };
  };

  app.put('/api/guests/:id/settings', json16, async (req, res) => {
    try {
      const { status, body } = await saveSettings(req.params.id, req.body);
      res.status(status).json(body);
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
        const started = await startHostGuestAuthorization(guest.integration);
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

  /** Drops the guest's tokens; its client and settings stay. */
  const disconnectAuth = async (id) => {
    const guest = await loadGuest(id);
    if (!guest) {
      return { status: 404, body: { error: 'not-found' } };
    }
    await disconnectHostGuest(guest.integration);
    await disconnectGuestAuth(guest.id, authPath);
    const stored = await getGuestAuth(guest.id, authPath);
    return { status: 200, body: await toGuestAuthResponse(guest.integration, stored) };
  };

  app.delete('/api/guests/:id/oauth', async (req, res) => {
    try {
      const { status, body } = await disconnectAuth(req.params.id);
      res.status(status).json(body);
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
      const store = await readExtensionStore(persistPath);
      const previousScope = store.capabilityScopes?.[guest.id];
      await setCapabilityGrants(guest.id, persistPath, granted, granted.length > 0 ? scope : null);
      if (granted.length === 0) {
        await stopGuestService(guest.id);
        await onGuestDeactivated({ guestId: guest.id, guestName: guest.name });
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

  /** Pause (false) or resume; a pause stops the service and hands back any role the guest held. */
  const setEnabled = async (id, request) => {
    const guest = await loadGuest(id);
    if (!guest) {
      return { status: 404, body: { error: 'not-found' } };
    }
    const parsed = enabledBodySchema.safeParse(request);
    if (!parsed.success) {
      return { status: 400, body: { error: 'invalid-request' } };
    }
    await setGuestEnabled(guest.id, persistPath, parsed.data.enabled);
    if (!parsed.data.enabled) {
      await onGuestDeactivated({ guestId: guest.id, guestName: guest.name });
    }
    const next = await loadGuest(guest.id);
    if (!next) {
      return { status: 404, body: { error: 'not-found' } };
    }
    return { status: 200, body: { guest: toPublicGuest(next) } };
  };

  app.put('/api/guests/:id/enabled', json16, async (req, res) => {
    try {
      const { status, body } = await setEnabled(req.params.id, req.body);
      res.status(status).json(body);
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

  app.get('/api/guests/:id/{*filePath}', async (req, res) => {
    try {
      const id = req.params.id;
      if (!isGuestPanelId(id)) {
        return res.status(404).end();
      }
      const guest = await findInstalledGuest(id, persistPath);
      if (!guest) {
        return res.status(404).end();
      }
      const rawPath = req.params.filePath;
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
      // The cap is enforced during the read itself, judged from the opened
      // handle (readBoundedFile): the resolver's stat is only a hint, so a
      // file grown or swapped after it — or one whose size the stat could
      // not report — is refused here having buffered at most the cap + 1
      // byte, never read whole into the server.
      let read;
      try {
        read = await readBoundedFile(filePath, GUEST_ASSET_MAX_BYTES);
      } catch {
        return res.status(404).end();
      }
      if (!read.ok) {
        return read.reason === 'too-large'
          ? res.status(413).json({ error: 'file-too-large' })
          : res.status(404).end();
      }
      const raw = read.buffer;
      const token = parseGuestUrlToken(req.query.oc_url_token);
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
      // it off the network (`guestFramePolicy`): its connections may reach
      // only its own package path, named by the host the browser used, since
      // a sandboxed document has no origin of its own to say `'self'` with.
      const hostHeader = guestHostSchema.safeParse(req.headers.host);
      const host = hostHeader.success ? hostHeader.data : null;
      const connectSource = host ? `${host}/api/guests/${id}/` : null;
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
      res.send(body);
    } catch (error) {
      console.error('Failed to serve guest asset:', error);
      res.status(500).json({ error: 'Failed to serve guest asset' });
    }
  });

  return Object.freeze({
    list: listGuests,
    authStatus: readAuthStatus,
    setEnabled,
    saveSettings,
    disconnect: disconnectAuth,
  });
};
