import type { LocalApiRouteHandler } from '../types';

export const handleHealthRoutes: LocalApiRouteHandler = async ({ pathname }) => {
  // Health endpoints: reflect actual connection status
  if (pathname === '/health' || pathname === '/api/health') {
    const connectionStatus = window.__OPENCHAMBER_CONNECTION__?.status;
    const isReady = connectionStatus === 'connected';
    const cliAvailable = window.__OPENCHAMBER_CONNECTION__?.cliAvailable ?? true;
    return new Response(JSON.stringify({
      status: isReady ? 'ok' : 'connecting',
      isOpenCodeReady: isReady,
      openCodeRunning: isReady,
      cliAvailable,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return null;
};
