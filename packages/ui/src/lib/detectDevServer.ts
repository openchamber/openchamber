import type { OpenChamberProjectAction } from './openchamberConfig';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';

type DevServerInfo = {
  command: string;
  label: string;
  actionId?: string;
  previewUrlHint?: string;
};

type PackageManager = 'npm' | 'yarn' | 'pnpm' | 'bun';

const DEV_COMMAND_PATTERNS = [
  { pattern: /^dev(:.*)?$/i },
  { pattern: /^start(:.*)?$/i },
  { pattern: /^preview(:.*)?$/i },
  { pattern: /^serve(:.*)?$/i },
  { pattern: /^develop(:.*)?$/i },
];

const COMMON_DEV_COMMANDS = [
  'dev',
  'start',
  'preview',
  'serve',
];

/**
 * Detect the dev server command from project actions or package.json scripts
 */
export async function detectDevServerCommand(
  directory: string,
  projectActions: OpenChamberProjectAction[],
  packageJsonScripts: Record<string, string> | null,
): Promise<DevServerInfo | null> {
  if (!directory) return null;

  // First, check if there's a project action that looks like a dev server
  const devAction = findDevServerAction(projectActions);
  if (devAction) {
    return {
      command: devAction.command,
      label: devAction.name || 'Start Preview',
      actionId: devAction.id,
    };
  }

  // Then, check package.json scripts
  if (packageJsonScripts) {
    const devScript = findDevScript(packageJsonScripts);
    if (devScript) {
      // Determine the package manager command
      const pm = await detectPackageManager(directory);
      const pmCommand = pm === 'npm' ? 'npm run' : pm === 'yarn' ? 'yarn' : pm === 'pnpm' ? 'pnpm' : pm === 'bun' ? 'bun run --shell=bun' : 'npm run';
      return {
        command: `${pmCommand} ${devScript}`,
        label: `Start (${devScript})`,
      };
    }
  }

  // Fallback: static sites (no package.json) can be previewed via a simple file server.
  // This keeps Start Preview usable for non-Node projects.
  if (await hasStaticIndexHtml(directory)) {
    const port = await allocatePreviewPort();
    const resolvedPort = typeof port === 'number' && Number.isFinite(port) && port > 0 ? port : 8000;
    return {
      command: `python3 -m http.server ${resolvedPort}`,
      label: 'Static preview',
      previewUrlHint: `http://127.0.0.1:${resolvedPort}/`,
    };
  }

  return null;
}

async function hasStaticIndexHtml(directory: string): Promise<boolean> {
  const target = `${directory}/index.html`;
  const content = await readOptionalTextFile(target);
  return typeof content === 'string' && content.trim().length > 0;
}

async function allocatePreviewPort(): Promise<number | null> {
  try {
    const response = await fetch('/api/system/free-port', { cache: 'no-store' });
    if (!response.ok) return null;
    const body = await response.json().catch(() => null) as { port?: unknown } | null;
    const port = typeof body?.port === 'number' ? body.port : null;
    return port && Number.isFinite(port) ? port : null;
  } catch {
    return null;
  }
}

/**
 * Find a project action that looks like a dev server
 */
function findDevServerAction(actions: OpenChamberProjectAction[]): OpenChamberProjectAction | null {
  // Look for actions with "dev", "preview", "start" in the name or command
  for (const action of actions) {
    const nameAndCommand = `${action.name} ${action.command}`.toLowerCase();
    
    // Check if it's likely a dev server action
    const isDevAction = COMMON_DEV_COMMANDS.some(cmd => 
      nameAndCommand.includes(cmd)
    );
    
    if (isDevAction) {
      return action;
    }
  }

  return null;
}

/**
 * Find a dev script in package.json scripts
 */
function findDevScript(scripts: Record<string, string>): string | null {
  for (const { pattern } of DEV_COMMAND_PATTERNS) {
    for (const scriptName of Object.keys(scripts)) {
      if (pattern.test(scriptName)) {
        return scriptName;
      }
    }
  }
  return null;
}

/**
 * Simple package manager detection based on lock files
 * Note: This is intentionally a simple client-side check.
 * For server-side operations, the server's package-manager.js is used.
 */
async function detectPackageManager(directory: string): Promise<PackageManager> {
  const packageJsonContent = await readOptionalTextFile(`${directory}/package.json`);
  if (packageJsonContent) {
    try {
      const pkg = JSON.parse(packageJsonContent) as { packageManager?: unknown };
      const packageManager = typeof pkg.packageManager === 'string' ? pkg.packageManager.toLowerCase() : '';
      if (packageManager.startsWith('bun@')) return 'bun';
      if (packageManager.startsWith('pnpm@')) return 'pnpm';
      if (packageManager.startsWith('yarn@')) return 'yarn';
      if (packageManager.startsWith('npm@')) return 'npm';
    } catch {
      // Ignore malformed package.json here; readPackageJsonScripts handles it separately.
    }
  }

  const lockfiles: Array<[string, PackageManager]> = [
    ['bun.lock', 'bun'],
    ['bun.lockb', 'bun'],
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['package-lock.json', 'npm'],
  ];

  for (const [fileName, packageManager] of lockfiles) {
    const content = await readOptionalTextFile(`${directory}/${fileName}`);
    if (typeof content === 'string' && content.trim().length > 0) {
      return packageManager;
    }
  }

  return 'npm';
}

async function readOptionalTextFile(path: string): Promise<string | null> {
  const runtimeFiles = getRegisteredRuntimeAPIs()?.files;
  if (runtimeFiles?.readFile) {
    try {
      const result = await runtimeFiles.readFile(path, { optional: true });
      return typeof result?.content === 'string' ? result.content : null;
    } catch {
      return null;
    }
  }

  try {
    const response = await fetch(`/api/fs/read?path=${encodeURIComponent(path)}&optional=true`, {
      cache: 'no-store',
    });
    if (!response.ok) return null;
    return response.text();
  } catch {
    return null;
  }
}

/**
 * Read package.json scripts from a directory
 */
export async function readPackageJsonScripts(directory: string): Promise<Record<string, string> | null> {
  try {
    const content = await readOptionalTextFile(`${directory}/package.json`);

    if (content == null) return null;
    const pkg = JSON.parse(content);
    
    return pkg.scripts || null;
  } catch {
    return null;
  }
}
