/**
 * Global AGENTS.md reader
 *
 * Reads AGENTS.md from global (non-project) locations:
 *   1. ~/.config/opencode/AGENTS.md  (opencode config directory)
 *   2. ~/AGENTS.md                   (user home directory)
 *
 * These files provide context instructions that apply across all
 * projects, complementing project-level AGENTS.md files read by
 * the OpenCode backend.
 */

import fs from 'fs/promises';
import path from 'path';
import os from 'os';

const GLOBAL_AGENTS_PATHS = [
  path.join(os.homedir(), '.config', 'opencode', 'AGENTS.md'),
  path.join(os.homedir(), 'AGENTS.md'),
];

const CACHE_TTL_MS = 5000;
let cachedResult = null;
let cacheTimestamp = 0;

async function readFileIfExists(filePath) {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    return { path: filePath, content, exists: true };
  } catch {
    return { path: filePath, content: null, exists: false };
  }
}

export async function readGlobalAgentsMd() {
  const now = Date.now();
  if (cachedResult && now - cacheTimestamp < CACHE_TTL_MS) {
    return cachedResult;
  }

  const results = await Promise.all(GLOBAL_AGENTS_PATHS.map(readFileIfExists));
  const active = results
    .filter((r) => r.exists && r.content && r.content.trim().length > 0)
    .map((r) => ({ path: r.path, content: r.content.trim() }));

  cachedResult = {
    active,
    count: active.length,
    paths: GLOBAL_AGENTS_PATHS,
  };
  cacheTimestamp = now;

  return cachedResult;
}

export function registerGlobalAgentsRoutes(app) {
  app.get('/api/global-agents-md', async (_req, res) => {
    const result = await readGlobalAgentsMd();
    res.json({
      active: result.active,
      count: result.count,
      paths: result.paths,
    });
  });
}
