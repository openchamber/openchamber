import express from 'express';
import fs from 'node:fs/promises';
import os from 'node:os';
import { z } from 'zod';

import {
  GUEST_CAPABILITIES,
  GUEST_FILE_CONTENT_MAX,
  GUEST_FILE_PATH_MAX,
  isGuestRequestPath,
  requestedGuestCapabilities,
  resolveIntegrationAuth,
} from '@openchamber/sdk';

import {
  findInstalledGuest,
  isGuestPanelId,
  listInstalledGuests,
  resolveGuestServedFile,
  toPublicGuest,
} from './catalog.js';
import { runGuestFileOperation } from './files.js';
import { injectGuestAssetTokens, parseGuestUrlToken } from './html-tokens.js';
import { installGuest, installGuestFromZipBuffer, parseInstallRequest, uninstallGuest } from './install.js';
import { guestUploadMaxBytes, readGuestUploadBody } from './upload.js';
import { checkAllGuestUpdates, updateGuest, withGuestUpdate } from './updates.js';
import { extensionsPersistPath, readExtensionStore, setCapabilityGrants } from './persist.js';
import { forgetGuestAuth, getGuestAuth, guestAuthPersistPath, patchGuestAuth } from './auth-store.js';
import {
  disconnectHostGuest,
  startHostGuestAuthorization,
  toGuestAuthResponse,
} from './host-session.js';
import {
  GuestOAuthError,
  consumeGuestAuthorization,
  disconnectGuestAuth,
  guestRedirectUri,
  saveGuestAccessToken,
  startGuestAuthorization,
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

const fileBodySchema = z.object({
  op: z.enum(['read', 'write', 'list', 'stat']),
  path: z.string().min(1).max(GUEST_FILE_PATH_MAX),
  content: z.string().max(GUEST_FILE_CONTENT_MAX).optional(),
}).refine((value) => value.op !== 'write' || typeof value.content === 'string', { path: ['content'] });

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

export const registerGuestRoutes = (app, {
  openchamberDataDir,
  openchamberVersion,
  resolveGitBinaryForSpawn,
  resolveOptionalProjectDirectory,
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
      const result = await uninstallGuest(id, persistPath);
      if (!result.ok) {
        const status = result.code === 'bundled' ? 400 : 404;
        return res.status(status).json({ error: result.code });
      }
      // Remove means forget: tokens, client secret, and settings go with the package.
      await forgetGuestAuth(id, authPath);
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
      const stored = await getGuestAuth(guest.id, authPath);
      const auth = resolveIntegrationAuth(guest.integration ?? {});
      res.json({
        ...await toGuestAuthResponse(guest.integration, stored),
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
      const next = { clientId: parsed.data.clientId };
      if (parsed.data.clientSecret) {
        next.clientSecret = parsed.data.clientSecret;
      }
      const stored = await patchGuestAuth(guest.id, next, authPath);
      res.json(toPublicGuestAuth(stored));
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
      res.json(await toGuestAuthResponse(guest.integration, stored));
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

  app.delete('/api/guests/:id/oauth', async (req, res) => {
    try {
      const guest = await loadGuest(req.params.id);
      if (!guest) {
        return res.status(404).json({ error: 'not-found' });
      }
      await disconnectHostGuest(guest.integration);
      await disconnectGuestAuth(guest.id, authPath);
      const stored = await getGuestAuth(guest.id, authPath);
      res.json(await toGuestAuthResponse(guest.integration, stored));
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
      if (!(store.capabilityGrants?.[guest.id] ?? []).includes('network')) {
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
        const status = error.code === 'DISCONNECTED' ? 409 : 400;
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
      const parsed = requestBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: 'invalid-request' });
      }
      const result = await proxyGuestServiceRequest({
        guestId: guest.id,
        guestName: guest.name,
        packageRoot: guest.packageRoot,
        service: guest.service,
        persistPath,
        method: parsed.data.method,
        path: parsed.data.path,
        query: parsed.data.query,
        body: parsed.data.body,
      });
      res.json(result);
    } catch (error) {
      if (error instanceof GuestServiceError) {
        const status = error.code === 'SERVICE_FAILED' ? 502 : 400;
        return res.status(status).json({ error: error.code, message: error.message });
      }
      console.error('Failed to proxy guest service request:', error);
      res.status(500).json({ error: 'Failed to proxy guest service request' });
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
        grants: store.capabilityGrants?.[guest.id] ?? [],
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
      const parsed = capabilityGrantSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: 'invalid-request' });
      }
      // Approval covers exactly what the installed package asks for. A grant
      // for something the manifest does not request is meaningless and a
      // partial grant would leave the guest half-working, so both are refused.
      const requested = requestedGuestCapabilities(guest);
      const granted = parsed.data.granted;
      const matchesRequest = granted.length === requested.length && requested.every((capability) => granted.includes(capability));
      if (granted.length > 0 && !matchesRequest) {
        return res.status(400).json({ error: 'invalid-request' });
      }
      await setCapabilityGrants(guest.id, persistPath, granted);
      if (granted.length === 0) {
        await stopGuestService(guest.id);
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
      const served = await resolveGuestServedFile(guest.packageRoot, relativePath);
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
      const token = parseGuestUrlToken(req.query.oc_url_token);
      const body = contentType.startsWith('text/html') && token
        ? injectGuestAssetTokens(raw.toString('utf8'), token)
        : raw;
      res.setHeader('Content-Type', contentType);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'no-store');
      // Guest files are third-party code served from the OpenChamber origin.
      // The rail embeds them in a sandboxed iframe; this header makes the
      // document sandboxed even when opened directly, so a guest page can
      // never run with the user's session on the app origin.
      res.setHeader('Content-Security-Policy', 'sandbox allow-scripts');
      res.send(body);
    } catch (error) {
      console.error('Failed to serve guest asset:', error);
      res.status(500).json({ error: 'Failed to serve guest asset' });
    }
  });
};
