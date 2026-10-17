// Where the ripgrep binary comes from. Content search runs `rg`, and
// OpenChamber ships it instead of relying on one being installed:
//
// 1. A packaged desktop build stages the target architecture's binary in
//    `Resources/ripgrep` (`packages/electron/scripts/prepare-ripgrep.mjs`).
//    The one npm installs matches the build host, which is the wrong
//    architecture for a cross-built app.
// 2. The `@vscode/ripgrep` platform package, an optional dependency of
//    `@openchamber/web` that npm and Bun install for the current platform:
//    web installs, the Docker image and desktop development.
// 3. `rg` on the PATH, for an install whose platform package is missing.
//
// A successful lookup is kept for the process lifetime. A failed one is not,
// so installing ripgrep later makes the next search work without a restart.

const BINARY_NAME = process.platform === 'win32' ? 'rg.exe' : 'rg';

const isExecutableFile = (fs, candidate) => {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
};

export const createRipgrepResolver = ({
  fs,
  path,
  resourcesPath = process.resourcesPath,
  buildSearchPath = () => process.env.PATH || '',
  loadPackagedBinaryPath = async () => (await import('@vscode/ripgrep')).rgPath,
}) => {
  let resolved = null;

  const stagedDesktopBinary = () => {
    if (!resourcesPath) return null;
    const candidate = path.join(resourcesPath, 'ripgrep', BINARY_NAME);
    return isExecutableFile(fs, candidate) ? candidate : null;
  };

  const packagedBinary = async () => {
    try {
      const candidate = await loadPackagedBinaryPath();
      return isExecutableFile(fs, candidate) ? candidate : null;
    } catch {
      // The platform package is absent: the install skipped optional
      // dependencies, or the asar left it out on purpose.
      return null;
    }
  };

  const binaryOnPath = () => {
    for (const dir of buildSearchPath().split(path.delimiter)) {
      if (!dir) continue;
      const candidate = path.join(dir, BINARY_NAME);
      if (isExecutableFile(fs, candidate)) return candidate;
    }
    return null;
  };

  /** @returns {Promise<string | null>} the binary to spawn, or null when there is none */
  const resolveRipgrepBinary = async () => {
    if (resolved) return resolved;
    resolved = stagedDesktopBinary() || await packagedBinary() || binaryOnPath();
    return resolved;
  };

  return { resolveRipgrepBinary };
};
