import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { type DiscoveredSkill, type SkillScope, type SkillSource } from './opencodeConfig';
import type { BridgeContext } from './bridge';

const SETTINGS_KEY = 'openchamber.settings';
const OPENCHAMBER_SHARED_SETTINGS_PATH = path.join(os.homedir(), '.config', 'openchamber', 'settings.json');

const isPathInside = (candidatePath: string, parentPath: string): boolean => {
  const relative = path.relative(parentPath, candidatePath);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
};

const findWorktreeRootForSkills = (workingDirectory?: string): string | null => {
  if (!workingDirectory) return null;
  let current = path.resolve(workingDirectory);
  while (true) {
    const gitPath = path.join(current, '.git');
    try {
      const stat = fs.statSync(gitPath);
      if (stat.isFile()) {
        return current;
      }
    } catch {
      // Continue climbing.
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
};

const getProjectAncestors = (workingDirectory?: string): string[] => {
  if (!workingDirectory) return [];
  const result: string[] = [];
  let current = path.resolve(workingDirectory);
  const stop = findWorktreeRootForSkills(workingDirectory) || current;
  while (true) {
    result.push(current);
    if (current === stop) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return result;
};

const inferSkillScopeAndSourceFromLocation = (location: string, workingDirectory?: string): { scope: SkillScope; source: SkillSource } => {
  const resolvedPath = path.resolve(location);
  const source: SkillSource = resolvedPath.includes(`${path.sep}.agents${path.sep}skills${path.sep}`)
    ? 'agents'
    : resolvedPath.includes(`${path.sep}.claude${path.sep}skills${path.sep}`)
      ? 'claude'
      : 'opencode';

  const projectAncestors = getProjectAncestors(workingDirectory);
  const isProjectScoped = projectAncestors.some((ancestor) => {
    const candidates = [
      path.join(ancestor, '.opencode'),
      path.join(ancestor, '.claude', 'skills'),
      path.join(ancestor, '.agents', 'skills'),
    ];
    return candidates.some((candidate) => isPathInside(resolvedPath, candidate));
  });

  if (isProjectScoped) {
    return { scope: 'project', source };
  }

  const home = os.homedir();
  const userRoots = [
    path.join(home, '.config', 'opencode'),
    path.join(home, '.opencode'),
    path.join(home, '.claude', 'skills'),
    path.join(home, '.agents', 'skills'),
    process.env.OPENCODE_CONFIG_DIR ? path.resolve(process.env.OPENCODE_CONFIG_DIR) : null,
  ].filter((value): value is string => Boolean(value));

  if (userRoots.some((root) => isPathInside(resolvedPath, root))) {
    return { scope: 'user', source };
  }

  return { scope: 'user', source };
};

export const fetchOpenCodeSkillsFromApi = async (
  ctx: BridgeContext | undefined,
  workingDirectory?: string,
): Promise<DiscoveredSkill[] | null> => {
  const apiUrl = ctx?.manager?.getApiUrl();
  if (!apiUrl) {
    return null;
  }

  try {
    const base = apiUrl.endsWith('/') ? apiUrl : `${apiUrl}/`;
    const url = new URL('skill', base);
    if (workingDirectory) {
      url.searchParams.set('directory', workingDirectory);
    }

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        ...(ctx?.manager?.getOpenCodeAuthHeaders() || {}),
      },
      signal: AbortSignal.timeout(8_000),
    });

    if (!response.ok) {
      return null;
    }

    const payload = await response.json();
    if (!Array.isArray(payload)) {
      return null;
    }

    return payload
      .map((item) => {
        const name = typeof item?.name === 'string' ? item.name.trim() : '';
        const location = typeof item?.location === 'string' ? item.location : '';
        const description = typeof item?.description === 'string' ? item.description : '';
        if (!name || !location) {
          return null;
        }
        const inferred = inferSkillScopeAndSourceFromLocation(location, workingDirectory);
        return {
          name,
          path: location,
          scope: inferred.scope,
          source: inferred.source,
          description,
        } as DiscoveredSkill;
      })
      .filter((item): item is DiscoveredSkill => item !== null);
  } catch {
    return null;
  }
};

const readSharedSettingsFromDisk = (): Record<string, unknown> => {
  try {
    const raw = fs.readFileSync(OPENCHAMBER_SHARED_SETTINGS_PATH, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
};

const writeSharedSettingsToDisk = async (changes: Record<string, unknown>): Promise<void> => {
  try {
    await fs.promises.mkdir(path.dirname(OPENCHAMBER_SHARED_SETTINGS_PATH), { recursive: true });
    const current = readSharedSettingsFromDisk();
    const next: Record<string, unknown> = { ...current, ...changes };
    await fs.promises.writeFile(OPENCHAMBER_SHARED_SETTINGS_PATH, JSON.stringify(next, null, 2), 'utf8');
  } catch {
    // ignore
  }
};

export const readSettings = (ctx?: BridgeContext): Record<string, unknown> => {
  const stored = ctx?.context?.globalState.get<Record<string, unknown>>(SETTINGS_KEY) || {};
  const restStored = { ...stored };
  delete (restStored as Record<string, unknown>).lastDirectory;
  const shared = readSharedSettingsFromDisk();
  const sharedOpencodeBinary = typeof shared.opencodeBinary === 'string' ? shared.opencodeBinary.trim() : '';
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
  const themeVariant =
    vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Light ||
    vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.HighContrastLight
      ? 'light'
      : 'dark';

  return {
    themeVariant,
    lastDirectory: workspaceFolder,
    ...restStored,
    opencodeBinary:
      typeof restStored.opencodeBinary === 'string'
        ? String(restStored.opencodeBinary).trim()
        : (sharedOpencodeBinary || undefined),
  };
};

export const persistSettings = async (changes: Record<string, unknown>, ctx?: BridgeContext): Promise<Record<string, unknown>> => {
  const current = readSettings(ctx);
  const restChanges = { ...(changes || {}) };
  delete restChanges.lastDirectory;

  const keysToClear = new Set<string>();

  for (const key of ['defaultModel', 'defaultVariant', 'defaultAgent', 'defaultGitIdentityId', 'opencodeBinary']) {
    const value = restChanges[key];
    if (typeof value === 'string' && value.trim().length === 0) {
      keysToClear.add(key);
      delete restChanges[key];
    }
  }

  if (typeof restChanges.usageAutoRefresh !== 'boolean') {
    delete restChanges.usageAutoRefresh;
  }

  if (typeof restChanges.usageRefreshIntervalMs === 'number' && Number.isFinite(restChanges.usageRefreshIntervalMs)) {
    restChanges.usageRefreshIntervalMs = Math.max(30000, Math.min(300000, Math.round(restChanges.usageRefreshIntervalMs)));
  } else {
    delete restChanges.usageRefreshIntervalMs;
  }

  const merged = { ...current, ...restChanges, lastDirectory: current.lastDirectory } as Record<string, unknown>;
  for (const key of keysToClear) {
    delete merged[key];
  }
  await ctx?.context?.globalState.update(SETTINGS_KEY, merged);

  if (keysToClear.has('opencodeBinary')) {
    await writeSharedSettingsToDisk({ opencodeBinary: '' });
  } else if (typeof restChanges.opencodeBinary === 'string') {
    await writeSharedSettingsToDisk({ opencodeBinary: restChanges.opencodeBinary.trim() });
  }

  return merged;
};
