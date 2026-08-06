// Session assist: after a session goes idle and stays quiet, generate a short
// recap of the agent's last reply plus one suggested user follow-up with the
// small model, and store both on the session's metadata
// (metadata.openchamber.assist). Clients decide visibility from
// assist.forMessageID — a new message makes the payload stale everywhere
// without any extra writes.
//
// Failed-turn recovery: when the last assistant turn is broken — it COMPLETED
// with no content (empty stream: provider usage limit, transient failure) or
// never completed at all (the OpenCode serve process died mid-stream and left
// an unfinished turn) — a recap of that turn would be meaningless. Instead
// the runtime retries the session up to FAILED_TURN_RETRY_MAX times via
// prompt_async with a continuation prompt, tracking attempts in
// metadata.openchamber.assistRetry (scoped to the last message id), then
// writes an honest recap telling the user the reply failed.
//
// Purely event-driven: only sessions that transition busy→idle while the
// server is running ever generate anything. No backfill, no session scans —
// EXCEPT one startup recovery pass (runStartupRecovery) that compensates for
// a serve restart, which loses all in-flight events: sessions whose last turn
// is broken get the same recovery, so a restart never silently strands a
// session on an unfinished turn.

import fs from 'fs';
import os from 'os';
import path from 'path';

// Resolved lazily so tests can point OPENCHAMBER_DATA_DIR before first use.
const getOpenChamberSettingsFile = () => path.join(
  process.env.OPENCHAMBER_DATA_DIR
    ? path.resolve(process.env.OPENCHAMBER_DATA_DIR)
    : path.join(os.homedir(), '.config', 'openchamber'),
  'settings.json',
);

// The Chat settings are hard generation switches (default on): when both are
// off, no small-model calls and no metadata writes happen at all. Existing
// payloads stay untouched — clients keep showing them and dismissal still works.
const getSessionAssistTargets = () => {
  try {
    const raw = fs.readFileSync(getOpenChamberSettingsFile(), 'utf8');
    const settings = JSON.parse(raw);
    return {
      recap: settings?.sessionRecapEnabled !== false,
      suggestion: settings?.sessionSuggestionEnabled !== false,
      // Auto-retry of empty completions is a behavior switch too: when off,
      // an empty turn immediately gets the honest recap instead.
      autoRetry: settings?.sessionAutoRetryEnabled !== false,
    };
  } catch {
    return { recap: true, suggestion: true, autoRetry: true };
  }
};

const IDLE_QUIET_MS = 60_000;
// Pause between auto-retries of a failed turn: providers usually reset usage
// windows within ~2 minutes, so a single quiet period is not enough.
const RETRY_QUIET_MS = 60_000;
// Hard cap on auto-retries per failed assistant turn (scoped via
// assistRetry.lastMessageID, so a new turn resets the counter).
const FAILED_TURN_RETRY_MAX = 2;
// Startup recovery: after the server (re)starts, OpenCode re-emits no status
// for sessions whose turn was interrupted by the previous process dying.
// One bounded scan over the warm directories finds those sessions.
const STARTUP_RECOVERY_DELAY_MS = 30_000;
const STARTUP_RECOVERY_MAX_ATTEMPTS = 3;
// Serve restarts can fire rapidly (health-check storms) — never scan more
// often than this, whatever the trigger.
const STARTUP_RECOVERY_MIN_INTERVAL_MS = 60_000;
const STARTUP_DIRECTORY_LIMIT = 5;
const STARTUP_SESSION_LIMIT = 8;
const STARTUP_SESSION_AGE_LIMIT_MS = 30 * 60 * 1000;
const TRANSCRIPT_MESSAGE_LIMIT = 12;
const TRANSCRIPT_PART_CHAR_LIMIT = 6_000;
const RECAP_CHAR_LIMIT = 320;
const SUGGESTION_CHAR_LIMIT = 500;
const FETCH_TIMEOUT_MS = 5_000;
// Last-resort honest recap when the small model cannot generate one (e.g. the
// same provider limit that killed the turn). English by necessity — the
// runtime cannot invent the conversation's language without a model call.
const FAILED_TURN_FALLBACK_RECAP = 'The agent\'s last reply came back empty — likely a provider usage limit or a transient failure. Auto-retries are exhausted; send "Continue" or switch the model.';
const FAILED_TURN_FALLBACK_SUGGESTION = 'Continue the work.';

