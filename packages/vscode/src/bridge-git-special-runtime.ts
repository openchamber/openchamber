import * as fs from 'node:fs';
import * as path from 'node:path';
import * as gitService from './gitService';
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

const BRIDGE_ZEN_DEFAULT_MODEL = 'gpt-5-nano';
const BRIDGE_GIT_GENERATION_TIMEOUT_MS = 2 * 60 * 1000;
const BRIDGE_GIT_GENERATION_POLL_INTERVAL_MS = 500;
const BRIDGE_GIT_MODEL_CATALOG_CACHE_TTL_MS = 30 * 1000;

let bridgeGitModelCatalogCache: Set<string> | null = null;
let bridgeGitModelCatalogCacheAt = 0;

const sleep = (ms: number) => new Promise<void>((resolve) => {
  setTimeout(resolve, ms);
});

const readStringField = (value: unknown, key: string): string => {
  if (!value || typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;
  const candidate = record[key];
  return typeof candidate === 'string' ? candidate.trim() : '';
};

const fetchBridgeGitModelCatalog = async (
  apiUrl: string,
  authHeaders?: Record<string, string>
): Promise<Set<string>> => {
  const now = Date.now();
  if (bridgeGitModelCatalogCache && now - bridgeGitModelCatalogCacheAt < BRIDGE_GIT_MODEL_CATALOG_CACHE_TTL_MS) {
    return bridgeGitModelCatalogCache;
  }

  const headers = authHeaders || {};
  const modelsUrl = new URL(`${apiUrl.replace(/\/+$/, '')}/model`);
  const response = await fetch(modelsUrl.toString(), {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      ...headers,
    },
    signal: AbortSignal.timeout(8_000),
  });

  if (!response.ok) {
    throw new Error('Failed to fetch model catalog');
  }

  const payload = await response.json().catch(() => null) as unknown;
  const refs = new Set<string>();
  if (Array.isArray(payload)) {
    for (const item of payload) {
      if (!item || typeof item !== 'object') {
        continue;
      }
      const record = item as Record<string, unknown>;
      const providerID = typeof record.providerID === 'string' ? record.providerID.trim() : '';
      const modelID = typeof record.modelID === 'string' ? record.modelID.trim() : '';
      if (providerID && modelID) {
        refs.add(`${providerID}/${modelID}`);
      }
    }
  }

  bridgeGitModelCatalogCache = refs;
  bridgeGitModelCatalogCacheAt = now;
  return refs;
};

const resolveBridgeGitGenerationModel = async (
  payloadModel: { providerId?: string; modelId?: string; zenModel?: string },
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

  const requestProviderId = typeof payloadModel.providerId === 'string' ? payloadModel.providerId.trim() : '';
  const requestModelId = typeof payloadModel.modelId === 'string' ? payloadModel.modelId.trim() : '';
  if (requestProviderId && requestModelId && hasModel(requestProviderId, requestModelId)) {
    return { providerID: requestProviderId, modelID: requestModelId };
  }

  const settingsProviderId = readStringField(settings, 'gitProviderId');
  const settingsModelId = readStringField(settings, 'gitModelId');
  if (settingsProviderId && settingsModelId && hasModel(settingsProviderId, settingsModelId)) {
    return { providerID: settingsProviderId, modelID: settingsModelId };
  }

  const payloadZenModel = typeof payloadModel.zenModel === 'string' ? payloadModel.zenModel.trim() : '';
  const settingsZenModel = readStringField(settings, 'zenModel');
  return {
    providerID: 'zen',
    modelID: payloadZenModel || settingsZenModel || BRIDGE_ZEN_DEFAULT_MODEL,
  };
};

