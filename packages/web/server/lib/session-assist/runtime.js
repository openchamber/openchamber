// Session assist: after a session goes idle and stays quiet, generate a short
// recap of the agent's last reply plus one suggested user follow-up with the
// small model, and store both on the session's metadata
// (metadata.openchamber.assist). Clients decide visibility from
// assist.forMessageID — a new message makes the payload stale everywhere
// without any extra writes.
//
// Purely event-driven: only sessions that transition busy→idle while the
// server is running ever generate anything. No backfill, no session scans.

import fs from 'fs';
import os from 'os';
import path from 'path';

const OPENCHAMBER_SETTINGS_FILE = path.join(
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
    const raw = fs.readFileSync(OPENCHAMBER_SETTINGS_FILE, 'utf8');
    const settings = JSON.parse(raw);
    return {
      recap: settings?.sessionRecapEnabled !== false,
      suggestion: settings?.sessionSuggestionEnabled !== false,
    };
  } catch {
    return { recap: true, suggestion: true };
  }
};

const IDLE_QUIET_MS = 60_000;
const TRANSCRIPT_MESSAGE_LIMIT = 12;
const TRANSCRIPT_PART_CHAR_LIMIT = 6_000;
const RECAP_CHAR_LIMIT = 320;
const SUGGESTION_CHAR_LIMIT = 500;
const FETCH_TIMEOUT_MS = 5_000;

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

export const createSessionAssistRuntime = ({
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  getSmallModelService,
  quietMs = IDLE_QUIET_MS,
}) => {
  const timers = new Map();
  const inflight = new Set();
  let stopped = false;

  const clearTimer = (sessionId) => {
    const existing = timers.get(sessionId);
    if (existing) {
      clearTimeout(existing.timer);
      timers.delete(sessionId);
    }
  };

  const openCodeFetch = async (path, { directory, method = 'GET', body } = {}) => {
    const base = buildOpenCodeUrl(path, '');
    const url = directory ? `${base}?directory=${encodeURIComponent(directory)}` : base;
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

    // The session may have moved on while we generated — a stale patch would
    // flash outdated content, so re-check the tail before writing.
    const latest = await fetchRecentMessages(sessionId, directory);
    const latestAssistantId = (() => {
      if (!latest) return null;
      for (let i = latest.length - 1; i >= 0; i -= 1) {
        const info = latest[i]?.info;
        if (info?.role === 'assistant') return info.id;
        if (info?.role === 'user') return null;
      }
      return null;
    })();
    if (latestAssistantId !== lastAssistantInfo.id) {
      console.log('[session-assist] tail moved on, dropping result');
      return;
    }

    // Merge from a FRESH read: generation takes tens of seconds, and merging
    // from the session snapshot fetched before it would clobber any metadata
    // written meanwhile (suggestion dismissals, review links, …).
    const freshSession = await openCodeFetch(`/session/${encodeURIComponent(sessionId)}`, { directory })
      .catch(() => null);
    const currentMetadata = freshSession?.metadata && typeof freshSession.metadata === 'object'
      ? freshSession.metadata
      : (session.metadata && typeof session.metadata === 'object' ? session.metadata : {});
    const currentNamespace = currentMetadata.openchamber && typeof currentMetadata.openchamber === 'object'
      ? currentMetadata.openchamber
      : {};

    console.log(`[session-assist] generated for ${sessionId} via ${generated.providerID}/${generated.modelID}`);
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
              forMessageID: lastAssistantInfo.id,
              generatedAt: Date.now(),
            },
          },
        },
      },
    });
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
    for (const { timer } of timers.values()) {
      clearTimeout(timer);
    }
    timers.clear();
  };

  return { processPayload, stop };
};
