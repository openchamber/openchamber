import {
  jsonResponse,
  pluginConfigErrorStatus,
  unsupportedWebRouteResponse,
  isSseApiPath,
  isSessionMessageApiPath,
  isApiPath,
  isLocalRuntimePath,
  isNullBodyStatus,
} from './httpHelpers.ts';

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

{
  const response = jsonResponse({ ok: true }, 201);
  assert(response.status === 201, 'jsonResponse status');
  assert(response.headers.get('Content-Type') === 'application/json', 'json content-type');
}

{
  assert(unsupportedWebRouteResponse('X').status === 501, 'unsupported is 501');
  assert(pluginConfigErrorStatus('already exists') === 409, 'exists -> 409');
  assert(pluginConfigErrorStatus('not found') === 404, 'missing -> 404');
  assert(pluginConfigErrorStatus('invalid name') === 400, 'invalid -> 400');
  assert(pluginConfigErrorStatus('boom') === 500, 'default -> 500');
}

{
  assert(isSseApiPath('/api/event') && isSseApiPath('/api/global/event'), 'sse paths');
  assert(isSessionMessageApiPath('/api/session/abc/message'), 'session message path');
  assert(isApiPath('/api/foo') && isLocalRuntimePath('/auth/session'), 'local runtime paths');
  assert(isNullBodyStatus(204) && isNullBodyStatus(304), 'null body statuses');
}

console.log('webview httpHelpers tests passed');
