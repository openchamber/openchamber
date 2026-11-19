import type { ManagedOpenCodeProcess } from './lifecycle.js';
import { isString } from '../shared/object-guards.js';

export interface HmrRuntimeState {
  openCodeProcess: ManagedOpenCodeProcess | null;
  openCodePort: number | null;
  openCodeBaseUrl: string | null;
  openCodeWorkingDirectory: string;
  isShuttingDown: boolean;
  signalsAttached: boolean;
  openCodeAuthPassword: string | null;
  openCodeAuthSource: string | null;
}

export interface HmrState extends Omit<HmrRuntimeState, 'openCodeBaseUrl'> {
  openCodeBaseUrl?: string | null;
  userProvidedOpenCodePassword: string | null | undefined;
}

export interface HmrStateDependencies<Key extends string = string> {
  globalThisLike: { [K in Key]?: HmrState | undefined };
  os: { homedir: () => string };
  processLike: { env: NodeJS.ProcessEnv };
  stateKey: Key;
}

export interface HmrAuthState {
  hmrState: HmrState;
  userProvidedOpenCodePassword: string | null;
}

export const createHmrStateRuntime = <Key extends string>(dependencies: HmrStateDependencies<Key>) => {
  const {
    globalThisLike,
    os,
    processLike,
    stateKey,
  } = dependencies;

  const getInitialOpenCodeWorkingDirectory = () => {
    const configured = isString(processLike.env.OPENCHAMBER_OPENCODE_CWD)
      ? processLike.env.OPENCHAMBER_OPENCODE_CWD.trim()
      : '';
    return configured || os.homedir();
  };

  const getOrCreateHmrState = (): HmrState => {
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
      };
    }
    return globalThisLike[stateKey];
  };

  const ensureUserProvidedOpenCodePassword = (hmrState: HmrState) => {
    if (hmrState.userProvidedOpenCodePassword !== undefined) {
      return;
    }
    const initialPassword = [processLike.env.OPENCODE_PASSWORD, processLike.env.OPENCODE_SERVER_PASSWORD]
      .map((value) => (isString(value) ? value.trim() : ''))
      .find((value) => value.length > 0) || '';
    hmrState.userProvidedOpenCodePassword = initialPassword || null;
  };

  const getUserProvidedOpenCodePassword = (hmrState: HmrState) => (
    isString(hmrState.userProvidedOpenCodePassword) && hmrState.userProvidedOpenCodePassword.length > 0
      ? hmrState.userProvidedOpenCodePassword
      : null
  );

  const resolveOpenCodeAuthFromState = ({ hmrState, userProvidedOpenCodePassword }: HmrAuthState) => ({
    openCodeAuthPassword:
      isString(hmrState.openCodeAuthPassword) && hmrState.openCodeAuthPassword.length > 0
        ? hmrState.openCodeAuthPassword
        : userProvidedOpenCodePassword,
    openCodeAuthSource:
      isString(hmrState.openCodeAuthSource) && hmrState.openCodeAuthSource.length > 0
        ? hmrState.openCodeAuthSource
        : (userProvidedOpenCodePassword ? 'user-env' : null),
  });

  const syncStateFromRuntime = (hmrState: HmrState, runtime: HmrRuntimeState) => {
    hmrState.openCodeProcess = runtime.openCodeProcess;
    hmrState.openCodePort = runtime.openCodePort;
    hmrState.openCodeBaseUrl = runtime.openCodeBaseUrl;
    hmrState.isShuttingDown = runtime.isShuttingDown;
    hmrState.signalsAttached = runtime.signalsAttached;
    hmrState.openCodeWorkingDirectory = runtime.openCodeWorkingDirectory;
    hmrState.openCodeAuthPassword = runtime.openCodeAuthPassword;
    hmrState.openCodeAuthSource = runtime.openCodeAuthSource;
  };

  const restoreRuntimeFromState = ({ hmrState, userProvidedOpenCodePassword }: HmrAuthState): HmrRuntimeState => {
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
