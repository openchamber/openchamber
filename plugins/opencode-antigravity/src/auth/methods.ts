// Auth method registry (IA 14). Only oauth-personal is supported; the others are seams.

import { INTEGRATION_ID } from "../constants.ts";
import { unsupportedMethodIssue, type AuthMethodId, type InstallAuthConfig } from "../install/config.ts";
import { OAUTH_METHOD_ID, OAUTH_METHOD_LABEL } from "./constants.ts";

// ---------------------------------------------------------------------------
// OpenCode 2.3.0 integration shapes the plugin uses (IA 2.4). Structural copies of
// `@opencode/plugin` types, so the plugin needs no type dependency on OpenCode.
// ---------------------------------------------------------------------------

/** `Credential.OAuth`. */
export interface OAuthCredential {
  type: "oauth";
  methodID: string;
  access: string;
  refresh: string;
  expires: number;
  metadata?: Record<string, unknown>;
}

/** A credential value OpenCode resolved for a connection; only `key` methods would use it. */
export type CredentialValue = OAuthCredential | { type: "key"; key: string } | { type: string };

export type OAuthAuthorization =
  | { url: string; instructions: string; expiresAt?: number; mode: "code"; callback: (code: string) => Promise<OAuthCredential> }
  | { url: string; instructions: string; expiresAt?: number; mode: "auto"; callback: Promise<OAuthCredential> };

export interface OAuthMethodRegistration {
  integrationID: string;
  method: { id: string; type: "oauth"; label: string };
  authorize(answer?: unknown): Promise<OAuthAuthorization>;
  label?(credential: OAuthCredential): string | undefined;
}

/** The part of OpenCode's `IntegrationEditor` (`ctx.integration.transform`) the plugin calls. */
export interface IntegrationEditorLike {
  update(id: string, update: (integration: { name: string }) => void): void;
  readonly method: {
    update(input: OAuthMethodRegistration): void;
  };
}

/** What a browser-login method needs from `AuthManager`. */
export interface LoginProvider {
  authorize(): Promise<OAuthAuthorization>;
  label(credential: OAuthCredential): string | undefined;
}

export interface ProfileSettingsPatch {
  auth: { type: AuthMethodId };
  gcp?: { project?: string; location?: string };
}

export interface AuthMethodSpec {
  id: AuthMethodId;
  label: string;
  /** Only oauth-personal is true now. */
  supported: boolean;
  usesBrowserLogin: boolean;
  configIssue(config: InstallAuthConfig): string | null;
  profileSettings(config: Pick<InstallAuthConfig, "auth">): ProfileSettingsPatch;
  spawnEnv(config: Pick<InstallAuthConfig, "auth">, credential?: CredentialValue): Record<string, string>;
  register(editor: IntegrationEditorLike, auth: LoginProvider): void;
}

function gcpSettings(config: Pick<InstallAuthConfig, "auth">): ProfileSettingsPatch["gcp"] {
  const { gcpProject, gcpLocation } = config.auth;
  if (gcpProject === undefined && gcpLocation === undefined) return undefined;
  return { project: gcpProject, location: gcpLocation };
}

function reserved(id: AuthMethodId, label: string): AuthMethodSpec {
  return {
    id,
    label,
    supported: false,
    usesBrowserLogin: id === "oauth-business",
    configIssue: () => unsupportedMethodIssue(id),
    profileSettings: (config) => {
      const gcp = gcpSettings(config);
      return gcp ? { auth: { type: id }, gcp } : { auth: { type: id } };
    },
    spawnEnv: () => ({}),
    register: () => {},
  };
}

const oauthPersonal: AuthMethodSpec = {
  id: "oauth-personal",
  label: OAUTH_METHOD_LABEL,
  supported: true,
  usesBrowserLogin: true,
  configIssue: () => null,
  profileSettings: () => ({ auth: { type: "oauth-personal" } }),
  spawnEnv: () => ({}),
  register(editor, auth) {
    editor.method.update({
      integrationID: INTEGRATION_ID,
      method: { id: OAUTH_METHOD_ID, type: "oauth", label: OAUTH_METHOD_LABEL },
      authorize: () => auth.authorize(),
      label: (credential) => auth.label(credential),
    });
  },
};

export const AUTH_METHODS: Readonly<Record<AuthMethodId, AuthMethodSpec>> = {
  "oauth-personal": oauthPersonal,
  "oauth-business": reserved("oauth-business", "Sign in with Google (business)"),
  "gemini-api-key": reserved("gemini-api-key", "Gemini API key"),
  "agent-platform": reserved("agent-platform", "Agent Platform"),
};

/** The configured method when it is supported and has no config issue; otherwise none (IA 10.1). */
export function supportedMethods(config: InstallAuthConfig): AuthMethodSpec[] {
  const spec = AUTH_METHODS[config.authMethod];
  return spec.supported && spec.configIssue(config) === null ? [spec] : [];
}
