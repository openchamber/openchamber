import type { sendBridgeMessage } from './api/bridge';
import { jsonResponse } from './jsonResponse';
import { extractJsonBody } from './requestBodyTransport';

type SendBridgeMessage = typeof sendBridgeMessage;

export async function handleProviderBridgeRequest(
  input: RequestInfo | URL,
  url: URL,
  init: RequestInit | undefined,
  method: string,
  send: SendBridgeMessage,
): Promise<Response | null> {
  const { pathname } = url;

  const providerSourceMatch = pathname.match(/^\/api\/provider\/([^/]+)\/source$/);
  if (providerSourceMatch && method === 'GET') {
    const providerId = decodeURIComponent(providerSourceMatch[1]);
    const queryDirectory = url.searchParams.get('directory') || undefined;
    try {
      const data = await send('api:provider/source:get', { providerId, directory: queryDirectory });
      return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return new Response(JSON.stringify({ error: message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
  }

  const providerRemoveMatch = pathname.match(/^\/api\/provider\/([^/]+)\/auth$/);
  if (providerRemoveMatch && method === 'DELETE') {
    if (url.searchParams.get('scope') !== 'all') {
      return jsonResponse({ error: 'Invalid scope' }, 400);
    }
    try {
      const data = await send('api:provider:remove', {
        providerId: decodeURIComponent(providerRemoveMatch[1]),
        directory: url.searchParams.get('directory') || undefined,
      });
      return jsonResponse(data);
    } catch (error) {
      return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  }

  if (pathname === '/api/provider' && method === 'PUT') {
    try {
      const body = await extractJsonBody(input, init, method);
      const queryDirectory = url.searchParams.get('directory') || undefined;
      const data = await send('api:provider:upsert', {
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

  if (pathname === '/api/provider/discover-models' && method === 'POST') {
    try {
      const body = await extractJsonBody(input, init, method);
      const data = await send('api:provider:discover-models', body);
      if (data && typeof data === 'object' && 'success' in data && (data as { success?: boolean }).success === false) {
        return jsonResponse({ error: (data as { error?: string }).error || 'Failed to discover provider models' }, 400);
      }
      return jsonResponse((data as { data?: unknown })?.data ?? data);
    } catch (error) {
      return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  }

  return null;
}
