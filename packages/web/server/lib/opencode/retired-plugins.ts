import { z } from 'zod';

import type { JsonValue } from '../shared/json-values.js';
import { getLayerError, readConfigLayers, writeConfig } from './config-files.js';
import type { OpenCodeConfigLayer, OpenCodeConfigLayers } from './config-files.js';
import { PLUGIN_SECTION, toPluginEntity } from './config-v2.js';
import { pluginPolicyResource } from './plugin-switches.js';

const RETIRED_PACKAGE = '@openchamber/opencode-claude';
const REPLACEMENT_PROVIDER = 'claude-agent';
const RETIRED_RESOURCE = pluginPolicyResource(RETIRED_PACKAGE);
const ATTEMPTS = 90;
const RETRY_MS = 2000;

const integrationSchema = z.object({ data: z.object({ connections: z.array(z.unknown()) }) });

const isRetiredEntry = (raw: JsonValue) => {
  const entity = toPluginEntity(raw);
  return entity !== null && pluginPolicyResource(entity.package) === RETIRED_RESOURCE;
};

const withoutRetiredPlugins = (config: OpenCodeConfigLayer) => {
  let changed = false;
  const next: OpenCodeConfigLayer = { ...config };
  for (const key of [PLUGIN_SECTION.v2, PLUGIN_SECTION.v1]) {
    const list = next[key];
    if (!Array.isArray(list)) continue;
    const kept = list.filter((raw) => !isRetiredEntry(raw));
    if (kept.length === list.length) continue;
    changed = true;
    next[key] = kept;
  }
  return changed ? next : null;
};

export const retireReplacedPlugins = ({
  readLayers = () => readConfigLayers(null),
  writeLayer = writeConfig,
}: {
  readLayers?: () => OpenCodeConfigLayers;
  writeLayer?: typeof writeConfig;
} = {}) => {
  const layers = readLayers();
  const sources = [{ config: layers.userConfig, filePath: layers.paths.userPath }];
  if (layers.paths.userOverridePath) sources.push({ config: layers.userOverrideConfig, filePath: layers.paths.userOverridePath });
  const rewritten: string[] = [];
  for (const source of sources) {
    const next = getLayerError(layers, source.filePath) ? null : withoutRetiredPlugins(source.config);
    if (!next) continue;
    writeLayer(next, source.filePath);
    rewritten.push(source.filePath);
  }
  return rewritten;
};

const retireBeforeStart = () => {
  try {
    const rewritten = retireReplacedPlugins();
    for (const filePath of rewritten) {
      console.log(`[OpenCode] Removed ${RETIRED_PACKAGE} from ${filePath}; Claude runs on the built-in Claude Agent provider`);
    }
    return rewritten.length > 0;
  } catch (error) {
    console.warn(`[OpenCode] Could not remove ${RETIRED_PACKAGE} from the OpenCode config:`, error instanceof Error ? error.message : error);
    return false;
  }
};

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface ReplacementConnection {
  buildOpenCodeUrl: (path: string, prefix: string) => string;
  getOpenCodeAuthHeaders: () => Record<string, string>;
  directory: string | null;
  fetchImpl?: typeof fetch;
  retryMs?: number;
}

const integrationRequest = async ({ buildOpenCodeUrl, getOpenCodeAuthHeaders, directory, fetchImpl = fetch }: ReplacementConnection, path: string, init: RequestInit = {}) => {
  const headers = new Headers({ 'Content-Type': 'application/json', ...getOpenCodeAuthHeaders() });
  if (directory) headers.set('x-opencode-directory', encodeURIComponent(directory));
  return fetchImpl(buildOpenCodeUrl(`/api/integration/${REPLACEMENT_PROVIDER}${path}`, ''), { ...init, headers, signal: AbortSignal.timeout(30_000) });
};

export const connectReplacementProvider = async (connection: ReplacementConnection) => {
  for (let attempt = 1; ; attempt += 1) {
    const current = await integrationRequest(connection, '').catch(() => null);
    if (current?.ok) {
      const integration = integrationSchema.safeParse(await current.json().catch(() => null));
      if (integration.success && integration.data.data.connections.length > 0) return 'already-connected';
      const response = await integrationRequest(connection, '/connect/external', { method: 'POST', body: JSON.stringify({ methodID: 'claude-login' }) });
      if (!response.ok) throw new Error(`OpenCode answered ${response.status} to connecting Claude Agent`);
      return 'connected';
    }
    if (attempt >= ATTEMPTS) throw new Error(`Claude Agent did not become available in OpenCode${current ? ` (${current.status})` : ''}`);
    await pause(connection.retryMs ?? RETRY_MS);
  }
};

export const RETIRED_CLAUDE_PLUGIN_KIND = { connected: 'opencode-claude-retired', unconnected: 'opencode-claude-retired-unconnected' };

export const retireClaudePlugin = ({ notify, ...connection }: ReplacementConnection & {
  notify: (payload: { kind: string; tag: string }) => void;
}) => {
  if (!retireBeforeStart()) return;
  void connectReplacementProvider(connection)
    .then((outcome) => {
      console.log(`[OpenCode] Claude Agent replaces the retired opencode-claude plugin (${outcome})`);
      return RETIRED_CLAUDE_PLUGIN_KIND.connected;
    })
    .catch((error) => {
      console.warn('[OpenCode] Could not connect Claude Agent:', error instanceof Error ? error.message : error);
      return RETIRED_CLAUDE_PLUGIN_KIND.unconnected;
    })
    .then((kind) => notify({ kind, tag: 'opencode-claude-retired' }));
};
