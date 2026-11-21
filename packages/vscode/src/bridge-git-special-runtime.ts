import { setTimeout as delay } from 'node:timers/promises';
import { OpenCode, type OpenCodeClient } from '@opencode/client';
import * as gitService from './gitService';
import { chooseBridgeGitGenerationModel, type BridgeGitGenerationPayloadModel, type BridgeGitGenerationModelChoice } from './bridge-git-generation-model';
import {
  COMMIT_DIFF_FILE_LIMIT,
  COMMIT_DIFF_TOTAL_CHAR_LIMIT,
  COMMIT_STYLE_SAMPLE_COUNT,
  buildCommitGenerationPrompt,
  formatRecentCommitSubjects,
  parseGeneratedCommitMessage,
  commitPathUsesStagedDiff,
  selectCommitFilePaths,
  type GeneratedCommitMessage,
  type GitStatusFileLike,
} from './git-commit-message';

type ExecGitResult = { stdout: string; stderr: string; exitCode: number };

const BRIDGE_GIT_GENERATION_TIMEOUT_MS = 2 * 60 * 1000;

const UNAVAILABLE_RETRY_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000, 16_000];
let unavailableRetryDelaysMs = UNAVAILABLE_RETRY_DELAYS_MS;

const isCatalogNotReady = (
  error: { _tag?: unknown; providerID?: unknown; modelID?: unknown; service?: unknown } | null,
  providerID: string,
  modelID: string,
): boolean => (
  (error?._tag === 'ModelNotFoundError' && error.providerID === providerID && error.modelID === modelID)
  || (error?._tag === 'ServiceUnavailableError' && error.service === 'plugin')
);

export const setUnavailableRetryDelaysForTest = (delays: number[] = UNAVAILABLE_RETRY_DELAYS_MS): void => {
  unavailableRetryDelaysMs = delays;
};
const BRIDGE_GIT_MODEL_CATALOG_CACHE_TTL_MS = 30 * 1000;

type BridgeGitModelCatalog = { disabled: Set<string>; variants: Map<string, Set<string>> };
let bridgeGitModelCatalogCache: { directory: string; catalog: BridgeGitModelCatalog; at: number } | null = null;

export const resetBridgeGitModelCatalogForTest = (): void => {
  bridgeGitModelCatalogCache = null;
};

const createBridgeGitClient = (apiUrl: string, authHeaders?: Record<string, string>, directory?: string): OpenCodeClient => {
  const headers = Object.assign({}, authHeaders || {});
  if (directory) headers['x-opencode-directory'] = encodeURIComponent(directory);
  return OpenCode.make({
    baseUrl: apiUrl.replace(/\/+$/, ''),
    headers,
  });
};

const fetchBridgeGitModelCatalog = async (
  apiUrl: string,
  authHeaders?: Record<string, string>,
  directory = '',
): Promise<BridgeGitModelCatalog> => {
  const now = Date.now();
  if (
    bridgeGitModelCatalogCache
    && bridgeGitModelCatalogCache.directory === directory
    && now - bridgeGitModelCatalogCache.at < BRIDGE_GIT_MODEL_CATALOG_CACHE_TTL_MS
  ) {
    return bridgeGitModelCatalogCache.catalog;
  }

  const client = createBridgeGitClient(apiUrl, authHeaders, directory);
  const payload = await client.model.list(undefined, { signal: AbortSignal.timeout(8_000) });
  const catalog: BridgeGitModelCatalog = { disabled: new Set(), variants: new Map() };
  for (const model of payload.data) {
    const providerID = model.providerID.trim();
    const modelID = model.id.trim();
    if (!providerID || !modelID) continue;
    if (model.enabled === false || (providerID === 'opencode' && model.settings?.apiKey === 'public')) {
      catalog.disabled.add(`${providerID}/${modelID}`);
    }
    const variants = Array.isArray(model.variants)
      ? model.variants.map((variant) => variant.id).filter((id) => id.length > 0)
      : [];
    catalog.variants.set(`${providerID}/${modelID}`, new Set(variants));
  }

  bridgeGitModelCatalogCache = { directory, catalog, at: now };
  return catalog;
};

const fetchBridgeGitTitleModelRef = async (client: OpenCodeClient): Promise<BridgeGitGenerationModelChoice | null> => {
  try {
    const payload = await client.agent.get({ agentID: 'title' });
    const model = payload.data.model;
    if (!model) return null;
    const choice: BridgeGitGenerationModelChoice = { providerID: model.providerID, modelID: model.id };
    const variant = model.variant?.trim();
    if (variant) choice.variant = variant;
    return choice;
  } catch {
    return null;
  }
};

const resolveBridgeGitGenerationModel = async (
  payloadModel: BridgeGitGenerationPayloadModel,
  settings: Record<string, unknown>,
  apiUrl: string,
  authHeaders?: Record<string, string>,
  directory = '',
): Promise<BridgeGitGenerationModelChoice> => {
  let catalog: BridgeGitModelCatalog | null = null;
  try {
    catalog = await fetchBridgeGitModelCatalog(apiUrl, authHeaders, directory);
  } catch {
    catalog = null;
  }
  const titleModel = await fetchBridgeGitTitleModelRef(createBridgeGitClient(apiUrl, authHeaders, directory));
  const configuredModel = titleModel && !catalog?.disabled.has(`${titleModel.providerID}/${titleModel.modelID}`)
    ? titleModel
    : null;

  const hasModel = (providerID: string, modelID: string): boolean => (
    !catalog?.disabled.has(`${providerID}/${modelID}`)
  );
  const hasVariant = (providerID: string, modelID: string, variant: string): boolean => {
    const variants = catalog?.variants.get(`${providerID}/${modelID}`);
    return variants ? variants.has(variant) : true;
  };

  return chooseBridgeGitGenerationModel(payloadModel, settings, hasModel, configuredModel, hasVariant);
};

