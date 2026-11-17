import type nodeFs from 'node:fs';
import type nodePath from 'node:path';

interface RipgrepResolverOptions {
  fs: Pick<typeof nodeFs, 'accessSync' | 'statSync' | 'constants'>;
  path: Pick<typeof nodePath, 'join' | 'delimiter'>;
  resourcesPath?: string | undefined;
  buildSearchPath?: () => string;
  loadPackagedBinaryPath?: () => Promise<string>;
}

const desktopProcess: NodeJS.Process & { resourcesPath?: string } = process;

const BINARY_NAME = process.platform === 'win32' ? 'rg.exe' : 'rg';

const isExecutableFile = (fs: RipgrepResolverOptions['fs'], candidate: string) => {
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
  resourcesPath = desktopProcess.resourcesPath,
  buildSearchPath = () => process.env.PATH || '',
  loadPackagedBinaryPath = async () => (await import('@vscode/ripgrep')).rgPath,
}: RipgrepResolverOptions) => {
  let resolved: string | null = null;

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

  const resolveRipgrepBinary = async () => {
    if (resolved) return resolved;
    resolved = stagedDesktopBinary() || await packagedBinary() || binaryOnPath();
    return resolved;
  };

  return { resolveRipgrepBinary };
};
