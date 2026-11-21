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

export type ManagedCredential = ExeDevCredential | CursorCredential | ZenmuxCredential;
export type ManagedCredentialProvider = 'exe-dev' | 'cursor' | 'zenmux';

export type ManagedCredentialStatus =
  | { configured: false }
  | { configured: true; secretMasked: string; hasRefreshToken?: boolean };
