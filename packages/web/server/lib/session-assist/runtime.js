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
const TRANSCRIPT_PART_CHAR_LIMIT = 6_000;
// Over the budget the transcript is trimmed from the OLDEST end, and only ever
// on a TRANSCRIPT_DROP_CHUNK boundary: the prompt is sent to the session's own
// model, so consecutive assists on one session share a token prefix and hit the
// backend's prefix cache. Dropping one message per turn would shift the start of
// the transcript every time and defeat that.
const TRANSCRIPT_DROP_CHUNK = 16;
// Room left for everything the prompt wraps around the transcript: the header,
// the pointer to the last message, the requested fields and the language sample.
// Generous on purpose — the budget it is subtracted from is itself an estimate.
const PROMPT_SCAFFOLD_RESERVE_CHARS = 2_000;
const RECAP_CHAR_LIMIT = 320;
const SUGGESTION_CHAR_LIMIT = 500;
const FETCH_TIMEOUT_MS = 5_000;
// The transcript is the whole session, so the message list can be large.
const HISTORY_FETCH_TIMEOUT_MS = 20_000;
const ASSIST_TIMEOUT_MS = 120_000;
const STALENESS_TAIL_LIMIT = 4;
// Expected outcomes of a whole-session transcript, not failures: a session
// longer than its own model's context, and a reasoning model that spends the
// output budget thinking. Both mean "no suggestion this cycle".
const QUIET_GENERATION_CODES = new Set(['context-too-small', 'output-exhausted']);

