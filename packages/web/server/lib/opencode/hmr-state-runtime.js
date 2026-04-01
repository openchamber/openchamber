export const createHmrStateRuntime = (dependencies) => {
  const {
    globalThisLike,
    os,
    processLike,
    stateKey,
  } = dependencies;

  const getOrCreateHmrState = () => {
    if (!globalThisLike[stateKey]) {
      globalThisLike[stateKey] = {
        openCodeProcess: null,
        openCodePort: null,
        openCodeWorkingDirectory: os.homedir(),
        isShuttingDown: false,
        signalsAttached: false,
        userProvidedOpenCodePassword: undefined,
        openCodeAuthPassword: null,
        openCodeAuthSource: null,
      };
    }
    return globalThisLike[stateKey];
  };

  const ensureUserProvidedOpenCodePassword = (hmrState) => {
    if (typeof hmrState.userProvidedOpenCodePassword !== 'undefined') {
      return;
    }
    const initialPassword = typeof processLike.env.OPENCODE_SERVER_PASSWORD === 'string'
      ? processLike.env.OPENCODE_SERVER_PASSWORD.trim()
      : '';
    hmrState.userProvidedOpenCodePassword = initialPassword || null;
  };

  const getUserProvidedOpenCodePassword = (hmrState) => (
    typeof hmrState.userProvidedOpenCodePassword === 'string' && hmrState.userProvidedOpenCodePassword.length > 0
      ? hmrState.userProvidedOpenCodePassword
      : null
  );

  const resolveOpenCodeAuthFromState = ({ hmrState, userProvidedOpenCodePassword }) => ({
    openCodeAuthPassword:
      typeof hmrState.openCodeAuthPassword === 'string' && hmrState.openCodeAuthPassword.length > 0
        ? hmrState.openCodeAuthPassword
        : userProvidedOpenCodePassword,
    openCodeAuthSource:
      typeof hmrState.openCodeAuthSource === 'string' && hmrState.openCodeAuthSource.length > 0
        ? hmrState.openCodeAuthSource
        : (userProvidedOpenCodePassword ? 'user-env' : null),
  });

  const syncStateFromRuntime = (hmrState, runtime) => {
    hmrState.openCodeProcess = runtime.openCodeProcess;
    hmrState.openCodePort = runtime.openCodePort;
    hmrState.openCodeBaseUrl = runtime.openCodeBaseUrl;
    hmrState.isShuttingDown = runtime.isShuttingDown;
    hmrState.signalsAttached = runtime.signalsAttached;
    hmrState.openCodeWorkingDirectory = runtime.openCodeWorkingDirectory;
    hmrState.openCodeAuthPassword = runtime.openCodeAuthPassword;
    hmrState.openCodeAuthSource = runtime.openCodeAuthSource;
  };

  const restoreRuntimeFromState = ({ hmrState, userProvidedOpenCodePassword }) => {
    const auth = resolveOpenCodeAuthFromState({ hmrState, userProvidedOpenCodePassword });
    return {
      openCodeProcess: hmrState.openCodeProcess,
      openCodePort: hmrState.openCodePort,
      openCodeBaseUrl: hmrState.openCodeBaseUrl ?? null,
      isShuttingDown: hmrState.isShuttingDown,
      signalsAttached: hmrState.signalsAttached,
      openCodeWorkingDirectory: hmrState.openCodeWorkingDirectory,
      openCodeAuthPassword: auth.openCodeAuthPassword,
      openCodeAuthSource: auth.openCodeAuthSource,
    };
  };

  return {
    getOrCreateHmrState,
    ensureUserProvidedOpenCodePassword,
    getUserProvidedOpenCodePassword,
    resolveOpenCodeAuthFromState,
    syncStateFromRuntime,
    restoreRuntimeFromState,
  };
};
