import { existsSync } from 'node:fs';

// Markers that identify a directory as a project root. If process.cwd() matches
// any of these we use it directly instead of falling back to HOME. Without
// this, opencode re-indexes the user's home directory recursively on every
// restart, leaking memory and blocking the proxy health-check.
const PROJECT_MARKERS = [
  '.git',
  'package.json',
  'Cargo.toml',
  'go.mod',
  'pyproject.toml',
];

const looksLikeProjectRoot = (dir) => {
  if (typeof dir !== 'string' || !dir) return false;
  return PROJECT_MARKERS.some((marker) => {
    try {
      return existsSync(`${dir}/${marker}`) || existsSync(`${dir}\\${marker}`);
    } catch {
      return false;
    }
  });
};

let warnedAboutHomeFallback = false;

export const resolveManagedOpenCodeCwd = ({ env, homedir }) => {
  const configured = typeof env?.OPENCHAMBER_OPENCODE_CWD === 'string'
    ? env.OPENCHAMBER_OPENCODE_CWD.trim()
    : '';
  if (configured) {
    return configured;
  }

  const cwd = process.cwd();
  if (looksLikeProjectRoot(cwd)) {
    return cwd;
  }

  const home = typeof homedir === 'function' ? homedir() : '';
  if (typeof home === 'string' && home.trim()) {
    if (!warnedAboutHomeFallback) {
      warnedAboutHomeFallback = true;
      // eslint-disable-next-line no-console
      console.warn(
        `[openchamber] managed OpenCode cwd is the launch directory (${cwd}), which is not a project root; ` +
          `using home (${home}) as the managed working directory instead. ` +
          `Set OPENCHAMBER_OPENCODE_CWD to pick a specific directory.`,
      );
    }
    return home;
  }
  return cwd;
};

// Test-only export: reset the once-per-process warning flag so each test sees
// the warning behaviour from a clean slate.
export const __resetCwdFallbackWarning = () => {
  warnedAboutHomeFallback = false;
};
