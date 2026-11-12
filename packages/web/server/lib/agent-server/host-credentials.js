import { SpaceError } from '../spaces/errors.js';
import { readBoundedBody } from './agent-upstream.js';
import {
  HOST_CREDENTIAL_ROUTE, MAX_HOST_CREDENTIAL_BYTES, listQuerySchema, providerQuerySchema,
  providerListSchema, providerReplySchema, secretQuerySchema, secretReplySchema,
} from './host-credential-contract.js';

const FAILURE_CODES = new Set([
  'agent_host_credential_invalid_request', 'agent_project_not_registered',
  'agent_host_credential_invalid_response', 'agent_host_credential_unavailable',
  'agent_response_too_large', 'agent_unreachable', 'agent_login_failed',
  'agent_session_expired', 'agent_redirected',
]);

/** Agent answers supply data only; the caller retains provider, grant and space identity. */
export function createAgentHostCredentials(upstream) {
  const queryOf = (schema, value) => {
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new SpaceError('agent_host_credential_invalid_request', 'Invalid agent credential request.');
    return parsed.data;
  };
  const read = async (suffix, query, schema) => {
    try {
      const response = await upstream.request({
        path: `${HOST_CREDENTIAL_ROUTE}/${suffix}?${new URLSearchParams(query)}`,
        headers: { accept: 'application/json' }, timeoutMs: 5000,
      });
      const body = await readBoundedBody(response, MAX_HOST_CREDENTIAL_BYTES);
      let value;
      try { value = JSON.parse(body); } catch { throw new SpaceError('agent_host_credential_invalid_response', 'Invalid agent credential response.'); }
      if (response.statusCode !== 200) {
        const code = FAILURE_CODES.has(value?.code) ? value.code : 'agent_host_credential_unavailable';
        throw new SpaceError(code, code);
      }
      const parsed = schema.safeParse(value);
      if (!parsed.success) throw new SpaceError('agent_host_credential_invalid_response', 'Invalid agent credential response.');
      return parsed.data;
    } catch (error) {
      const code = FAILURE_CODES.has(error?.code) ? error.code : 'agent_host_credential_unavailable';
      throw new SpaceError(code, code);
    }
  };
  return {
    hostProviders: {
      list: async (directory) => read('providers', queryOf(listQuerySchema, { directory }), providerListSchema),
      read: async (provider, directory) => {
        const result = await read('provider', queryOf(providerQuerySchema, { provider, directory }), providerReplySchema);
        if (result !== null && result.id !== provider) throw new SpaceError('agent_host_credential_invalid_response', 'Invalid agent provider identity.');
        return result;
      },
    },
    readHostSecret: async (name) => (await read('secret', queryOf(secretQuerySchema, { name }), secretReplySchema)).value ?? undefined,
  };
}
