import * as fs from 'node:fs';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { OpenCode, type OpenCodeClient } from '@opencode/client';
import * as gitService from './gitService';
import { chooseBridgeGitGenerationModel, type BridgeGitGenerationPayloadModel } from './bridge-git-generation-model';
import type { BridgeContext, BridgeResponse } from './bridge';

type BridgeMessageInput = {
  id: string;
  type: string;
  payload?: unknown;
};

type ExecGitResult = { stdout: string; stderr: string; exitCode: number };

type SpecialGitDeps = {
  readSettings: (ctx?: BridgeContext) => Record<string, unknown>;
  execGit: (args: string[], cwd: string) => Promise<ExecGitResult>;
};

const BRIDGE_GIT_GENERATION_TIMEOUT_MS = 2 * 60 * 1000;

// Waits between retries of `Model unavailable`, ~31 s in total. Right after
// OpenCode starts, plugin-provided models (claude-code) stay unavailable for
// 20-40 s while plugins for the global location load lazily. The rejection
// precedes provider dispatch, so a retry costs no tokens.
const UNAVAILABLE_RETRY_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000, 16_000];
let unavailableRetryDelaysMs = UNAVAILABLE_RETRY_DELAYS_MS;

/** Test hook: replace the backoff schedule; no argument restores the default. */
export const setUnavailableRetryDelaysForTest = (delays: number[] = UNAVAILABLE_RETRY_DELAYS_MS): void => {
  unavailableRetryDelaysMs = delays;
};
const BRIDGE_GIT_MODEL_CATALOG_CACHE_TTL_MS = 30 * 1000;

let bridgeGitModelCatalogCache: Set<string> | null = null;
let bridgeGitModelCatalogCacheAt = 0;

const createBridgeGitClient = (apiUrl: string, authHeaders?: Record<string, string>): OpenCodeClient => OpenCode.make({
  baseUrl: apiUrl.replace(/\/+$/, ''),
  headers: authHeaders || {},
});

const fetchBridgeGitModelCatalog = async (
  apiUrl: string,
  authHeaders?: Record<string, string>
): Promise<Set<string>> => {
  const now = Date.now();
  if (bridgeGitModelCatalogCache && now - bridgeGitModelCatalogCacheAt < BRIDGE_GIT_MODEL_CATALOG_CACHE_TTL_MS) {
    return bridgeGitModelCatalogCache;
  }

  const client = createBridgeGitClient(apiUrl, authHeaders);
  const payload = await client.model.list(undefined, { signal: AbortSignal.timeout(8_000) });
  const refs = new Set<string>();
  for (const model of payload.data) {
    const providerID = model.providerID.trim();
    const modelID = model.id.trim();
    if (providerID && modelID) {
      refs.add(`${providerID}/${modelID}`);
    }
  }

  bridgeGitModelCatalogCache = refs;
  bridgeGitModelCatalogCacheAt = now;
  return refs;
};

const resolveBridgeGitGenerationModel = async (
  payloadModel: BridgeGitGenerationPayloadModel,
  settings: Record<string, unknown>,
  apiUrl: string,
  authHeaders?: Record<string, string>
): Promise<{ providerID: string; modelID: string }> => {
  let catalog: Set<string> | null = null;
  try {
    catalog = await fetchBridgeGitModelCatalog(apiUrl, authHeaders);
  } catch {
    catalog = null;
  }

  const hasModel = (providerID: string, modelID: string): boolean => {
    if (!catalog) {
      return false;
    }
    return catalog.has(`${providerID}/${modelID}`);
  };

  return chooseBridgeGitGenerationModel(payloadModel, settings, hasModel);
};

/**
 * OpenCode 2.x generates one-off text without a session: `POST /api/experimental/generate`
 * answers with the finished text, so the old create-session / prompt / poll /
 * delete dance (and every way it could leave a stray session behind) is gone.
 */
const generateBridgeGitText = async ({
  apiUrl,
  prompt,
  providerID,
  modelID,
  authHeaders,
}: {
  apiUrl: string;
  prompt: string;
  providerID: string;
  modelID: string;
  authHeaders?: Record<string, string>;
}): Promise<string> => {
  const client = createBridgeGitClient(apiUrl, authHeaders);
  const signal = AbortSignal.timeout(BRIDGE_GIT_GENERATION_TIMEOUT_MS);
  const unavailableMessage = `Model unavailable: ${providerID}/${modelID}`;
  for (let attempt = 0; ; attempt += 1) {
    try {
      const result = await client.generate.text({ prompt, model: { id: modelID, providerID } }, { signal });
      return result.text.trim();
    } catch (error) {
      const tagged = error as { _tag?: unknown; message?: unknown } | null;
      // Only the pre-dispatch catalog rejection is retried; other failures must not be.
      if (tagged?._tag !== 'InvalidRequestError' || tagged.message !== unavailableMessage
        || attempt >= unavailableRetryDelaysMs.length) {
        throw error;
      }
      await delay(unavailableRetryDelaysMs[attempt], undefined, { signal });
    }
  }
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
        const { providerID, modelID } = await resolveBridgeGitGenerationModel(
          { providerId, modelId, zenModel: payloadZenModel },
          settings,
          apiUrl,
          ctx?.manager?.getOpenCodeAuthHeaders()
        );
        const raw = await generateBridgeGitText({
          apiUrl,
          prompt,
          providerID,
          modelID,
          authHeaders: ctx?.manager?.getOpenCodeAuthHeaders(),
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
