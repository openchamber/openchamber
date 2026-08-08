import { extractBodyText } from '../../requestBodyTransport';
import { sendBridgeMessage } from '../../api/bridge';
import type { LocalApiRouteHandler } from '../types';

export const handlePermissionRoutes: LocalApiRouteHandler = async ({ url, normalizedPathname, method, init }) => {
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

  return null;
};
