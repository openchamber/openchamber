import type { McpDraft, McpOAuthConfig } from '@/stores/useMcpConfigStore';

/**
 * Server names are lowercase letters, digits, `-` and `_`; the config routes
 * reject anything else. Typing keeps a trailing separator so the next
 * character can follow it.
 */
export const normalizeMcpServerName = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9_-]/g, '-');

/** A name taken from elsewhere, such as an imported snippet, must also start and end with a letter or digit. */
export const normalizeImportedMcpServerName = (value: string): string =>
  normalizeMcpServerName(value.trim()).replace(/^[-_]+|[-_]+$/g, '');

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