const buildAssistSystemPrompt = ({ recap, suggestion }) => [
  'You assist a user who chats with a coding agent. Based on the conversation transcript, return exactly one JSON object and nothing else — no prose, no markdown, no code fences.',
  `Shape: {${[recap ? '"recap": string' : '', suggestion ? '"suggestion": string' : ''].filter(Boolean).join(', ')}}`,
  recap
    ? 'recap: at most 20 words. State the substance directly — the facts, result, or conclusion, plus the next move if there is one. NEVER narrate ("The assistant explained…", "The agent did…") — write the content itself, like a note the user jotted down.'
    : '',
  // Written in the USER's voice because the client pastes this exact string
  // into the composer for the user to send. A suggestion phrased as the agent
  // ("I would do X") reads as nonsense once it lands there.
  suggestion ? 'suggestion: write ONE short message the user could send to the coding agent as-is, asking for the next step.' : '',
  suggestion ? 'You are given the WHOLE conversation, not just the end. Judge the next step against what the user actually asked for at the start, not only against your latest reply.' : '',
  suggestion ? 'Rules for suggestion:' : '',
  suggestion ? '- Return an EMPTY STRING when there is no honest next step: the request the user made is already satisfied, or the conversation is waiting on a decision only the user can make. An empty suggestion is a correct and expected answer, not a failure.' : '',
  suggestion ? '- Never invent follow-up work to fill the field. Finishing a task is a valid end state.' : '',
  suggestion ? '- Work you flagged as unverified, out of scope, or "not tested" in your own reply is NOT automatically the next step. It is only the next step if it is part of what the user asked for.' : '',
  // Describes the grammar instead of quoting an opener. An English template
  // here is copied verbatim: measured against a Spanish conversation, quoting
  // one returned the suggestion in English in 2 of 3 runs.
  suggestion ? '- Address the agent directly, in the imperative, in the language of the conversation. Do not write it as the agent describing its own plan.' : '',
  suggestion ? '- Do not include alternatives, choices, slash-separated options, or "or".' : '',
  suggestion ? '- Do not restate information you already gave in the reply.' : '',
  suggestion ? 'Example 1 — the request is finished:' : '',
  suggestion ? 'The user asked for a bug ticket. You created it and summarized your findings. Your reply also noted that the mobile panel was not verified on screen.' : '',
  suggestion ? 'Correct suggestion: "" (empty). The user asked for a ticket and the ticket exists. The unverified mobile panel is work described IN the ticket, not work the user asked you to do now.' : '',
  // Example 1 taught the "already done" case well (empty in every measured run)
  // and this one exists because the sibling case did not: asked for a sendable
  // imperative, the model produced "merge the PR" in 4 runs out of 4, when
  // merging is exactly the decision it is waiting on.
  suggestion ? 'Example 2 — the work is done and the next move is the user\'s to make:' : '',
  suggestion ? 'You finished the change, opened a pull request, reported it is mergeable, and said you are waiting for review. Nothing is blocked on you.' : '',
  suggestion ? 'Correct suggestion: "" (empty). Merging, deploying, approving, choosing between designs and spending money are the user\'s calls. Telling them to make their own decision is not a next step, it is nagging.' : '',
  suggestion ? 'Example 3 — the request is not finished:' : '',
  suggestion ? 'The user asked you to make the tests pass. Two of them still fail and you have just located the cause.' : '',
  suggestion ? 'A correct suggestion here is one imperative sentence, in the conversation\'s language, naming the specific fix to apply and the check to re-run.' : '',
  // These examples describe the answers rather than quoting them. Quoting an
  // English sentence primes the field: measured against a Spanish session, the
  // recap came back in Spanish and the suggestion in English, 2 runs out of 3.
  suggestion ? 'The examples above are described in English only because these instructions are in English. They say nothing about the language of your answer.' : '',
  'All requested values MUST be written in the same language as the conversation text itself. Ignore any other language preferences or personalization you may have — only the conversation text decides the language.',
  'This applies to every field independently: it is never correct for one field to be in the language of the conversation and another in English.',
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

// Tool NAMES only, never their input or output: a session can be almost all
// tool calls (the text parts stay short), so a transcript without them reads as
// an empty conversation — and tool payloads are exactly where file contents,
// command lines and credentials would leak into a utility prompt.
const messageToolSummary = (message) => {
  const parts = Array.isArray(message?.parts) ? message.parts : [];
  const names = parts
    .filter((part) => part?.type === 'tool' && typeof part.tool === 'string' && part.tool)
    .map((part) => part.tool);
  if (names.length === 0) return '';
  const counts = new Map();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  const rendered = [...counts.entries()].map(([name, n]) => (n > 1 ? `${name}×${n}` : name));
  return `[tools: ${rendered.join(', ')}]`;
};

// Numbered by position in the SESSION, not in the rendered list: a message that
// carries no text and no tools is skipped, and renumbering around it would move
// every later block the moment OpenCode patches that message.
const renderMessage = (message, index) => {
  const role = message?.info?.role === 'user' ? 'User' : 'Assistant';
  const body = [messagePartsToText(message), messageToolSummary(message)].filter(Boolean).join('\n');
  return body ? { number: index, text: `#${index} ${role}:\n${body}` } : null;
};

// Renders the whole conversation, oldest first. Over budget, the oldest
// messages are dropped on a TRANSCRIPT_DROP_CHUNK boundary so the start of the
// transcript only moves in steps and the shared prefix survives between calls.
export const buildTranscript = (messages, charBudget) => {
  const rendered = messages.map((message, index) => renderMessage(message, index + 1)).filter(Boolean);
  let start = 0;
  let total = rendered.reduce((sum, block) => sum + block.text.length + 2, 0);
  while (total > charBudget && start < rendered.length - 1) {
    const next = Math.min(start + TRANSCRIPT_DROP_CHUNK, rendered.length - 1);
    for (let i = start; i < next; i += 1) total -= rendered[i].text.length + 2;
    start = next;
  }
  const kept = rendered.slice(start);
  return {
    text: kept.map((block) => block.text).join('\n\n'),
    droppedOldest: start,
    // The number the last block actually carries, which is what the tail of the
    // prompt points at.
    lastNumber: kept.length > 0 ? kept[kept.length - 1].number : 0,
  };
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

  // `limit` omitted fetches the whole conversation, which is what the transcript
  // needs: the suggestion is judged against what the user asked for at the START
  // of the session, which a tail window cannot see. The staleness re-check
  // before writing only needs the tail, and passes a small limit.
  const fetchSessionMessages = async (sessionId, directory, { limit } = {}) => {
    const base = buildOpenCodeUrl(`/session/${encodeURIComponent(sessionId)}/message`, '');
    const params = new URLSearchParams();
    if (limit) params.set('limit', String(limit));
    if (directory) params.set('directory', directory);
    const query = params.toString();
    const response = await fetch(query ? `${base}?${query}` : base, {
      method: 'GET',
      headers: { Accept: 'application/json', ...getOpenCodeAuthHeaders() },
      signal: AbortSignal.timeout(limit ? FETCH_TIMEOUT_MS : HISTORY_FETCH_TIMEOUT_MS),
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

    const messages = await fetchSessionMessages(sessionId, directory);
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

    const preferredProviderID = typeof lastAssistantInfo.providerID === 'string' ? lastAssistantInfo.providerID : undefined;
    const preferredModelID = typeof lastAssistantInfo.modelID === 'string' ? lastAssistantInfo.modelID : undefined;
    const { generateSmallModelText, describeSmallModel } = await getSmallModelService();

    // Size the transcript against the model that will actually answer. A local
    // proxy model is absent from the catalog and falls back to a conservative
    // context, so a fixed budget would either waste a large window or overflow a
    // small one — and overflow is fatal here (see onOverflow below).
    const described = await describeSmallModel({ directory, preferredProviderID, preferredModelID })
      .catch(() => null);
    const charBudget = Number(described?.inputCharBudget) > 0
      ? described.inputCharBudget - PROMPT_SCAFFOLD_RESERVE_CHARS
      : 0;
    if (charBudget <= 0) return;

    // The whole conversation. Everything that varies per call — the pointer to
    // the last message, the requested fields, the language sample — goes AFTER
    // it, so the history stays an append-only prefix between consecutive
    // assists on the same session.
    const transcript = buildTranscript(messages, charBudget);
    const assistantText = messagePartsToText(lastAssistant);
    const parentUserMessage = typeof lastAssistantInfo.parentID === 'string' && lastAssistantInfo.parentID
      ? messages.find((message) => message?.info?.id === lastAssistantInfo.parentID && message?.info?.role === 'user')
      : null;
    const userText = parentUserMessage ? messagePartsToText(parentUserMessage) : '';
    if (!transcript.text) return;

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
        prompt: [
          transcript.droppedOldest
            ? `The conversation so far (the first ${transcript.droppedOldest} messages are omitted):`
            : 'The whole conversation, from the user\'s first message:',
          '',
          transcript.text,
          '',
          '---',
          `The conversation ends at message #${transcript.lastNumber}, the assistant's latest reply. Everything above it has already happened.`,
          `Write ${requestedFields} in the SAME language as this sample from the conversation: "${languageSample}"`,
        ].join('\n'),
        system: buildAssistSystemPrompt(targets),
        // The transcript is the whole session and the answer is two short
        // fields; the input clamp truncates the TAIL, which here is the
        // instruction, so an oversized prompt must fail instead of asking the
        // model to answer a question it can no longer see.
        onOverflow: 'error',
        // A whole session is a long prefill on the first assist; later ones hit
        // the backend's prefix cache. The 60s default is a cold-start timeout.
        timeoutMs: ASSIST_TIMEOUT_MS,
        directory,
        sessionID: sessionId,
        preferredProviderID,
        preferredModelID,
      });
    } catch (error) {
      // No authenticated provider (404) or a transient model failure — this is
      // background sugar, never retry loops or logs spam.
      if (Number(error?.statusCode) !== 404 && !QUIET_GENERATION_CODES.has(error?.code)) {
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
    const inputText = transcript.text;
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
    const latest = await fetchSessionMessages(sessionId, directory, { limit: STALENESS_TAIL_LIMIT });
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
