import { jsonResponse, unsupportedWebRouteResponse } from '../response';
import type { LocalApiRouteHandler } from '../types';

export const handleSystemRoutes: LocalApiRouteHandler = async ({ normalizedPathname, method }) => {
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

  return null;
};
