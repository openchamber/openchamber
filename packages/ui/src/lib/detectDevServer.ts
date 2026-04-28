import type { OpenChamberProjectAction } from './openchamberConfig';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';

type DevServerInfo = {
  command: string;
  label: string;
  actionId?: string;
  previewUrlHint?: string;
};

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
      const pm = detectPackageManager();
      const pmCommand = pm === 'npm' ? 'npm run' : pm === 'yarn' ? 'yarn' : pm === 'pnpm' ? 'pnpm' : pm === 'bun' ? 'bun' : 'npm run';
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
  const runtimeFiles = getRegisteredRuntimeAPIs()?.files;

  if (runtimeFiles?.readFile) {
    try {
      const result = await runtimeFiles.readFile(target);
      return typeof result?.content === 'string' && result.content.length > 0;
    } catch {
      return false;
    }
  }

  try {
    const response = await fetch(`/api/fs/read?path=${encodeURIComponent(target)}&optional=true`, {
      cache: 'no-store',
    });
    if (!response.ok) return false;
    const text = await response.text();
    return text.trim().length > 0;
  } catch {
    return false;
  }
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

  // Fallback: return the first action if there's only one
  if (actions.length === 1) {
    return actions[0];
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
function detectPackageManager(): string {
  // For client-side, we'll default to 'npm' and let the server handle the actual detection
  // The terminal commands will use the appropriate package manager
  return 'npm';
}

/**
 * Read package.json scripts from a directory
 */
export async function readPackageJsonScripts(directory: string): Promise<Record<string, string> | null> {
  try {
    const target = `${directory}/package.json`;

    // Prefer runtime files API (desktop/VS Code). This avoids relying on the web
    // server exposing /api/fs/* when the UI is hosted elsewhere.
    const runtimeFiles = getRegisteredRuntimeAPIs()?.files;
    const content = runtimeFiles?.readFile
      ? (await runtimeFiles.readFile(target)).content
      : await (async () => {
          const response = await fetch(`/api/fs/read?path=${encodeURIComponent(target)}&optional=true`, {
            // Avoid conditional requests (304 + empty body breaks JSON parsing).
            cache: 'no-store',
          });
          if (!response.ok) return null;
          return response.text();
        })();

    if (content == null) return null;
    const pkg = JSON.parse(content);
    
    return pkg.scripts || null;
  } catch {
    return null;
  }
}
