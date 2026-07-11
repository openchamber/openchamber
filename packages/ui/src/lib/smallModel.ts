import { runtimeFetch } from '@/lib/runtime-fetch';
import { useConfigStore } from '@/stores/useConfigStore';
import { getSessionLastAssistantModel } from '@/sync/session-actions';

// Selections shorter than this are already note-sized — summarizing them
// would only add latency and risk losing the exact wording.
const NOTES_SUMMARIZE_MIN_CHARS = 280;

const NOTES_SYSTEM_PROMPT = [
  'You distill a text selection from a coding-agent conversation into a project note.',
  'Return ONLY the note text — no preamble, no surrounding quotes, no headers.',
  'Write 1-3 tight sentences that capture the essence worth remembering later: facts, decisions, constraints, root causes, gotchas, next steps.',
  'Preserve exact identifiers verbatim — file paths, function names, commands, flags, versions — in backticks.',
  'Drop filler, hedging, greetings, and step-by-step narration.',
  'Write the note in the same language as the selection. Ignore any other language preferences or personalization — only the selection text decides the language.',
].join('\n');

/**
 * Distills a chat selection into a compact note via the small model. Falls
 * back to the original text on any failure or when no small model is
 * available within the session's provider (explicit settings/config picks
 * are still honored server-side).
 */
export async function summarizeSelectionForNotes(text: string, sessionId?: string | null): Promise<string> {
  const trimmed = text.trim();
  if (trimmed.length < NOTES_SUMMARIZE_MIN_CHARS) {
    return trimmed;
  }

  try {
    // The selection's session provider is authoritative — the text came from
    // that conversation. The composer picker only serves as a fallback.
    const sessionModel = sessionId ? getSessionLastAssistantModel(sessionId) : null;
    const { currentProviderId, currentModelId } = useConfigStore.getState();
    const preferredProviderID = sessionModel?.providerID || currentProviderId || '';
    const preferredModelID = sessionModel?.modelID || currentModelId || '';
    const response = await runtimeFetch('/api/small-model/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: trimmed,
        system: NOTES_SYSTEM_PROMPT,
        restrictToPreferredProvider: true,
        ...(preferredProviderID ? { preferredProviderID } : {}),
        ...(preferredModelID ? { preferredModelID } : {}),
      }),
    });
    if (!response.ok) {
      return trimmed;
    }
    const payload = await response.json().catch(() => null) as { text?: unknown } | null;
    const summary = typeof payload?.text === 'string' ? payload.text.trim() : '';
    return summary || trimmed;
  } catch {
    return trimmed;
  }
}
