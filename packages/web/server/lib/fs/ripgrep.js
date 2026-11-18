
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