const buildAssistSystemPrompt = ({ recap, suggestion }) => [
  'You assist a user who chats with a coding agent. Based on the conversation transcript, return exactly one JSON object and nothing else — no prose, no markdown, no code fences.',
  `Shape: {${[recap ? '"recap": string' : '', suggestion ? '"suggestion": string' : ''].filter(Boolean).join(', ')}}`,
  recap
    ? 'recap: at most 20 words. State the substance directly — the facts, result, or conclusion, plus the next move if there is one. NEVER narrate ("The assistant explained…", "The agent did…") — write the content itself, like a note the user jotted down.'
    : '',
  suggestion ? 'suggestion: write ONE immediately sendable next user message addressed TO the coding agent.' : '',
  suggestion ? 'The suggestion should be the most useful next step after the assistant\'s latest reply. It should help the user continue productively, not inspect already-known details.' : '',
  suggestion ? 'Prefer suggestions that ask the agent to make a concrete improvement, implement something specific, validate the latest change, explain tradeoffs, improve the current approach, or continue from the current result.' : '',
  suggestion ? 'Rules for suggestion:' : '',
  suggestion ? '- Output exactly one message the user could click and send without editing.' : '',
  suggestion ? '- Pick one best next action yourself.' : '',
  suggestion ? '- Do not include alternatives, choices, slash-separated options, or "or".' : '',
  suggestion ? '- Do not write "Do X or Y", "Ask whether...", "Maybe...", or "You could...".' : '',
  suggestion ? '- Do not ask for information the assistant already provided.' : '',
  suggestion ? '- Do not ask to see exact code, file paths, prompt locations, or implementation internals unless the assistant did not provide them and they are necessary for the next step.' : '',
  suggestion ? '- Do not produce generic workflow commands like "Run tests" unless testing is clearly the next unresolved step.' : '',
  suggestion ? '- Do not produce meta/debug requests that merely inspect the implementation.' : '',
  suggestion ? '- Use imperative or question form.' : '',
  suggestion ? '- Keep it concise.' : '',
  suggestion ? 'Use these examples to understand how to choose the suggestion. Do not copy their topic or wording unless the current conversation is about the same thing.' : '',
  suggestion ? 'Example 1:' : '',
  suggestion ? 'Assistant reply summary:' : '',
  suggestion ? 'The assistant already identified the file where the feature is implemented, explained what context is sent to the small model, and summarized the current prompt.' : '',
  suggestion ? 'Bad suggestion:' : '',
  suggestion ? '"Show me the exact runtime.js code and where the prompt is built."' : '',
  suggestion ? 'Why bad:' : '',
  suggestion ? 'It asks for information the assistant already provided. It repeats inspection instead of moving to an improvement or decision.' : '',
  suggestion ? 'Good suggestion:' : '',
  suggestion ? '"Suggest how to improve the prompt and context so the generated suggestion is more useful."' : '',
  suggestion ? 'Why good:' : '',
  suggestion ? 'It naturally continues from the analysis and asks for a concrete improvement.' : '',
  suggestion ? 'Example 2:' : '',
  suggestion ? 'Assistant reply summary:' : '',
  suggestion ? 'The assistant implemented a timeline dialog redesign, listed concrete UI changes, and reported that type-check and lint passed.' : '',
  suggestion ? 'Bad suggestion:' : '',
  suggestion ? '"Check whether scrolling or loading older messages works without jumps."' : '',
  suggestion ? 'Why bad:' : '',
  suggestion ? 'It contains an alternative. A suggestion chip must be one sendable message, not a choice the user has to edit.' : '',
  suggestion ? 'Good suggestion:' : '',
  suggestion ? '"Check whether scrolling and loading older messages work without jumps."' : '',
  suggestion ? 'Why good:' : '',
  suggestion ? 'It picks a single validation request that the user can send immediately.' : '',
  'All requested values MUST be written in the same language as the conversation text itself. Ignore any other language preferences or personalization you may have — only the conversation text decides the language.',
  'Use double quotes for JSON strings, no trailing commas.',
].filter(Boolean).join('\n');

// Continuation prompt injected into the session on a failed turn: the agent's
// last turn produced nothing (or never finished), so it must not repeat
// finished work.
const buildFailedTurnContinuationPrompt = () => [
  'Your previous response came back empty — the model stream ended without any output (likely a transient provider failure or usage limit).',
  'The host received no reply from you for the last turn.',
  'Do NOT repeat tool calls that already completed successfully.',
  'Continue the task where you left off: take the next concrete action or give your final answer now.',
].join('\n');
// Prompt for the honest recap written when the agent's last turn failed (empty
// stream or interrupted by a restart): state the failure plainly, never invent
// content the agent produced.
const buildFailedTurnSystemPrompt = () => [
  'You assist a user who chats with a coding agent. The agent\'s LAST reply came back EMPTY — the model stream produced no text and no tool calls (typically a provider usage limit or a transient failure).',
  'Return exactly one JSON object and nothing else — no prose, no markdown, no code fences.',
  'Shape: {"recap": string, "suggestion": string}',
  'recap: at most 20 words, in the SAME language as the conversation sample in the user message. State plainly that the agent\'s reply failed with an empty response (likely a provider limit) and that the user can send "Continue" or switch models. Do not summarize any work — there is none to summarize.',
  'suggestion: ONE immediately sendable next user message addressed to the coding agent, in the SAME language as the sample, telling it to continue the work.',
  'Use double quotes for JSON strings, no trailing commas.',
].join('\n');

