import { openCodeCredentialSource } from '../opencode/auth.js';
import { SpaceError } from '../spaces/errors.js';
import { HOST_CREDENTIAL_ROUTE, credentialSchema, credentialsSchema } from './host-credential-contract.js';

/** The SDK preserves requests; the agent transport supplies auth, size and time bounds. */
export function createAgentCredentialSource(upstream) {
  const source = openCodeCredentialSource({
    buildOpenCodeUrl: () => upstream.origin, getOpenCodeAuthHeaders: () => ({}),
    fetch: (input, options) => {
      const url = new URL(input);
      // OpenChamber deliberately refuses the public credential-list proxy.
      if (url.pathname === '/api/credential' && options.method === 'GET') url.pathname = `${HOST_CREDENTIAL_ROUTE}/credentials`;
      if (url.pathname === '/api/credential' && options.method === 'POST') url.pathname = `${HOST_CREDENTIAL_ROUTE}/renewed-login`;
      return upstream.fetch(url, options);
    },
  });
  const checked = async (operation, schema) => {
    try {
      const result = schema.safeParse(await operation());
      if (!result.success) throw new SpaceError('agent_host_credential_invalid_response', 'Invalid agent credential response.');
      return result.data;
    } catch (error) {
      const code = error instanceof SpaceError ? error.code : 'agent_host_credential_unavailable';
      throw new SpaceError(code, code);
    }
  };
  return {
    list: () => checked(source.list, credentialsSchema),
    create: async (input) => {
      const row = await checked(() => source.create(input), credentialSchema);
      if (row.integrationID !== input.integrationID || row.value.type !== 'oauth' || row.value.methodID !== input.value.methodID || !row.active) {
        throw new SpaceError('agent_host_credential_invalid_response', 'Invalid renewed login identity.');
      }
      return row;
    },
    remove: async (id) => {
      try { return await source.remove(id); }
      catch { throw new SpaceError('agent_host_credential_unavailable', 'Agent credential removal failed.'); }
    },
  };
}
