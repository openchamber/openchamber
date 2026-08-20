export const createOpenCodeAuthStateRuntime = (dependencies) => {
  const {
    crypto,
    process,
    getAuthPassword,
    setAuthPassword,
    getAuthSource,
    setAuthSource,
    getAuthUsername = () => null,
    setAuthUsername = () => {},
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
      setAuthUsername(null);
      delete process.env.OPENCODE_SERVER_PASSWORD;
      syncToHmrState();
      return null;
    }

    setAuthPassword(normalized);
    setAuthSource(source);
    setAuthUsername(null);
    process.env.OPENCODE_SERVER_PASSWORD = normalized;
    syncToHmrState();
    return normalized;
  };

  const getOpenCodeAuthHeaders = () => {
    const sharedService = getAuthSource() === 'shared-service';
    const password = normalizeOpenCodePassword(
      getAuthPassword() || (sharedService ? '' : process.env.OPENCODE_SERVER_PASSWORD || ''),
    );

    if (!password) {
      return {};
    }

    const username = sharedService
      ? normalizeOpenCodePassword(getAuthUsername()) || 'opencode'
      : process.env.OPENCODE_SERVER_USERNAME?.trim() || 'opencode';
    const credentials = Buffer.from(`${username}:${password}`).toString('base64');
    return { Authorization: `Basic ${credentials}` };
  };

  const isOpenCodeConnectionSecure = () => Object.prototype.hasOwnProperty.call(getOpenCodeAuthHeaders(), 'Authorization');

  const setOpenCodeServiceAuth = (auth) => {
    const username = normalizeOpenCodePassword(auth?.username);
    const password = normalizeOpenCodePassword(auth?.password);
    setAuthUsername(username || null);
    setAuthPassword(username && password ? password : null);
    setAuthSource('shared-service');
    syncToHmrState();
  };

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
    setOpenCodeServiceAuth,
  };
};