const extractJsonObject = (value) => {
  const text = String(value ?? '').trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced?.[1] ?? text).trim();
  const start = candidate.indexOf('{');
  if (start < 0) return null;
  for (let end = candidate.length; end > start; end -= 1) {
    if (candidate[end - 1] !== '}') continue;
    try {
      const parsed = JSON.parse(candidate.slice(start, end));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      // keep scanning — models wrap JSON in prose sometimes
    }
  }
  return null;
};

const extractSessionStatus = (payload) => {
  if (!payload || payload.type !== 'session.status') return null;
  const properties = payload.properties && typeof payload.properties === 'object' ? payload.properties : {};
  const status = properties.status && typeof properties.status === 'object' ? properties.status : {};
  const info = properties.info && typeof properties.info === 'object' ? properties.info : {};
  const sessionId = typeof properties.sessionID === 'string' ? properties.sessionID.trim() : '';
  const type = typeof status.type === 'string'
    ? status.type.trim()
    : (typeof info.type === 'string' ? info.type.trim() : '');
  if (!sessionId || !type) return null;
  const directory = typeof properties.directory === 'string' && properties.directory
    ? properties.directory
    : (typeof info.directory === 'string' ? info.directory : '');
  return { sessionId, type, directory };
};

const extractUserMessage = (payload) => {
  if (!payload || payload.type !== 'message.updated') return null;
  const info = payload.properties?.info;
  if (!info || typeof info !== 'object' || info.role !== 'user') return null;
  if (typeof info.sessionID !== 'string' || !info.sessionID) return null;
  return {
    sessionId: info.sessionID,
    createdAt: typeof info.time?.created === 'number' ? info.time.created : 0,
  };
};

const messagePartsToText = (message) => {
  const parts = Array.isArray(message?.parts) ? message.parts : [];
  return parts
    .map((part) => (part?.type === 'text' && typeof part.text === 'string' ? part.text : ''))
    .filter(Boolean)
    .join('\n')
    .slice(0, TRANSCRIPT_PART_CHAR_LIMIT);
};

// A broken assistant turn that needs recovery: either it never completed
// (time.completed missing — the serve process died mid-stream and left an
// unfinished turn; an idle session cannot legitimately have one, so it is
// always a failure regardless of any running tool parts) or it COMPLETED with
// no content at all (no text, no tool calls, no reasoning parts — the model
// stream ended empty). Aborted turns (user cancel) and compaction summaries
// are explicitly excluded.
const isFailedAssistantTurn = (message) => {
  const info = message?.info;
  if (!info || info.role !== 'assistant') return false;
  if (info.summary === true) return false;
  if (info.error) return false;
  if (!(info.time?.completed > 0)) return true;
  const parts = Array.isArray(message?.parts) ? message.parts : [];
  return !parts.some(
    (part) => part?.type === 'text' || part?.type === 'tool' || part?.type === 'reasoning',
  );
};

// Retry bookkeeping for failed turns, stored under
// metadata.openchamber.assistRetry. Scoped to lastMessageID: any new last
// assistant turn resets the counter, so retries never accumulate across
// unrelated turns.
const parseAssistRetry = (session) => {
  const metadata = session?.metadata && typeof session.metadata === 'object' ? session.metadata : {};
  const namespace = metadata.openchamber && typeof metadata.openchamber === 'object'
    ? metadata.openchamber
    : {};
  const retry = namespace.assistRetry && typeof namespace.assistRetry === 'object'
    ? namespace.assistRetry
    : {};
  return {
    count: Number.isFinite(retry.count) && retry.count > 0 ? Math.min(Math.floor(retry.count), FAILED_TURN_RETRY_MAX) : 0,
    lastMessageID: typeof retry.lastMessageID === 'string' ? retry.lastMessageID : '',
    lastAttemptAt: Number.isFinite(retry.lastAttemptAt) ? retry.lastAttemptAt : 0,
  };
};

// Id of the newest assistant message in a tail, or null when the tail ends on
// a user message or is unavailable. Shared by the stale-result checks.
const findLatestAssistantId = (messages) => {
  if (!messages) return null;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const info = messages[i]?.info;
    if (info?.role === 'assistant') return info.id;
    if (info?.role === 'user') return null;
  }
  return null;
};