const generateBridgeGitText = async ({
  apiUrl,
  prompt,
  providerID,
  modelID,
  variant,
  authHeaders,
  directory,
}: {
  apiUrl: string;
  prompt: string;
  providerID: string;
  modelID: string;
  variant?: string;
  authHeaders?: Record<string, string>;
  directory?: string;
}): Promise<string> => {
  const client = createBridgeGitClient(apiUrl, authHeaders, directory);
  const signal = AbortSignal.timeout(BRIDGE_GIT_GENERATION_TIMEOUT_MS);
  const model = variant
    ? { id: modelID, providerID, variant }
    : { id: modelID, providerID };
  for (let attempt = 0; ; attempt += 1) {
    try {
      const result = await client.experimental.generate.text({ prompt, model }, { signal });
      return result.text.trim();
    } catch (error) {
      const tagged = error as { _tag?: unknown; providerID?: unknown; modelID?: unknown; service?: unknown } | null;
      if (!isCatalogNotReady(tagged, providerID, modelID) || attempt >= unavailableRetryDelaysMs.length) {
        throw error;
      }
      await delay(unavailableRetryDelaysMs[attempt], undefined, { signal });
    }
  }
};

const nullDevicePath = process.platform === 'win32' ? 'NUL' : '/dev/null';

const collectRecentCommitSubjects = async (directory: string): Promise<string> => {
  try {
    const log = await gitService.getGitLog(directory, { maxCount: COMMIT_STYLE_SAMPLE_COUNT });
    const messages = (Array.isArray(log?.all) ? log.all : [])
      .map((entry) => (typeof entry?.message === 'string' ? entry.message : ''));
    return formatRecentCommitSubjects(messages);
  } catch {
    return '(recent commits unavailable)';
  }
};

const collectSelectedFileDiffs = async (
  directory: string,
  files: string[],
  statusFiles: GitStatusFileLike[],
  execGit: (args: string[], cwd: string) => Promise<ExecGitResult>,
): Promise<string> => {
  const statusByPath = new Map(statusFiles.map((file) => [file.path, file]));
  const limited = files.slice(0, COMMIT_DIFF_FILE_LIMIT);
  const chunks = await Promise.all(limited.map(async (filePath) => {
    try {
      if (commitPathUsesStagedDiff(statusByPath.get(filePath))) {
        const staged = await gitService.getGitDiff(directory, filePath, true).catch(() => null);
        if (staged?.kind === 'diff' && staged.diff.trim()) return staged.diff;
        return `--- ${filePath} (no textual diff available)`;
      }

      const unstaged = await gitService.getGitDiff(directory, filePath, false).catch(() => null);
      if (unstaged?.kind === 'diff' && unstaged.diff.trim()) return unstaged.diff;

      const noIndex = await execGit(
        ['diff', '--no-color', '--no-index', '--', nullDevicePath, filePath],
        directory,
      );
      if (noIndex.stdout.trim()) return noIndex.stdout;
      return `--- ${filePath} (no textual diff available)`;
    } catch {
      return `--- ${filePath} (diff unavailable)`;
    }
  }));

  let total = '';
  for (const chunk of chunks) {
    if (total.length + chunk.length > COMMIT_DIFF_TOTAL_CHAR_LIMIT) {
      total += '\n[remaining diffs truncated]';
      break;
    }
    total += (total ? '\n\n' : '') + chunk;
  }
  if (files.length > limited.length) {
    total += `\n[${files.length - limited.length} more selected files omitted]`;
  }
  return total;
};

export const generateBridgeCommitMessage = async ({
  directory,
  files,
  apiUrl,
  authHeaders,
  settings,
  promptOverrides,
  payloadModel,
  execGit,
}: {
  directory: string;
  files?: string[];
  apiUrl: string;
  authHeaders?: Record<string, string>;
  settings: Record<string, unknown>;
  promptOverrides: Record<string, string>;
  payloadModel?: BridgeGitGenerationPayloadModel;
  execGit: (args: string[], cwd: string) => Promise<ExecGitResult>;
}): Promise<GeneratedCommitMessage> => {
  let selectedFiles = Array.isArray(files)
    ? files.map((file) => file.trim()).filter(Boolean)
    : [];
  const status = await gitService.getGitStatus(directory, { mode: 'light' });
  if (selectedFiles.length === 0) {
    selectedFiles = selectCommitFilePaths(status.files);
  }
  if (selectedFiles.length === 0) {
    throw new Error('No files provided to generate commit message');
  }

  const [recentCommits, diffs] = await Promise.all([
    collectRecentCommitSubjects(directory),
    collectSelectedFileDiffs(directory, selectedFiles, status.files, execGit),
  ]);
  if (!diffs.trim()) {
    throw new Error('No diffs available for selected files');
  }

  const { system, prompt } = buildCommitGenerationPrompt(selectedFiles, recentCommits, diffs, promptOverrides);
  const { providerID, modelID, variant } = await resolveBridgeGitGenerationModel(
    payloadModel ?? {},
    settings,
    apiUrl,
    authHeaders,
    directory,
  );
  const raw = await generateBridgeGitText({
    apiUrl,
    prompt: `${system}\n\n${prompt}`,
    providerID,
    modelID,
    variant,
    authHeaders,
    directory,
  });
  const parsed = parseGeneratedCommitMessage(raw);
  if (!parsed) {
    throw new Error('No commit message returned by generator');
  }
  return parsed;
};
