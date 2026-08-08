import { sendBridgeMessage } from './api/bridge';
import { extractBodyText, extractJsonBody, hasInitBody } from './requestBodyTransport';
import {
  getRequestDirectoryHint,
  jsonResponse,
  pluginConfigErrorStatus,
  unsupportedWebRouteResponse,
} from './httpHelpers';

export const handleLocalApiRequest = async (input: RequestInfo | URL, url: URL, init: RequestInit | undefined, method: string) => {
  const pathname = url.pathname;
  const normalizedPathname = pathname !== '/' ? pathname.replace(/\/+$/, '') : pathname;

  if (normalizedPathname === '/api/system/info' && method === 'GET') {
    const config = window.__VSCODE_CONFIG__;
    return jsonResponse({
      openchamberVersion: config?.extensionVersion || 'VS Code Extension',
      runtime: 'vscode',
      platform: config?.platform || '',
      arch: config?.arch || '',
    });
  }

  if (normalizedPathname === '/api/preview/targets') {
    return unsupportedWebRouteResponse('Preview proxy');
  }

  if (normalizedPathname.startsWith('/api/openchamber/tunnel/')) {
    return unsupportedWebRouteResponse('Remote tunnel settings');
  }

  if (/^\/api\/projects\/[^/]+\/scheduled-tasks(?:\/[^/]+)?$/.test(normalizedPathname)) {
    return unsupportedWebRouteResponse('Scheduled tasks');
  }

  if (normalizedPathname === '/api/sessions/snapshot' && method === 'GET') {
    const activity = await sendBridgeMessage<Record<string, { type: 'idle' | 'busy' | 'cooldown' }>>('api:session-activity:get')
      .catch(() => ({}));
    return new Response(
      JSON.stringify({
        statusSessions: {},
        attentionSessions: {},
        activitySessions: activity || {},
        serverTime: Date.now(),
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  }

  if (/^\/api\/sessions\/[^/]+\/(view|unview)$/.test(normalizedPathname) && method === 'POST') {
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (normalizedPathname === '/api/permission-auto-accept' && method === 'GET') {
    const snapshot = await sendBridgeMessage('api:permission-auto-accept:get');
    return new Response(JSON.stringify(snapshot), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const permissionPolicyMatch = normalizedPathname.match(/^\/api\/permission-auto-accept\/sessions\/([^/]+)$/);
  if (permissionPolicyMatch && method === 'PUT') {
    const bodyText = await extractBodyText(url, init, method);
    const body = bodyText ? JSON.parse(bodyText) as { enabled?: unknown } : {};
    const snapshot = await sendBridgeMessage('api:permission-auto-accept:set', {
      sessionId: decodeURIComponent(permissionPolicyMatch[1]),
      enabled: body.enabled,
    });
    return new Response(JSON.stringify(snapshot), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (/^\/api\/sessions\/[^/]+\/message-sent$/.test(normalizedPathname) && method === 'POST') {
    const sessionId = normalizedPathname.split('/')[3] || '';
    return new Response(
      JSON.stringify({
        success: true,
        sessionId,
        messageSent: true,
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  }

  if (normalizedPathname === '/api/session-activity' && method === 'GET') {
    const activity = await sendBridgeMessage<Record<string, { type: 'idle' | 'busy' | 'cooldown' }>>('api:session-activity:get')
      .catch(() => ({}));
    return new Response(JSON.stringify(activity || {}), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (normalizedPathname === '/api/sessions/status' && method === 'GET') {
    return new Response(
      JSON.stringify({
        sessions: {},
        serverTime: Date.now(),
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  }

  if (normalizedPathname === '/api/sessions/attention' && method === 'GET') {
    return new Response(
      JSON.stringify({
        sessions: {},
        serverTime: Date.now(),
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  }

  if (/^\/api\/sessions\/[^/]+\/status$/.test(normalizedPathname) && method === 'GET') {
    const sessionId = normalizedPathname.split('/')[3] || '';
    return new Response(
      JSON.stringify({
        error: 'Session not found or no state available',
        sessionId,
      }),
      {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  }

  if (/^\/api\/sessions\/[^/]+\/attention$/.test(normalizedPathname) && method === 'GET') {
    const sessionId = normalizedPathname.split('/')[3] || '';
    return new Response(
      JSON.stringify({
        error: 'Session not found or no attention state available',
        sessionId,
      }),
      {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  }

  if (normalizedPathname === '/api/tts/status' && method === 'GET') {
    return new Response(JSON.stringify({ available: false }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (normalizedPathname === '/api/tts/say/status' && method === 'GET') {
    return new Response(JSON.stringify({ available: false, voices: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if ((pathname === '/api/tts/speak' || pathname === '/api/tts/say/speak') && method === 'POST') {
    return new Response(JSON.stringify({ error: 'TTS endpoints are not available in VS Code runtime' }), {
      status: 501,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Dictation runs on the OpenChamber web server (WebSocket + worker); the VS
  // Code bridge has no server process, so report it deterministically
  // unavailable. The mic button hides itself when capture is unsupported.
  if (normalizedPathname === '/api/dictation/status' && method === 'GET') {
    return new Response(JSON.stringify({ provider: 'local', available: false, reasonCode: 'unsupported_runtime', models: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (normalizedPathname.startsWith('/api/dictation/') ) {
    return new Response(JSON.stringify({ error: 'Dictation is not available in VS Code runtime' }), {
      status: 501,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Health endpoints: reflect actual connection status
  if (pathname === '/health' || pathname === '/api/health') {
    const connectionStatus = window.__OPENCHAMBER_CONNECTION__?.status;
    const isReady = connectionStatus === 'connected';
    const cliAvailable = window.__OPENCHAMBER_CONNECTION__?.cliAvailable ?? true;
    return new Response(JSON.stringify({ 
      status: isReady ? 'ok' : 'connecting', 
      isOpenCodeReady: isReady,
      cliAvailable,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (pathname.startsWith('/api/fs/list')) {
    const targetPath = url.searchParams.get('path') || '';
    const respectGitignore = url.searchParams.get('respectGitignore') === 'true';
    const data = await sendBridgeMessage('api:fs:list', { path: targetPath, respectGitignore });
    return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  if (pathname.startsWith('/api/fs/mkdir')) {
    const body = await extractJsonBody(input, init, method);
    const data = await sendBridgeMessage('api:fs:mkdir', { path: body.path });
    return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  if (pathname.startsWith('/api/fs/home')) {
    const data = await sendBridgeMessage('api:fs/home');
    return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  if (pathname.startsWith('/api/vscode/pick-files')) {
    const data = await sendBridgeMessage('api:files/pick');
    return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  if (pathname.startsWith('/api/vscode/drop-files') && method === 'POST') {
    const body = await extractJsonBody(input, init, method);
    const uris = Array.isArray((body as { uris?: unknown[] }).uris)
      ? (body as { uris: unknown[] }).uris.filter((value): value is string => typeof value === 'string')
      : [];
    const data = await sendBridgeMessage('api:files/drop', { uris });
    return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  if (pathname.startsWith('/api/vscode/save-image') && method === 'POST') {
    const body = await extractJsonBody(input, init, method);
    const fileName = typeof (body as { fileName?: unknown }).fileName === 'string'
      ? (body as { fileName: string }).fileName
      : undefined;
    const dataUrl = typeof (body as { dataUrl?: unknown }).dataUrl === 'string'
      ? (body as { dataUrl: string }).dataUrl
      : undefined;
    const data = await sendBridgeMessage('api:files/save-image', { fileName, dataUrl });
    return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  if (pathname.startsWith('/api/vscode/save-markdown') && method === 'POST') {
    const body = await extractJsonBody(input, init, method);
    const fileName = typeof (body as { fileName?: unknown }).fileName === 'string'
      ? (body as { fileName: string }).fileName
      : undefined;
    const content = typeof (body as { content?: unknown }).content === 'string'
      ? (body as { content: string }).content
      : undefined;
    const data = await sendBridgeMessage('api:files/save-markdown', { fileName, content });
    return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

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