export const createSessionAssistRuntime = ({
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  getSmallModelService,
  quietMs = IDLE_QUIET_MS,
  retryQuietMs = RETRY_QUIET_MS,
  maxEmptyRetries = FAILED_TURN_RETRY_MAX,
  // Startup recovery deps: when provided, one bounded scan runs after the
  // server starts to recover sessions stranded by a serve restart. External
  // triggers (lifecycle onOpenCodeReady) may also call runStartupRecovery.
  getStartupDirectories = null,
  startupRecoveryDelayMs = STARTUP_RECOVERY_DELAY_MS,
  startupRecoveryMinIntervalMs = STARTUP_RECOVERY_MIN_INTERVAL_MS,
}) => {
  const timers = new Map();
  const inflight = new Set();
  let stopped = false;
  let startupRecoveryTimer = null;
  let startupRecoveryAttempts = 0;
  let lastStartupScanAt = 0;

  const clearTimer = (sessionId) => {
    const existing = timers.get(sessionId);
    if (existing) {
      clearTimeout(existing.timer);
      timers.delete(sessionId);
    }
  };

  const openCodeFetch = async (path, { directory, method = 'GET', body, query } = {}) => {
    const base = buildOpenCodeUrl(path, '');
    const params = new URLSearchParams(query || {});
    if (directory) params.set('directory', directory);
    const search = params.toString();
    const url = search ? `${base}?${search}` : base;
    const response = await fetch(url, {
      method,
      headers: {
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...getOpenCodeAuthHeaders(),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`OpenCode ${method} ${path} failed with ${response.status}`);
    }
    return response.json().catch(() => null);
  };

  const fetchRecentMessages = async (sessionId, directory) => {
    const base = buildOpenCodeUrl(`/session/${encodeURIComponent(sessionId)}/message`, '');
    const params = new URLSearchParams({ limit: String(TRANSCRIPT_MESSAGE_LIMIT) });
    if (directory) params.set('directory', directory);
    const response = await fetch(`${base}?${params.toString()}`, {
      method: 'GET',
      headers: { Accept: 'application/json', ...getOpenCodeAuthHeaders() },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const messages = await response.json().catch(() => null);
    return Array.isArray(messages) ? messages : null;
  };

  const fetchSessionStatuses = async (directory) => {
    const base = buildOpenCodeUrl('/session/status', '');
    const url = directory ? `${base}?directory=${encodeURIComponent(directory)}` : base;
    const response = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json', ...getOpenCodeAuthHeaders() },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const statuses = await response.json().catch(() => null);
    return statuses && typeof statuses === 'object' && !Array.isArray(statuses) ? statuses : null;
  };

  const isWorkingStatus = (status) => status?.type === 'busy' || status?.type === 'retry';

  const generateAssist = async (sessionId, directory) => {
    const targets = getSessionAssistTargets();
    if (!targets.recap && !targets.suggestion) return;
    const session = await openCodeFetch(`/session/${encodeURIComponent(sessionId)}`, { directory })
      .catch((error) => {
        console.warn(`[session-assist] session fetch failed: ${error?.message || error}`);
        return null;
      });
    if (!session || typeof session !== 'object') return;
    // Sub-agent/task sessions never surface in chat — skip them.
    if (typeof session.parentID === 'string' && session.parentID) return;

    const messages = await fetchRecentMessages(sessionId, directory);
    if (!messages || messages.length === 0) {
      console.warn('[session-assist] no messages fetched');
      return;
    }

    let lastAssistant = null;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const info = messages[i]?.info;
      if (info?.role === 'assistant') {
        lastAssistant = messages[i];
        break;
      }
    }
    const lastAssistantInfo = lastAssistant?.info;
    if (!lastAssistantInfo?.id) return;

    // Failed-turn recovery: the last turn finished with no output at all or
    // never finished (serve died mid-stream). A recap of that would be
    // nonsense — retry first, then write an honest recap explaining the
    // failure.
    if (isFailedAssistantTurn(lastAssistant)) {
      await handleFailedTurn({ sessionId, directory, session, messages, lastAssistant, targets });
      return;
    }

    // Only the last exchange: the assistant reply plus the user message it
    // answered (assistant info.parentID → user info.id). Everything else is
    // token waste for a one-line recap and a single suggestion.
    const parentUserMessage = typeof lastAssistantInfo.parentID === 'string' && lastAssistantInfo.parentID
      ? messages.find((message) => message?.info?.id === lastAssistantInfo.parentID && message?.info?.role === 'user')
      : null;
    const userText = parentUserMessage ? messagePartsToText(parentUserMessage) : '';
    const assistantText = messagePartsToText(lastAssistant);
    const transcript = [
      userText ? `User:\n${userText}` : '',
      assistantText ? `Assistant:\n${assistantText}` : '',
    ].filter(Boolean).join('\n\n');
    if (!transcript) return;

    const { generateSmallModelText } = await getSmallModelService();
    const requestedFields = [targets.recap ? 'recap' : '', targets.suggestion ? 'suggestion' : '']
      .filter(Boolean)
      .join(' and ');
    // Instruct the language by example, not by description — account-side
    // personalization (e.g. the ChatGPT backend knowing the user's locale)
    // otherwise leaks a different language into the output.
    const languageSample = (userText || assistantText).slice(0, 200).replace(/\s+/g, ' ').trim();
    let generated;
    try {
      generated = await generateSmallModelText({
        // Background feature: conversation content must never leave the
        // session's own provider unless the user explicitly picked a small
        // model (settings override / opencode config).
        restrictToPreferredProvider: true,
        prompt: `The latest exchange in the conversation:\n\n${transcript}\n\nWrite ${requestedFields} in the SAME language as this sample from the conversation: "${languageSample}"`,
        system: buildAssistSystemPrompt(targets),
        directory,
        preferredProviderID: typeof lastAssistantInfo.providerID === 'string' ? lastAssistantInfo.providerID : undefined,
        preferredModelID: typeof lastAssistantInfo.modelID === 'string' ? lastAssistantInfo.modelID : undefined,
      });
    } catch (error) {
      // No authenticated provider (404) or a transient model failure — this is
      // background sugar, never retry loops or logs spam.
      if (Number(error?.statusCode) !== 404) {
        console.warn('[session-assist] generation failed:', error?.message || error);
      }
      return;
    }

    const structured = extractJsonObject(generated?.text);
    let recap = targets.recap && typeof structured?.recap === 'string' ? structured.recap.trim().slice(0, RECAP_CHAR_LIMIT) : '';
    let suggestion = targets.suggestion && typeof structured?.suggestion === 'string' ? structured.suggestion.trim().slice(0, SUGGESTION_CHAR_LIMIT) : '';

    // Hard guard against language hallucination: if the conversation contains
    // no Cyrillic/CJK at all, the output must not either (and drop per-field,
    // so one hallucinated field doesn't kill the other).
    const hasCyrillic = (text) => /[\u0400-\u04FF]/.test(text);
    const hasCjk = (text) => /[\u3040-\u30FF\u4E00-\u9FFF\uAC00-\uD7AF]/.test(text);
    const inputText = `${userText}\n${assistantText}`;
    const scriptMismatch = (text) => (hasCyrillic(text) && !hasCyrillic(inputText))
      || (hasCjk(text) && !hasCjk(inputText));
    if (recap && scriptMismatch(recap)) {
      console.warn('[session-assist] dropped recap: language mismatch with conversation');
      recap = '';
    }
    if (suggestion && scriptMismatch(suggestion)) {
      console.warn('[session-assist] dropped suggestion: language mismatch with conversation');
      suggestion = '';
    }
    if (!recap && !suggestion) return;

    console.log(`[session-assist] generated for ${sessionId} via ${generated.providerID}/${generated.modelID}`);
    await writeAssistPayload({ sessionId, directory, session, forMessageID: lastAssistantInfo.id, recap, suggestion });
  };

  // Shared write tail of both recap paths: re-check the session tail (the
  // user may have moved on while we generated), then merge the payload into
  // the metadata from a FRESH read so concurrent metadata writes (suggestion
  // dismissals, review links, retry bookkeeping, …) survive.
  const writeAssistPayload = async ({ sessionId, directory, session, forMessageID, recap, suggestion }) => {
    const latest = await fetchRecentMessages(sessionId, directory);
    if (findLatestAssistantId(latest) !== forMessageID) {
      console.log('[session-assist] tail moved on, dropping result');
      return;
    }

    const freshSession = await openCodeFetch(`/session/${encodeURIComponent(sessionId)}`, { directory })
      .catch(() => null);
    const currentMetadata = freshSession?.metadata && typeof freshSession.metadata === 'object'
      ? freshSession.metadata
      : (session.metadata && typeof session.metadata === 'object' ? session.metadata : {});
    const currentNamespace = currentMetadata.openchamber && typeof currentMetadata.openchamber === 'object'
      ? currentMetadata.openchamber
      : {};

    await openCodeFetch(`/session/${encodeURIComponent(sessionId)}`, {
      directory,
      method: 'PATCH',
      body: {
        metadata: {
          ...currentMetadata,
          openchamber: {
            ...currentNamespace,
            assist: {
              recap,
              suggestion,
              forMessageID,
              generatedAt: Date.now(),
            },
          },
        },
      },
    });
  };

  // Persist the empty-completion retry counter, merging from a fresh read so
  // concurrent metadata writes survive.
  const writeAssistRetry = async ({ sessionId, directory, count, lastMessageID }) => {
    const freshSession = await openCodeFetch(`/session/${encodeURIComponent(sessionId)}`, { directory })
      .catch(() => null);
    const currentMetadata = freshSession?.metadata && typeof freshSession.metadata === 'object'
      ? freshSession.metadata
      : {};
    const currentNamespace = currentMetadata.openchamber && typeof currentMetadata.openchamber === 'object'
      ? currentMetadata.openchamber
      : {};
    await openCodeFetch(`/session/${encodeURIComponent(sessionId)}`, {
      directory,
      method: 'PATCH',
      body: {
        metadata: {
          ...currentMetadata,
          openchamber: {
            ...currentNamespace,
            assistRetry: { count, lastMessageID, lastAttemptAt: Date.now() },
          },
        },
      },
    });
  };

  // Honest recap for a failed turn: say the reply failed, never invent
  // content. Small-model generation first (keeps the conversation language),
  // then a fixed English fallback so the failure is never silent.
  const writeHonestFailedTurnRecap = async ({ sessionId, directory, session, messages, lastAssistant }) => {
    const lastAssistantInfo = lastAssistant?.info;
    const messageId = lastAssistantInfo.id;
    const parentUserMessage = typeof lastAssistantInfo.parentID === 'string' && lastAssistantInfo.parentID
      ? messages.find((message) => message?.info?.id === lastAssistantInfo.parentID && message?.info?.role === 'user')
      : null;
    const userText = parentUserMessage ? messagePartsToText(parentUserMessage) : '';
    const languageSample = userText.slice(0, 200).replace(/\s+/g, ' ').trim();

    let recap = FAILED_TURN_FALLBACK_RECAP;
    let suggestion = FAILED_TURN_FALLBACK_SUGGESTION;
    try {
      const { generateSmallModelText } = await getSmallModelService();
      const generated = await generateSmallModelText({
        // Background feature: conversation content must never leave the
        // session's own provider unless the user explicitly picked a small
        // model (settings override / opencode config).
        restrictToPreferredProvider: true,
        prompt: `The agent's last reply in this conversation came back EMPTY (no text, no tool calls).\n\nWrite the recap and suggestion in the SAME language as this sample from the conversation: "${languageSample || 'no text available'}"`,
        system: buildFailedTurnSystemPrompt(),
        directory,
        preferredProviderID: typeof lastAssistantInfo.providerID === 'string' ? lastAssistantInfo.providerID : undefined,
        preferredModelID: typeof lastAssistantInfo.modelID === 'string' ? lastAssistantInfo.modelID : undefined,
      });
      const structured = extractJsonObject(generated?.text);
      if (structured && typeof structured?.recap === 'string' && structured.recap.trim()) {
        recap = structured.recap.trim().slice(0, RECAP_CHAR_LIMIT);
      }
      if (structured && typeof structured?.suggestion === 'string' && structured.suggestion.trim()) {
        suggestion = structured.suggestion.trim().slice(0, SUGGESTION_CHAR_LIMIT);
      }
      // Same language guard as the normal path: a hallucinated script must not
      // leak into a conversation that never used it.
      const hasCyrillic = (text) => /[\u0400-\u04FF]/.test(text);
      const hasCjk = (text) => /[\u3040-\u30FF\u4E00-\u9FFF\uAC00-\uD7AF]/.test(text);
      const scriptMismatch = (text) => (hasCyrillic(text) && !hasCyrillic(userText))
        || (hasCjk(text) && !hasCjk(userText));
      if (recap !== FAILED_TURN_FALLBACK_RECAP && scriptMismatch(recap)) {
        console.warn('[session-assist] dropped failed-turn recap: language mismatch');
        recap = FAILED_TURN_FALLBACK_RECAP;
      }
      if (suggestion !== FAILED_TURN_FALLBACK_SUGGESTION && scriptMismatch(suggestion)) {
        console.warn('[session-assist] dropped failed-turn suggestion: language mismatch');
        suggestion = FAILED_TURN_FALLBACK_SUGGESTION;
      }
    } catch (error) {
      // No authenticated small model (404) or a transient failure — the
      // fixed-language fallback still surfaces the failure.
      if (Number(error?.statusCode) !== 404) {
        console.warn('[session-assist] failed-turn recap generation failed:', error?.message || error);
      }
    }

    console.log(`[session-assist] failed turn on ${sessionId}, writing honest recap`);
    await writeAssistPayload({ sessionId, directory, session, forMessageID: messageId, recap, suggestion });
  };

  // A broken turn (empty stream, or interrupted by a serve restart): retry the
  // session with a continuation prompt up to maxEmptyRetries (tracked per
  // last message id), then write an honest recap that tells the user the
  // reply failed.
  const handleFailedTurn = async ({ sessionId, directory, session, messages, lastAssistant, targets, isWorking = null }) => {
    const lastAssistantInfo = lastAssistant?.info;
    const messageId = lastAssistantInfo.id;
    const retry = parseAssistRetry(session);
    const scopedRetry = retry.lastMessageID === messageId
      ? retry
      : { count: 0, lastMessageID: messageId, lastAttemptAt: 0 };

    const providerID = typeof lastAssistantInfo.providerID === 'string' ? lastAssistantInfo.providerID : '';
    const modelID = typeof lastAssistantInfo.modelID === 'string' ? lastAssistantInfo.modelID : '';
    const canRetry = targets.autoRetry && scopedRetry.count < maxEmptyRetries && providerID && modelID;
    if (!canRetry) {
      await writeHonestFailedTurnRecap({ sessionId, directory, session, messages, lastAssistant });
      return;
    }

    // Write-first bookkeeping: if the prompt below fails, the recorded count
    // keeps the next idle tick from retrying forever.
    await writeAssistRetry({ sessionId, directory, count: scopedRetry.count + 1, lastMessageID: messageId });
    console.log(`[session-assist] failed turn on ${sessionId}, retrying (${scopedRetry.count + 1}/${maxEmptyRetries})`);

    // Providers usually reset usage windows within a couple of minutes —
    // wait before re-prompting instead of hammering the same limit.
    await new Promise((resolve) => setTimeout(resolve, retryQuietMs));
    if (stopped) return;

    // The tail must not have moved during the wait (the user sent a message).
    const latest = await fetchRecentMessages(sessionId, directory);
    if (findLatestAssistantId(latest) !== messageId) {
      console.log('[session-assist] tail moved on, dropping failed-turn retry');
      return;
    }

    // The session must still be idle: a turn that merely LOOKS unfinished
    // because it is genuinely running right now (race with a user message)
    // must never get a duplicate prompt. isWorking is three-valued: true =
    // busy (drop), false = idle already confirmed by the caller (startup
    // scan), null = unknown — fetch the live status, and if it cannot be
    // confirmed (fetch failed), drop the retry: never re-prompt without
    // proof that the session is idle.
    let statusConfirmed = false;
    let isBusy = false;
    if (isWorking === true) {
      statusConfirmed = true;
      isBusy = true;
    } else if (isWorking === false) {
      statusConfirmed = true;
    } else {
      const statuses = await fetchSessionStatuses(directory);
      statusConfirmed = Boolean(statuses);
      isBusy = statusConfirmed && isWorkingStatus(statuses[sessionId]);
    }
    if (!statusConfirmed || isBusy) {
      console.log(`[session-assist] ${isBusy ? 'session is busy' : 'status unavailable'}, dropping failed-turn retry`);
      return;
    }

    const agent = typeof lastAssistantInfo.agent === 'string' && lastAssistantInfo.agent
      ? lastAssistantInfo.agent
      : (typeof lastAssistantInfo.mode === 'string' ? lastAssistantInfo.mode : '');
    const variant = typeof lastAssistantInfo.variant === 'string' ? lastAssistantInfo.variant : '';
    await openCodeFetch(`/session/${encodeURIComponent(sessionId)}/prompt_async`, {
      directory,
      method: 'POST',
      body: {
        model: { providerID, modelID },
        ...(agent ? { agent } : {}),
        ...(variant ? { variant } : {}),
        parts: [{ type: 'text', text: buildFailedTurnContinuationPrompt() }],
      },
    });
  };

  // One bounded startup pass over the warm directories: after a serve (or
  // server) restart, OpenCode re-emits no status for sessions whose turn was
  // interrupted by the previous process dying — they would stay silently
  // stranded on an unfinished turn forever. Recover them with the same
  // failed-turn path. Best-effort: fetch failures are logged and retried a
  // few times, then abandoned.
  //
  // Called from three places: the startup timer, the lifecycle
  // onOpenCodeReady hook (every serve restart), and the internal retry loop
  // (fromRetry bypasses the debounce so a single scan cycle can retry while
  // upstream is not ready).
  const runStartupRecovery = async ({ fromRetry = false } = {}) => {
    if (stopped || typeof getStartupDirectories !== 'function') return;
    const nowMs = Date.now();
    if (!fromRetry) {
      // Serve restarts can fire rapidly — a bounded rate keeps repeated
      // triggers from stacking scans on top of each other.
      if (lastStartupScanAt && nowMs - lastStartupScanAt < startupRecoveryMinIntervalMs) return;
      startupRecoveryAttempts = 0;
      lastStartupScanAt = nowMs;
    }
    let directories = [];
    try {
      directories = await getStartupDirectories();
    } catch (error) {
      console.warn('[session-assist] startup recovery: directory list failed:', error?.message || error);
      return;
    }
    if (!Array.isArray(directories)) return;
    const targets = getSessionAssistTargets();
    let anyDirectoryFailed = false;

    for (const directory of directories.slice(0, STARTUP_DIRECTORY_LIMIT)) {
      if (!directory || stopped) return;
      if (inflight.has(`startup:${directory}`)) continue;
      inflight.add(`startup:${directory}`);
      try {
        const statuses = await fetchSessionStatuses(directory);
        const sessionList = await openCodeFetch('/session', { directory, query: { limit: String(STARTUP_SESSION_LIMIT) } })
          .catch(() => null);
        if (!statuses || !Array.isArray(sessionList)) {
          anyDirectoryFailed = true;
          continue;
        }
        for (const session of sessionList) {
          if (stopped) return;
          if (typeof session?.id !== 'string' || !session.id) continue;
          if (typeof session.parentID === 'string' && session.parentID) continue;
          if (isWorkingStatus(statuses[session.id])) continue;
          const updated = Number.isFinite(session?.time?.updated) ? session.time.updated : 0;
          if (nowMs - updated > STARTUP_SESSION_AGE_LIMIT_MS) continue;

          const messages = await fetchRecentMessages(session.id, directory);
          let lastAssistant = null;
          if (messages) {
            for (let i = messages.length - 1; i >= 0; i -= 1) {
              if (messages[i]?.info?.role === 'assistant') {
                lastAssistant = messages[i];
                break;
              }
            }
          }
          if (!lastAssistant || !isFailedAssistantTurn(lastAssistant)) continue;

          console.log(`[session-assist] startup recovery: failed turn on ${session.id}`);
          await handleFailedTurn({
            sessionId: session.id,
            directory,
            session,
            messages,
            lastAssistant,
            targets,
            isWorking: isWorkingStatus(statuses[session.id]),
          });
        }
      } catch (error) {
        anyDirectoryFailed = true;
        console.warn(`[session-assist] startup recovery failed for ${directory}:`, error?.message || error);
      } finally {
        inflight.delete(`startup:${directory}`);
      }
    }

    // Upstream may not be ready yet on first attempts — retry the whole pass
    // a bounded number of times.
    if (anyDirectoryFailed && !stopped && startupRecoveryAttempts < STARTUP_RECOVERY_MAX_ATTEMPTS) {
      startupRecoveryAttempts += 1;
      startupRecoveryTimer = setTimeout(() => runStartupRecovery({ fromRetry: true }), startupRecoveryDelayMs);
      if (typeof startupRecoveryTimer?.unref === 'function') startupRecoveryTimer.unref();
    }
  };

  const armTimer = (sessionId, directory) => {
    clearTimer(sessionId);
    const timer = setTimeout(() => {
      timers.delete(sessionId);
      if (stopped || inflight.has(sessionId)) return;
      inflight.add(sessionId);
      generateAssist(sessionId, directory)
        .catch((error) => {
          console.warn('[session-assist] failed:', error?.message || error);
        })
        .finally(() => {
          inflight.delete(sessionId);
        });
    }, quietMs);
    if (typeof timer?.unref === 'function') timer.unref();
    timers.set(sessionId, { timer, armedAt: Date.now() });
  };

  const processPayload = (payload, directoryHint = '') => {
    if (stopped) return;
    const status = extractSessionStatus(payload);
    if (status) {
      if (status.type === 'idle') {
        armTimer(status.sessionId, status.directory || directoryHint);
      } else {
        clearTimer(status.sessionId);
      }
      return;
    }
    const userMessage = extractUserMessage(payload);
    if (userMessage) {
      // OpenCode re-emits message.updated for OLD user messages after the
      // session settles (post-completion metadata patches). Only a message
      // created after the timer was armed means the user actually moved on.
      const armed = timers.get(userMessage.sessionId);
      if (armed && userMessage.createdAt >= armed.armedAt) {
        clearTimer(userMessage.sessionId);
      }
    }
  };

  const stop = () => {
    stopped = true;
    if (startupRecoveryTimer) {
      clearTimeout(startupRecoveryTimer);
      startupRecoveryTimer = null;
    }
    for (const { timer } of timers.values()) {
      clearTimeout(timer);
    }
    timers.clear();
  };

  // One startup recovery pass (see runStartupRecovery) when the server has
  // warm directories to scan — compensates for serve restarts losing events.
  if (typeof getStartupDirectories === 'function') {
    startupRecoveryTimer = setTimeout(runStartupRecovery, startupRecoveryDelayMs);
    if (typeof startupRecoveryTimer?.unref === 'function') startupRecoveryTimer.unref();
  }

  return { processPayload, stop, runStartupRecovery };
};
