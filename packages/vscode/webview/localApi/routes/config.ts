import { extractJsonBody, hasInitBody } from '../../requestBodyTransport';
import { sendBridgeMessage } from '../../api/bridge';
import { getRequestDirectoryHint } from '../requestUtils';
import { jsonResponse, pluginConfigErrorStatus } from '../response';
import type { LocalApiRouteHandler } from '../types';

export const handleConfigRoutes: LocalApiRouteHandler = async ({ pathname, url, input, init, method, normalizedPathname }) => {
  if (pathname.startsWith('/api/config/agents/')) {
    const encodedName = pathname.slice('/api/config/agents/'.length);
    const name = decodeURIComponent(encodedName);
    const verb = method;
    const body = await extractJsonBody(input, init, method);
    const directory = getRequestDirectoryHint(url, input, init);
    try {
      const data = await sendBridgeMessage('api:config/agents', { method: verb, name, body, directory });
      return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return new Response(JSON.stringify({ error: message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
  }

  if (pathname.startsWith('/api/config/commands/')) {
    const encodedName = pathname.slice('/api/config/commands/'.length);
    const name = decodeURIComponent(encodedName);
    const verb = method;
    const body = await extractJsonBody(input, init, method);
    const directory = getRequestDirectoryHint(url, input, init);
    try {
      const data = await sendBridgeMessage('api:config/commands', { method: verb, name, body, directory });
      return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return new Response(JSON.stringify({ error: message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
  }

  if (pathname === '/api/config/mcp') {
    const verb = method;
    const body = await extractJsonBody(input, init, method);
    const directory = getRequestDirectoryHint(url, input, init);
    try {
      const data = await sendBridgeMessage('api:config/mcp', { method: verb, body, directory });
      return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return new Response(JSON.stringify({ error: message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
  }

  if (pathname.startsWith('/api/config/mcp/')) {
    const encodedName = pathname.slice('/api/config/mcp/'.length);
    const name = decodeURIComponent(encodedName);
    const verb = method;
    const body = await extractJsonBody(input, init, method);
    const directory = getRequestDirectoryHint(url, input, init);
    try {
      const data = await sendBridgeMessage('api:config/mcp', { method: verb, name, body, directory });
      return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return new Response(JSON.stringify({ error: message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
  }

  if (pathname === '/api/config/snippets') {
    const verb = method;
    const directory = getRequestDirectoryHint(url, input, init);
    try {
      const data = await sendBridgeMessage('api:config/snippets', { method: verb, directory });
      return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return new Response(JSON.stringify({ error: message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
  }

  if (pathname === '/api/config/snippets/expand') {
    const verb = method === 'GET' && !hasInitBody(init) && !(input instanceof Request) ? 'POST' : method;
    const body = await extractJsonBody(input, init, method);
    const directory = getRequestDirectoryHint(url, input, init);
    try {
      const data = await sendBridgeMessage('api:config/snippets', { method: verb, body, directory });
      return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return new Response(JSON.stringify({ error: message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
  }

  if (pathname.startsWith('/api/config/snippets/')) {
    const encodedName = pathname.slice('/api/config/snippets/'.length);
    const name = decodeURIComponent(encodedName);
    const verb = method;
    const body = await extractJsonBody(input, init, method);
    const directory = getRequestDirectoryHint(url, input, init);
    try {
      const data = await sendBridgeMessage('api:config/snippets', { method: verb, name, body, directory });
      return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return new Response(JSON.stringify({ error: message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
  }

  // Skills file operations: /api/config/skills/:name/files/:filePath
  const skillsFilesMatch = pathname.match(/^\/api\/config\/skills\/([^/]+)\/files\/(.+)$/);
  if (skillsFilesMatch) {
    const name = decodeURIComponent(skillsFilesMatch[1]);
    const filePath = decodeURIComponent(skillsFilesMatch[2]);
    const verb = method;
    const body = await extractJsonBody(input, init, method);
    try {
      const data = await sendBridgeMessage('api:config/skills/files', { 
        method: verb, 
        name, 
        filePath, 
        content: body.content 
      });
      return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return new Response(JSON.stringify({ error: message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
  }

  const skillsCatalogStatusFromPayload = (payload: unknown): number => {
    if (!payload || typeof payload !== 'object') return 200;
    const data = payload as { ok?: boolean; error?: { kind?: string } };
    if (data.ok === false) {
      const kind = data.error?.kind;
      if (kind === 'conflicts') return 409;
      if (kind === 'authRequired') return 401;
      return 400;
    }
    return 200;
  };

  // Skills catalog: /api/config/skills/catalog
  if (pathname === '/api/config/skills/catalog') {
    const refresh = url.searchParams.get('refresh') === 'true';
    try {
      const data = await sendBridgeMessage('api:config/skills:catalog', { refresh });
      return new Response(JSON.stringify(data), { status: skillsCatalogStatusFromPayload(data), headers: { 'Content-Type': 'application/json' } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return new Response(JSON.stringify({ ok: false, error: { kind: 'unknown', message } }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
  }

  // Skills scan: /api/config/skills/scan
  if (pathname === '/api/config/skills/scan') {
    const body = await extractJsonBody(input, init, method);
    try {
      const data = await sendBridgeMessage('api:config/skills:scan', body);
      return new Response(JSON.stringify(data), { status: skillsCatalogStatusFromPayload(data), headers: { 'Content-Type': 'application/json' } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return new Response(JSON.stringify({ ok: false, error: { kind: 'unknown', message } }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
  }

  // Skills install: /api/config/skills/install
  if (pathname === '/api/config/skills/install') {
    const body = await extractJsonBody(input, init, method);
    try {
      const data = await sendBridgeMessage('api:config/skills:install', body);
      return new Response(JSON.stringify(data), { status: skillsCatalogStatusFromPayload(data), headers: { 'Content-Type': 'application/json' } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return new Response(JSON.stringify({ ok: false, error: { kind: 'unknown', message } }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
  }

  // Skills CRUD: /api/config/skills/:name or /api/config/skills
  if (pathname === '/api/config/skills') {
    try {
      const data = await sendBridgeMessage('api:config/skills', { method: 'GET' });
      return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return new Response(JSON.stringify({ error: message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
  }

  if (pathname.startsWith('/api/config/skills/')) {
    const encodedName = pathname.slice('/api/config/skills/'.length);
    const name = decodeURIComponent(encodedName);
    const verb = method;
    const body = await extractJsonBody(input, init, method);
    try {
      const data = await sendBridgeMessage('api:config/skills', { method: verb, name, body });
      return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return new Response(JSON.stringify({ error: message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
  }

  if (pathname.startsWith('/api/config/settings')) {
    if (method === 'GET') {
      const settings = await sendBridgeMessage('api:config/settings:get');
      return new Response(JSON.stringify(settings), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    const body = await extractJsonBody(input, init, method);
    const updated = await sendBridgeMessage('api:config/settings:save', body);
    return new Response(JSON.stringify(updated), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  if (normalizedPathname === '/api/behavior/agents-md') {
    if (method === 'GET') {
      const data = await sendBridgeMessage('api:behavior/agents-md:get');
      return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (method === 'PUT') {
      const body = await extractJsonBody(input, init, method);
      const data = await sendBridgeMessage('api:behavior/agents-md:save', body);
      return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
  }

  if (pathname === '/api/magic-prompts') {
    if (method === 'GET') {
      const data = await sendBridgeMessage('api:magic-prompts:get');
      return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (method === 'DELETE') {
      const data = await sendBridgeMessage('api:magic-prompts:reset-all');
      return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
  }

  if (pathname.startsWith('/api/magic-prompts/')) {
    const id = decodeURIComponent(pathname.slice('/api/magic-prompts/'.length));
    if (method === 'PUT') {
      const body = await extractJsonBody(input, init, method);
      const data = await sendBridgeMessage('api:magic-prompts:save', { id, text: body?.text });
      return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (method === 'DELETE') {
      const data = await sendBridgeMessage('api:magic-prompts:reset', { id });
      return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
  }

  if (pathname === '/api/config/opencode-resolution' && method === 'GET') {
    try {
      const data = await sendBridgeMessage('api:config/opencode-resolution:get');
      return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return new Response(JSON.stringify({ error: message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
  }

  if (pathname.startsWith('/api/config/reload')) {
    await sendBridgeMessage('api:config/reload');
    return new Response(JSON.stringify({ restarted: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  if (pathname === '/api/config/plugins' && method === 'GET') {
    try {
      const directory = getRequestDirectoryHint(url, input, init);
      const data = await sendBridgeMessage('api:config/plugins', { method, target: 'list', directory });
      return jsonResponse(data);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return jsonResponse({ error: message }, pluginConfigErrorStatus(message));
    }
  }

  if (pathname === '/api/config/plugins/registry' && method === 'GET') {
    try {
      const rawSpecs = url.searchParams.get('specs') || '';
      const specs = rawSpecs ? rawSpecs.split(',').map((spec) => spec.trim()).filter(Boolean) : [];
      const directory = getRequestDirectoryHint(url, input, init);
      const data = await sendBridgeMessage('api:config/plugins', {
        method,
        target: 'registry',
        specs,
        refresh: url.searchParams.get('refresh') === 'true',
        directory,
      });
      return jsonResponse(data);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return jsonResponse({ error: message }, pluginConfigErrorStatus(message));
    }
  }

  if (pathname === '/api/config/plugins/entry' && method === 'POST') {
    try {
      const body = await extractJsonBody(input, init, method);
      const directory = getRequestDirectoryHint(url, input, init);
      const data = await sendBridgeMessage('api:config/plugins', { method, target: 'entry', body, directory });
      return jsonResponse(data);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return jsonResponse({ error: message }, pluginConfigErrorStatus(message));
    }
  }

  const pluginEntryMatch = pathname.match(/^\/api\/config\/plugins\/entry\/([^/]+)$/);
  if (pluginEntryMatch) {
    try {
      const body = method === 'GET' || method === 'DELETE' ? undefined : await extractJsonBody(input, init, method);
      const directory = getRequestDirectoryHint(url, input, init);
      const data = await sendBridgeMessage('api:config/plugins', {
        method,
        target: 'entry',
        pluginId: decodeURIComponent(pluginEntryMatch[1]),
        body,
        directory,
      });
      return jsonResponse(data);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return jsonResponse({ error: message }, pluginConfigErrorStatus(message));
    }
  }

  if (pathname === '/api/config/plugins/file' && method === 'POST') {
    try {
      const body = await extractJsonBody(input, init, method);
      const directory = getRequestDirectoryHint(url, input, init);
      const data = await sendBridgeMessage('api:config/plugins', { method, target: 'file', body, directory });
      return jsonResponse(data);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return jsonResponse({ error: message }, pluginConfigErrorStatus(message));
    }
  }

  const pluginFileMatch = pathname.match(/^\/api\/config\/plugins\/file\/([^/]+)$/);
  if (pluginFileMatch) {
    try {
      const body = method === 'GET' || method === 'DELETE' ? undefined : await extractJsonBody(input, init, method);
      const directory = getRequestDirectoryHint(url, input, init);
      const data = await sendBridgeMessage('api:config/plugins', {
        method,
        target: 'file',
        pluginId: decodeURIComponent(pluginFileMatch[1]),
        body,
        directory,
      });
      return jsonResponse(data);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return jsonResponse({ error: message }, pluginConfigErrorStatus(message));
    }
  }

  
  return null;
};
