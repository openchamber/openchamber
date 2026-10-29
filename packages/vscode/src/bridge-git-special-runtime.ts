import * as fs from 'node:fs';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { OpenCode, type OpenCodeClient } from '@opencode/client';
import * as gitService from './gitService';
import { chooseBridgeGitGenerationModel, type BridgeGitGenerationPayloadModel, type BridgeGitGenerationModelChoice } from './bridge-git-generation-model';
import type { BridgeContext, BridgeResponse } from './bridge';
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

type BridgeMessageInput = {
  id: string;
  type: string;
  payload?: unknown;
};

type ExecGitResult = { stdout: string; stderr: string; exitCode: number };

type SpecialGitDeps = {
  readSettings: (ctx?: BridgeContext) => Record<string, unknown>;
  execGit: (args: string[], cwd: string) => Promise<ExecGitResult>;
  /**
   * The effective Magic Prompt overrides for work in a directory (its owning
   * project over global), keyed by prompt id; read through the host so this
   * module stays free of `vscode`. Rejects when a scope cannot be read.
   */
  readPromptOverrides: (directory: string) => Promise<Record<string, string>>;
};

const BRIDGE_GIT_GENERATION_TIMEOUT_MS = 2 * 60 * 1000;

// Waits between retries of an unready catalog, ~31 s in total. Right after
// OpenCode starts, plugin-provided models (claude-code) stay unavailable for
// 20-40 s while plugins for the global location load lazily. The rejection
// precedes provider dispatch, so a retry costs no tokens.
const UNAVAILABLE_RETRY_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000, 16_000];
let unavailableRetryDelaysMs = UNAVAILABLE_RETRY_DELAYS_MS;

// Generation waits up to 5 s for the location's plugins, then answers that
// they are still activating; after them it answers the model missing.
const isCatalogNotReady = (
  error: { _tag?: unknown; providerID?: unknown; modelID?: unknown; service?: unknown } | null,
  providerID: string,
  modelID: string,
): boolean => (
  (error?._tag === 'ModelNotFoundError' && error.providerID === providerID && error.modelID === modelID)
  || (error?._tag === 'ServiceUnavailableError' && error.service === 'plugin')
);

/** Test hook: replace the backoff schedule; no argument restores the default. */
export const setUnavailableRetryDelaysForTest = (delays: number[] = UNAVAILABLE_RETRY_DELAYS_MS): void => {
  unavailableRetryDelaysMs = delays;
};
const BRIDGE_GIT_MODEL_CATALOG_CACHE_TTL_MS = 30 * 1000;

// Model lists are directory-scoped, so the cached catalog belongs to the
// directory it was read for; a flow in another repository must not inherit it.
// `disabled` holds the refs OpenCode lists with `enabled: false`, and zen's
// free models without a login (`settings.apiKey` is OpenCode's `"public"`
// placeholder), which the generate route refuses like the server's resolver says.
type BridgeGitModelCatalog = { disabled: Set<string>; variants: Map<string, Set<string>> };
let bridgeGitModelCatalogCache: { directory: string; catalog: BridgeGitModelCatalog; at: number } | null = null;

/** Test hook: forget the cached model catalog. */
export const resetBridgeGitModelCatalogForTest = (): void => {
  bridgeGitModelCatalogCache = null;
};

// Every OpenCode read here names the flow's directory: model lists, agent
// reads and generation resolve against a location, and without one OpenCode
// answers for its own working directory (with its MCP servers started there).
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

/**
 * The model OpenCode's hidden `title` agent is configured with
 * (`agents.title.model`, or the migrated v1 `small_model`), or null. The
 * server-side small-model resolver reads the same agent; the bridge must
 * agree with it. A cold location answers 404 while its agents load, which
 * reads as "nothing configured" here, the same as on the server.
 */
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
    // No `title` agent (removed in config, or a cold location still loading
    // its agents) or OpenCode unreachable: nothing configured to honor.
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
  // Like the server's small-model resolver, a title model OpenCode lists as
  // disabled is skipped rather than retried until it fails.
  const configuredModel = titleModel && !catalog?.disabled.has(`${titleModel.providerID}/${titleModel.modelID}`)
    ? titleModel
    : null;

  // A catalog only rejects a model it lists as disabled, which is the rule the
  // server-side resolver applies: a config can outlive the login behind it, and
  // OpenCode's own titles move on to another model, but a model the catalog
  // does not list at all (a plugin provider still loading, or a cold location
  // that answered before its providers did) is kept. Gating on "listed" dropped
  // the user's configured small model on every cold start, sent generation to
  // the zen default they cannot use, and the `Model unavailable` retry loop
  // then retried that wrong model until it gave up.
  const hasModel = (providerID: string, modelID: string): boolean => (
    !catalog?.disabled.has(`${providerID}/${modelID}`)
  );
  const hasVariant = (providerID: string, modelID: string, variant: string): boolean => {
    const variants = catalog?.variants.get(`${providerID}/${modelID}`);
    // An unlisted model is not evidence either way; keep the saved variant.
    return variants ? variants.has(variant) : true;
  };

  return chooseBridgeGitGenerationModel(payloadModel, settings, hasModel, configuredModel, hasVariant);
};

