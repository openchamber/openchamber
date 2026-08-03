export const createOpenCodeAuthStateRuntime = (dependencies) => {
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

  const normalizeOpenCodePassword = (value) => {
    if (typeof value !== 'string') {
      return '';
    }
    return value.trim();
  };

  const normalizeOpenCodeUsername = (value) => {
    if (typeof value !== 'string') return '';
    return value.trim();
  };

  const isValidOpenCodePassword = (password) => typeof password === 'string' && password.trim().length > 0;
  const isValidOpenCodeUsername = (username) => typeof username === 'string'
    && username.length > 0
    && username.length <= 256
    && !/[\x00-\x1F\x7F]/.test(username);

  const generateSecureOpenCodePassword = () =>
    crypto
      .randomBytes(32)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '');

  const setOpenCodeAuthState = (password, source) => {
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
    process.env.OPENCODE_SERVER_PASSWORD = normalized;
    syncToHmrState();
    return normalized;
  };

  // Handoff restart may rotate the password before the successor is known to
  // be healthy. Keep the previous state behind an opaque restore callback so
  // a confirmed rollback can put the still-running child and request headers
  // back in sync without exposing credentials to callers or logs.
  const captureOpenCodeAuthState = () => {
    const previousPassword = getAuthPassword();
    const previousSource = getAuthSource();
    const previousUsername = process.env.OPENCODE_SERVER_USERNAME;
    return () => {
      if (isValidOpenCodeUsername(previousUsername?.trim?.())) {
        process.env.OPENCODE_SERVER_USERNAME = previousUsername.trim();
      } else {
        delete process.env.OPENCODE_SERVER_USERNAME;
      }
      return setOpenCodeAuthState(previousPassword, previousSource);
    };
  };

  const restoreManagedOpenCodeCredential = ({ username, password } = {}) => {
    const normalizedUsername = normalizeOpenCodeUsername(username);
    const normalizedPassword = normalizeOpenCodePassword(password);
    if (!isValidOpenCodeUsername(normalizedUsername) || !isValidOpenCodePassword(normalizedPassword)) {
      throw new Error('Managed OpenCode credential is malformed');
    }
    // The credential is applied through this owning runtime so all subsequent
    // proxy, API, and readiness requests use the adopted child's auth state.
    process.env.OPENCODE_SERVER_USERNAME = normalizedUsername;
    setOpenCodeAuthState(normalizedPassword, 'guardian-adopted');
    return true;
  };

  const getOpenCodeAuthHeaders = () => {
    const password = normalizeOpenCodePassword(getAuthPassword() || process.env.OPENCODE_SERVER_PASSWORD || '');

    if (!password) {
      return {};
    }

    const username = process.env.OPENCODE_SERVER_USERNAME?.trim() || 'opencode';
    const credentials = Buffer.from(`${username}:${password}`).toString('base64');
    return { Authorization: `Basic ${credentials}` };
  };

  const isOpenCodeConnectionSecure = () => Object.prototype.hasOwnProperty.call(getOpenCodeAuthHeaders(), 'Authorization');

  const ensureLocalOpenCodeServerPassword = async ({ rotateManaged = false } = {}) => {
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
    captureOpenCodeAuthState,
    restoreManagedOpenCodeCredential,
  };
};
