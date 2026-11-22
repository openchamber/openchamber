export type CredentialJson = null | boolean | number | string | CredentialJson[] | { [key: string]: CredentialJson };

export interface ExeDevCredential {
  usageToken: string;
}

export interface CursorCredential {
  accessToken: string;
  refreshToken: string;
}

export interface ZenmuxCredential {
  platformApiKey: string;
}

export interface OpenDesignCredential {
  cookie: string;
  workspaceId: string;
}

export type ManagedCredential = ExeDevCredential | CursorCredential | ZenmuxCredential | OpenDesignCredential;
export type ManagedCredentialProvider = 'exe-dev' | 'cursor' | 'zenmux' | 'opendesign';

export type ManagedCredentialStatus =
  | { configured: false }
  | { configured: true; secretMasked: string; hasRefreshToken?: boolean };
