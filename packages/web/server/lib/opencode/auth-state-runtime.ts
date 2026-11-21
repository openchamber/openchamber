import { assignInjectedEnv } from '../injected-env.js';

export interface OpenCodeAuthStateDependencies {
  crypto: Pick<typeof import('node:crypto'), 'randomBytes'>;
  process: Pick<NodeJS.Process, 'env'>;
  getAuthPassword: () => string | null;
  setAuthPassword: (password: string | null) => void;
  getAuthSource: () => string | null;
  setAuthSource: (source: string | null) => void;
  getUserProvidedPassword: () => string | null;
  syncToHmrState: () => void;
}

export const createOpenCodeAuthStateRuntime = (dependencies: OpenCodeAuthStateDependencies) => {
  const {
    crypto,
    process,
    getAuthPassword,
    setAuthPassword,
    getAuthSource,
    setAuthSource,
    getUserProvidedPassword,
    syncToHmrState,
  } = dependencies;

  const normalizeOpenCodePassword = (value: string | null | undefined) => {
    return value?.trim() ?? '';
  };

  const isValidOpenCodePassword = (password: string | null): password is string => Boolean(password && password.trim().length > 0);

  const generateSecureOpenCodePassword = () =>
    crypto
      .randomBytes(32)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '');

  const setOpenCodeAuthState = (password: string, source: string) => {
    const normalized = normalizeOpenCodePassword(password);
    if (!isValidOpenCodePassword(normalized)) {
      setAuthPassword(null);
      setAuthSource(null);
      delete process.env.OPENCODE_SERVER_PASSWORD;
      syncToHmrState();
      return null;
    }

    setAuthPassword(normalized);
    setAuthSource(source);
    assignInjectedEnv(process.env, { OPENCODE_SERVER_PASSWORD: normalized });
    syncToHmrState();
    return normalized;
  };

  const getOpenCodeAuthHeaders = () => {
    const password = normalizeOpenCodePassword(getAuthPassword() || process.env.OPENCODE_SERVER_PASSWORD || '');

    if (!password) {
      return {};
    }

    const credentials = Buffer.from(`opencode:${password}`).toString('base64');
    return { Authorization: `Basic ${credentials}` };
  };

  const isOpenCodeConnectionSecure = () => Object.prototype.hasOwnProperty.call(getOpenCodeAuthHeaders(), 'Authorization');

  const ensureLocalOpenCodeServerPassword = async ({ rotateManaged = false }: { rotateManaged?: boolean } = {}) => {
    const userProvidedPassword = getUserProvidedPassword();
    if (isValidOpenCodePassword(userProvidedPassword)) {
      return setOpenCodeAuthState(userProvidedPassword, 'user-env');
    }

    if (rotateManaged) {
      const rotatedPassword = setOpenCodeAuthState(generateSecureOpenCodePassword(), 'rotated');
      console.log('Rotated secure password for managed local OpenCode instance');
      return rotatedPassword;
    }

    const currentPassword = getAuthPassword();
    const currentSource = getAuthSource();
    if (isValidOpenCodePassword(currentPassword)) {
      return setOpenCodeAuthState(currentPassword, currentSource || 'generated');
    }

    const generatedPassword = setOpenCodeAuthState(generateSecureOpenCodePassword(), 'generated');
    console.log('Generated secure password for managed local OpenCode instance');
    return generatedPassword;
  };

  return {
    getOpenCodeAuthHeaders,
    isOpenCodeConnectionSecure,
    ensureLocalOpenCodeServerPassword,
  };
};
