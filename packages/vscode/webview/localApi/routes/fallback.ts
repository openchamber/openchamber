import { extractJsonBody } from '../../requestBodyTransport';
import { sendBridgeMessage } from '../../api/bridge';
import { jsonResponse } from '../response';
import type { LocalApiRouteHandler } from '../types';

export const handleFallbackRoutes: LocalApiRouteHandler = async ({ pathname, url, input, init, method }) => {
if (pathname.startsWith('/api/openchamber/models-metadata')) {
    try {
      const data = await sendBridgeMessage('api:models/metadata');
      return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } catch (error) {
      console.warn('[OpenChamber] Failed to fetch models metadata via bridge, returning empty set:', error);
      return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
  }

  if (pathname === '/api/opencode/version' && method === 'GET') {
    try {
      const data = await sendBridgeMessage('api:opencode/version');
      return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return new Response(JSON.stringify({ version: null, error: message }), { status: 502, headers: { 'Content-Type': 'application/json' } });
    }
  }

  if (pathname === '/api/opencode/health' && method === 'GET') {
    const connectionStatus = window.__OPENCHAMBER_CONNECTION__?.status;
    return new Response(JSON.stringify({ healthy: connectionStatus === 'connected' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (pathname === '/api/opencode/upgrade-status' && method === 'GET') {
    const data = await sendBridgeMessage('api:opencode/upgrade-status');
    return jsonResponse(data);
  }

  if (pathname === '/api/opencode/upgrade' && method === 'POST') {
    const body = await extractJsonBody(input, init, method);
    const result = await sendBridgeMessage<{ status: number; body: unknown }>('api:opencode/upgrade', body);
    return jsonResponse(result.body, result.status);
  }

  if (pathname === '/api/zen/models' && method === 'GET') {
    try {
      const data = await sendBridgeMessage('api:zen:models');
      return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return new Response(JSON.stringify({ error: message, models: [] }), { status: 502, headers: { 'Content-Type': 'application/json' } });
    }
  }

  if (pathname.startsWith('/api/openchamber/update-check')) {
    try {
      const currentVersion = url.searchParams.get('currentVersion') || undefined;
      const instanceMode = url.searchParams.get('instanceMode') || 'local';
      const deviceClass = url.searchParams.get('deviceClass') || 'desktop';
      const platform = url.searchParams.get('platform') || window.__VSCODE_CONFIG__?.platform || undefined;
      const arch = url.searchParams.get('arch') || window.__VSCODE_CONFIG__?.arch || undefined;
      const reportUsageRaw = (url.searchParams.get('reportUsage') || 'true').toLowerCase();
      const reportUsage = !(reportUsageRaw === 'false' || reportUsageRaw === '0' || reportUsageRaw === 'no');
      const data = await sendBridgeMessage('api:openchamber:update-check', {
        currentVersion,
        instanceMode,
        deviceClass,
        platform,
        arch,
        reportUsage,
      });
      return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return new Response(JSON.stringify({ available: false, error: message }), { status: 502, headers: { 'Content-Type': 'application/json' } });
    }
  }

  if (pathname === '/auth/session') {
    // VS Code host is trusted; mirror web server shape to keep UI logic happy
    const body = {
      authenticated: true,
      requireSetup: false,
      authenticatedAt: Date.now(),
    };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  if (pathname.startsWith('/api/opencode/directory')) {
    const body = await extractJsonBody(input, init, method);
    const result = await sendBridgeMessage('api:opencode/directory', { path: body.path });
    return new Response(JSON.stringify(result), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  if (pathname === '/api/quota/providers') {
    try {
      const data = await sendBridgeMessage('api:quota:providers');
      return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return new Response(JSON.stringify({ error: message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
  }

  const quotaCredentialMatch = pathname.match(/^\/api\/quota\/credentials\/(opencode-go|ollama-cloud|cursor)(?:\/(validate|import))?$/);
  if (quotaCredentialMatch) {
    try {
      const body = method === 'PUT' ? await extractJsonBody(input, init, method) : undefined;
      const bridgeMethod = quotaCredentialMatch[2]?.toUpperCase() || method;
      const data = await sendBridgeMessage('api:quota:credentials', { providerId: quotaCredentialMatch[1], method: bridgeMethod, credential: body });
      return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return new Response(JSON.stringify({ error: message }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
  }

  const quotaMatch = pathname.match(/^\/api\/quota\/([^/]+)$/);
  if (quotaMatch && method === 'GET') {
    const providerId = decodeURIComponent(quotaMatch[1]);
    try {
      const data = await sendBridgeMessage('api:quota:get', { providerId });
      return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return new Response(JSON.stringify({ error: message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
  }

  // Handle provider auth deletion: DELETE /api/provider/:providerId/auth
  const providerAuthMatch = pathname.match(/^\/api\/provider\/([^/]+)\/auth$/);
  if (providerAuthMatch && method === 'DELETE') {
    const providerId = decodeURIComponent(providerAuthMatch[1]);
    const scope = url.searchParams.get('scope') || 'auth';
    const queryDirectory = url.searchParams.get('directory') || undefined;
    try {
      const data = await sendBridgeMessage('api:provider/auth:delete', { providerId, scope, directory: queryDirectory });
      return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return new Response(JSON.stringify({ error: message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
  }

  // Handle provider source lookup: GET /api/provider/:providerId/source
  const providerSourceMatch = pathname.match(/^\/api\/provider\/([^/]+)\/source$/);
  if (providerSourceMatch && method === 'GET') {
    const providerId = decodeURIComponent(providerSourceMatch[1]);
    const queryDirectory = url.searchParams.get('directory') || undefined;
    try {
      const data = await sendBridgeMessage('api:provider/source:get', { providerId, directory: queryDirectory });
      return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return new Response(JSON.stringify({ error: message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
  }

  // Handle custom provider upsert: PUT /api/provider
  if (pathname === '/api/provider' && method === 'PUT') {
    try {
      const body = await extractJsonBody(input, init, method);
      const queryDirectory = url.searchParams.get('directory') || undefined;
      const data = await sendBridgeMessage('api:provider:upsert', {
        ...(body && typeof body === 'object' ? body : {}),
        directory: queryDirectory
          ?? (body && typeof body === 'object' && typeof body.directory === 'string' ? body.directory : undefined),
      });
      if (data && typeof data === 'object' && 'success' in data && (data as { success?: boolean }).success === false) {
        const message = (data as { error?: string }).error || 'Failed to save provider config';
        return new Response(JSON.stringify({ error: message }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify((data as { data?: unknown })?.data ?? data), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return new Response(JSON.stringify({ error: message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
  }

  return null;
};
