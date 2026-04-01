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

  const isValidOpenCodePassword = (password) => typeof password === 'string' && password.trim().length > 0;

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

  const getOpenCodeAuthHeaders = () => {
    const password = normalizeOpenCodePassword(getAuthPassword() || process.env.OPENCODE_SERVER_PASSWORD || '');

    if (!password) {
      return {};
    }

    const credentials = Buffer.from(`opencode:${password}`).toString('base64');
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
  };
};
