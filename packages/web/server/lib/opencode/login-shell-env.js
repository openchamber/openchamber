/**
 * Handoff of a login-shell environment snapshot from an embedding host.
 *
 * The server snapshots the user's login shell (`$SHELL -lic 'env -0'`) at
 * import time to learn the PATH a Finder- or Dock-launched process never
 * inherits. Desktop already runs the same probe asynchronously while its
 * window comes up; running it again here would block the Electron main
 * thread for as long as the user's shell startup files take, a second time.
 * A host that has a snapshot hands it over before importing the server, and
 * the server uses it instead of probing. `null` means the host probed and got
 * nothing: the server does not retry, because that retry would be
 * synchronous and bounded only by the probe timeout.
 *
 * Kept in this module rather than in the environment on purpose: the
 * snapshot is the user's full shell environment, secrets included, and
 * process.env is inherited by every child the server spawns.
 */

let provided;

// `snapshot` is the parsed `env -0` map, or null when the host's probe failed.
export const provideLoginShellEnvSnapshot = (snapshot) => {
  provided = snapshot ? { ...snapshot } : null;
};

// `undefined` when no host provided one, so the server probes itself.
export const providedLoginShellEnvSnapshot = () => provided;
