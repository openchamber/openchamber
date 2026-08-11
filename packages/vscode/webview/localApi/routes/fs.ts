import { extractJsonBody } from '../../requestBodyTransport';
import { sendBridgeMessage } from '../../api/bridge';
import type { LocalApiRouteHandler } from '../types';

export const handleFsRoutes: LocalApiRouteHandler = async ({ pathname, url, input, init, method }) => {
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

  return null;
};
