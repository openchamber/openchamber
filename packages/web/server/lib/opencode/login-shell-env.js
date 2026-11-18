
let provided;

export const provideLoginShellEnvSnapshot = (snapshot) => {
  provided = snapshot ? { ...snapshot } : null;
};

export const providedLoginShellEnvSnapshot = () => provided;
