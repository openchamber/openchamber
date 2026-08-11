import type { LocalApiRouteHandler } from '../types';

export const handleMediaRoutes: LocalApiRouteHandler = async ({ pathname, normalizedPathname, method }) => {
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

  if (normalizedPathname.startsWith('/api/dictation/')) {
    return new Response(JSON.stringify({ error: 'Dictation is not available in VS Code runtime' }), {
      status: 501,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return null;
};
