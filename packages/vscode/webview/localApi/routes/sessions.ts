import { sendBridgeMessage } from '../../api/bridge';
import type { LocalApiRouteHandler } from '../types';

export const handleSessionsRoutes: LocalApiRouteHandler = async ({ normalizedPathname, method }) => {
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

  return null;
};
