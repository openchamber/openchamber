
let provided: NodeJS.ProcessEnv | null | undefined;

export const provideLoginShellEnvSnapshot = (snapshot: NodeJS.ProcessEnv | null) => {
  provided = snapshot ? { ...snapshot } : null;
};

export const providedLoginShellEnvSnapshot = () => provided;