/**
 * OpenCode 2.x generates one-off text without a session: `POST /api/experimental/generate/text`
 * answers with the finished text, so the old create-session / prompt / poll /
 * delete dance (and every way it could leave a stray session behind) is gone.
 */
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
      // Only the pre-dispatch catalog rejection is retried; other failures must not be.
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
  execGit: SpecialGitDeps['execGit'],
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
  /** Effective Magic Prompt overrides by prompt id; a present key wins even when empty. */
  promptOverrides: Record<string, string>;
  payloadModel?: BridgeGitGenerationPayloadModel;
  execGit: SpecialGitDeps['execGit'];
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

const parseJsonObjectSafe = (value: string): Record<string, unknown> | null => {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
};

export async function handleSpecialGitBridgeMessage(
  message: BridgeMessageInput,
  ctx: BridgeContext | undefined,
  deps: SpecialGitDeps,
): Promise<BridgeResponse | null> {
  const { id, type, payload } = message;

  switch (type) {
    case 'api:git/commit-message': {
      const { directory, files, providerId, modelId, zenModel: payloadZenModel } = (payload || {}) as {
        directory?: string;
        files?: unknown;
        providerId?: string;
        modelId?: string;
        zenModel?: string;
      };
      if (!directory) {
        return { id, type, success: false, error: 'Directory is required' };
      }

      const selectedFiles = Array.isArray(files)
        ? files.filter((file): file is string => typeof file === 'string' && file.trim().length > 0)
        : undefined;

      try {
        const apiUrl = ctx?.manager?.getApiUrl();
        if (!apiUrl) {
          return { id, type, success: false, error: 'OpenCode API unavailable' };
        }

        const generated = await generateBridgeCommitMessage({
          directory,
          files: selectedFiles,
          apiUrl,
          authHeaders: ctx?.manager?.getOpenCodeAuthHeaders(),
          settings: deps.readSettings(ctx),
          promptOverrides: await deps.readPromptOverrides(directory),
          payloadModel: { providerId, modelId, zenModel: payloadZenModel },
          execGit: deps.execGit,
        });
        return { id, type, success: true, data: { message: generated } };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { id, type, success: false, error: message };
      }
    }

    case 'api:git/pr-description': {
      const { directory, base, head, context, providerId, modelId, zenModel: payloadZenModel } = (payload || {}) as {
        directory?: string;
        base?: string;
        head?: string;
        context?: string;
        providerId?: string;
        modelId?: string;
        zenModel?: string;
      };
      if (!directory) {
        return { id, type, success: false, error: 'Directory is required' };
      }
      if (!base || !head) {
        return { id, type, success: false, error: 'base and head are required' };
      }

      let files: string[] = [];
      try {
        const listed = await gitService.getGitRangeFiles(directory, base, head);
        files = Array.isArray(listed) ? listed : [];
      } catch {
        files = [];
      }

      if (files.length === 0) {
        return { id, type, success: false, error: 'No diffs available for base...head' };
      }

      let diffSummaries = '';
      for (const file of files) {
        try {
          const diff = await gitService.getGitRangeDiff(directory, base, head, file, 3);
          const raw = typeof diff?.diff === 'string' ? diff.diff : '';
          if (!raw.trim()) continue;
          diffSummaries += `FILE: ${file}\n${raw}\n\n`;
        } catch {
          // ignore
        }
      }

      if (!diffSummaries.trim()) {
        return { id, type, success: false, error: 'No diffs available for selected files' };
      }

      const prompt = `You are drafting a GitHub Pull Request title + description. Respond in JSON of the shape {"title": string, "body": string} (ONLY JSON in response, no markdown fences) with these rules:\n- title: concise, sentence case, <= 80 chars, no trailing punctuation, no commit-style prefixes (no "feat:", "fix:")\n- body: GitHub-flavored markdown with these sections in this order: Summary, Testing, Notes\n- Summary: 3-6 bullet points describing user-visible changes; avoid internal helper function names\n- Testing: bullet list ("- Not tested" allowed)\n- Notes: bullet list; include breaking/rollout notes only when relevant\n\nContext:\n- base branch: ${base}\n- head branch: ${head}${context?.trim() ? `\n- Additional context: ${context.trim()}` : ''}\n\nDiff summary:\n${diffSummaries}`;

      try {
        const apiUrl = ctx?.manager?.getApiUrl();
        if (!apiUrl) {
          return { id, type, success: false, error: 'OpenCode API unavailable' };
        }

        const settings = deps.readSettings(ctx) as Record<string, unknown>;
        const { providerID, modelID, variant } = await resolveBridgeGitGenerationModel(
          { providerId, modelId, zenModel: payloadZenModel },
          settings,
          apiUrl,
          ctx?.manager?.getOpenCodeAuthHeaders(),
          directory,
        );
        const raw = await generateBridgeGitText({
          apiUrl,
          prompt,
          providerID,
          modelID,
          variant,
          authHeaders: ctx?.manager?.getOpenCodeAuthHeaders(),
          directory,
        });
        if (!raw) {
          return { id, type, success: false, error: 'No PR description returned by generator' };
        }

        const cleaned = String(raw)
          .trim()
          .replace(/^```json\s*/i, '')
          .replace(/^```\s*/i, '')
          .replace(/```\s*$/i, '')
          .trim();

        const parsed = parseJsonObjectSafe(cleaned) || parseJsonObjectSafe(raw);
        if (parsed) {
          const title = typeof parsed.title === 'string' ? parsed.title : '';
          const body = typeof parsed.body === 'string' ? parsed.body : '';
          return { id, type, success: true, data: { title, body } };
        }

        return { id, type, success: true, data: { title: '', body: String(raw) } };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { id, type, success: false, error: message };
      }
    }

    case 'api:git/conflict-details': {
      const { directory } = (payload || {}) as { directory?: string };
      if (!directory) {
        return { id, type, success: false, error: 'Directory is required' };
      }

      try {
        const statusResult = await deps.execGit(['status', '--porcelain'], directory);
        const statusPorcelain = statusResult.stdout;

        const unmergedResult = await deps.execGit(['diff', '--name-only', '--diff-filter=U'], directory);
        const unmergedFiles = unmergedResult.stdout
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean);

        const diffResult = await deps.execGit(['diff'], directory);
        const diff = diffResult.stdout;

        let operation: 'merge' | 'rebase' = 'merge';
        let headInfo = '';

        const mergeHeadResult = await deps.execGit(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], directory);
        const mergeHeadExists = mergeHeadResult.exitCode === 0;

        if (mergeHeadExists) {
          operation = 'merge';
          const mergeHead = mergeHeadResult.stdout.trim();
          let mergeMsg = '';
          try {
            const mergeMsgPath = path.join(directory, '.git', 'MERGE_MSG');
            mergeMsg = await fs.promises.readFile(mergeMsgPath, 'utf8');
          } catch {
            // MERGE_MSG may not exist
          }
          headInfo = `MERGE_HEAD: ${mergeHead}${mergeMsg ? '\n' + mergeMsg : ''}`;
        } else {
          const rebaseHeadResult = await deps.execGit(['rev-parse', '--verify', '--quiet', 'REBASE_HEAD'], directory);
          const rebaseHeadExists = rebaseHeadResult.exitCode === 0;

          if (rebaseHeadExists) {
            operation = 'rebase';
            const rebaseHead = rebaseHeadResult.stdout.trim();
            headInfo = `REBASE_HEAD: ${rebaseHead}`;
          }
        }

        return {
          id,
          type,
          success: true,
          data: {
            statusPorcelain: statusPorcelain.trim(),
            unmergedFiles,
            diff: diff.trim(),
            headInfo: headInfo.trim(),
            operation,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { id, type, success: false, error: message };
      }
    }

    default:
      return null;
  }
}
