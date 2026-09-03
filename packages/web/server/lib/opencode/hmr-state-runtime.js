export const createHmrStateRuntime = (dependencies) => {
  const {
    globalThisLike,
    os,
    processLike,
    stateKey,
  } = dependencies;

  const getInitialOpenCodeWorkingDirectory = () => {
    const configured = typeof processLike.env.OPENCHAMBER_OPENCODE_CWD === 'string'
      ? processLike.env.OPENCHAMBER_OPENCODE_CWD.trim()
      : '';
    return configured || os.homedir();
  };

  const getOrCreateHmrState = () => {
    if (!globalThisLike[stateKey]) {
      globalThisLike[stateKey] = {
        openCodeProcess: null,
        openCodePort: null,
        openCodeWorkingDirectory: getInitialOpenCodeWorkingDirectory(),
        isShuttingDown: false,
        signalsAttached: false,
        userProvidedOpenCodePassword: undefined,
        openCodeAuthPassword: null,
        openCodeAuthSource: null,
        guardianOutcomeUnknownFence: null,
        guardianOutcomeUnknownFences: [],
        // In-memory lease association only. The lease object is never
        // serialized to disk or included in a durable guardian record.
        guardianOutcomeUnknownLease: null,
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
    hmrState.guardianOutcomeUnknownFence = runtime.guardianOutcomeUnknownFence ?? null;
    hmrState.guardianOutcomeUnknownFences = Array.isArray(runtime.guardianOutcomeUnknownFences)
      ? runtime.guardianOutcomeUnknownFences
      : (runtime.guardianOutcomeUnknownFence ? [runtime.guardianOutcomeUnknownFence] : []);
    hmrState.guardianOutcomeUnknownLease = runtime.guardianOutcomeUnknownLease ?? null;
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
      guardianOutcomeUnknownFence: hmrState.guardianOutcomeUnknownFence ?? null,
      guardianOutcomeUnknownFences: Array.isArray(hmrState.guardianOutcomeUnknownFences)
        ? hmrState.guardianOutcomeUnknownFences
        : (hmrState.guardianOutcomeUnknownFence ? [hmrState.guardianOutcomeUnknownFence] : []),
      guardianOutcomeUnknownLease: hmrState.guardianOutcomeUnknownLease ?? null,
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
