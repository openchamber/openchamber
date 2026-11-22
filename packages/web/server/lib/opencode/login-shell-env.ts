
let provided: NodeJS.ProcessEnv | null | undefined;

// `snapshot` is the parsed `env -0` map, or null when the host's probe failed.
// Exported: the Electron main process imports this setter by name
// (packages/electron/main.mjs) to hand over its login-shell snapshot, so the
// server does not probe the shell again on the main thread. The dead-code
// gate does not trace that cross-package import — see
// packages/electron/web-server-imports.test.mjs — do not de-export this.
export const provideLoginShellEnvSnapshot = (snapshot: NodeJS.ProcessEnv | null) => {
  provided = snapshot ? { ...snapshot } : null;
};

export const providedLoginShellEnvSnapshot = () => provided;
