import type { McpDraft, McpOAuthConfig } from '@/stores/useMcpConfigStore';

export const normalizeMcpServerName = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9_-]/g, '-');

export const normalizeImportedMcpServerName = (value: string): string =>
  normalizeMcpServerName(value.trim()).replace(/^[-_]+|[-_]+$/g, '');

export const MCP_DRAFT_OAUTH_UNSET = {
  oauthEnabled: true,
  oauthClientId: '',
  oauthClientSecret: '',
  oauthScope: '',
  oauthRedirectUri: '',
  oauthCallbackPort: '',
} as const satisfies Pick<McpDraft, 'oauthEnabled' | 'oauthClientId' | 'oauthClientSecret' | 'oauthScope' | 'oauthRedirectUri' | 'oauthCallbackPort'>;

export type McpOAuthCarried = Pick<
  McpDraft,
  'oauthEnabled' | 'oauthClientId' | 'oauthClientSecret' | 'oauthScope' | 'oauthRedirectUri' | 'oauthCallbackPort'
>;

export const readCarriedOAuth = (oauth: McpOAuthConfig | false | undefined): McpOAuthCarried => {
  if (oauth === false) return { ...MCP_DRAFT_OAUTH_UNSET, oauthEnabled: false };
  if (!oauth) return MCP_DRAFT_OAUTH_UNSET;
  return {
    oauthEnabled: true,
    oauthClientId: oauth.client_id ?? '',
    oauthClientSecret: oauth.client_secret ?? '',
    oauthScope: oauth.scope ?? '',
    oauthRedirectUri: oauth.redirect_uri ?? '',
    oauthCallbackPort: oauth.callback_port === undefined ? '' : String(oauth.callback_port),
  };
};
