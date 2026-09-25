import type { McpDraft, McpOAuthConfig } from '@/stores/useMcpConfigStore';

/**
 * The OAuth credential fields the page has no editor for. A save rebuilds the
 * whole `oauth` object, so whatever the entry already holds is carried in this
 * shape and written back untouched.
 */
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

/** The stored OAuth block as the form carries it, so a save cannot lose it. */
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