const extractTextFromMessageParts = (parts: unknown): string => {
  if (!Array.isArray(parts)) {
    return '';
  }

  const textParts = parts
    .filter((part) => {
      if (!part || typeof part !== 'object') return false;
      const record = part as Record<string, unknown>;
      return record.type === 'text' && typeof record.text === 'string';
    })
    .map((part) => (part as Record<string, unknown>).text as string)
    .map((text) => text.trim())
    .filter((text) => text.length > 0);

  return textParts.join('\n').trim();
};

const generateBridgeTextWithSessionFlow = async ({
  apiUrl,
  directory,
  prompt,
  providerID,
  modelID,
  authHeaders,
}: {
  apiUrl: string;
  directory: string;
  prompt: string;
  providerID: string;
  modelID: string;
  authHeaders?: Record<string, string>;
}): Promise<string> => {
  const headers = authHeaders || {};
  const apiBase = apiUrl.replace(/\/+$/, '');
  const deadlineAt = Date.now() + BRIDGE_GIT_GENERATION_TIMEOUT_MS;
  const remainingMs = () => Math.max(1_000, deadlineAt - Date.now());
  let sessionId: string | null = null;

  try {
    const sessionUrl = new URL(`${apiBase}/session`);
    if (directory) {
      sessionUrl.searchParams.set('directory', directory);
    }

    const createResponse = await fetch(sessionUrl.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
      body: JSON.stringify({ title: 'Git Generation' }),
      signal: AbortSignal.timeout(remainingMs()),
    });

    if (!createResponse.ok) {
      throw new Error('Failed to create OpenCode session');
    }

    const session = await createResponse.json().catch(() => null) as unknown;
    const sessionObj = session && typeof session === 'object' ? session as Record<string, unknown> : null;
    const createdSessionId = sessionObj && typeof sessionObj.id === 'string' ? sessionObj.id : '';
    if (!createdSessionId) {
      throw new Error('Invalid session response');
    }
    sessionId = createdSessionId;

    const promptUrl = new URL(`${apiBase}/session/${encodeURIComponent(sessionId)}/prompt_async`);
    if (directory) {
      promptUrl.searchParams.set('directory', directory);
    }

    const promptResponse = await fetch(promptUrl.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
      body: JSON.stringify({
        model: {
          providerID,
          modelID,
        },
        parts: [{ type: 'text', text: prompt }],
      }),
      signal: AbortSignal.timeout(remainingMs()),
    });

    if (!promptResponse.ok) {
      throw new Error('Failed to send prompt');
    }

    const messagesUrl = new URL(`${apiBase}/session/${encodeURIComponent(sessionId)}/message`);
    if (directory) {
      messagesUrl.searchParams.set('directory', directory);
    }
    messagesUrl.searchParams.set('limit', '10');

    while (Date.now() < deadlineAt) {
      await sleep(BRIDGE_GIT_GENERATION_POLL_INTERVAL_MS);

      const messagesResponse = await fetch(messagesUrl.toString(), {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          ...headers,
        },
        signal: AbortSignal.timeout(remainingMs()),
      });

      if (!messagesResponse.ok) {
        continue;
      }

      const messages = await messagesResponse.json().catch(() => null) as unknown;
      if (!Array.isArray(messages)) {
        continue;
      }

      for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i] as Record<string, unknown> | null;
        if (!message || typeof message !== 'object') {
          continue;
        }
        const info = message.info as Record<string, unknown> | undefined;
        if (info?.role !== 'assistant' || info?.finish !== 'stop') {
          continue;
        }

        const text = extractTextFromMessageParts(message.parts);
        if (text) {
          return text;
        }
      }
    }

    throw new Error('Timeout waiting for generation to complete');
  } finally {
    if (sessionId) {
      const deleteUrl = new URL(`${apiBase}/session/${encodeURIComponent(sessionId)}`);
      try {
        await fetch(deleteUrl.toString(), {
          method: 'DELETE',
          headers,
          signal: AbortSignal.timeout(5_000),
        });
      } catch {
        // ignore cleanup failures
      }
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
        const raw = await generateBridgeTextWithSessionFlow({
          apiUrl,
          directory,
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
