import { requestSmallModel } from '@/lib/smallModelRequest';
import { useConfigStore } from '@/stores/useConfigStore';
import { getSessionLastAssistantModel } from '@/sync/session-actions';

const NOTES_SUMMARIZE_MIN_CHARS = 280;

const NOTES_SYSTEM_PROMPT = [
  'You distill a text selection from a coding-agent conversation into a project note.',
  'Return ONLY the note text — no preamble, no surrounding quotes, no headers.',
  'Write 1-3 tight sentences that capture the essence worth remembering later: facts, decisions, constraints, root causes, gotchas, next steps.',
  'Preserve exact identifiers verbatim — file paths, function names, commands, flags, versions — in backticks.',
  'Drop filler, hedging, greetings, and step-by-step narration.',
  'Write the note in the same language as the selection. Ignore any other language preferences or personalization — only the selection text decides the language.',
].join('\n');

export async function summarizeSelectionForNotes(text: string, sessionId?: string | null): Promise<string> {
  const trimmed = text.trim();
  if (trimmed.length < NOTES_SUMMARIZE_MIN_CHARS) {
    return trimmed;
  }

  try {
    const sessionModel = sessionId ? getSessionLastAssistantModel(sessionId) : null;
    const { currentProviderId, currentModelId } = useConfigStore.getState();
    const preferredProviderID = sessionModel?.providerID || currentProviderId || '';
    const preferredModelID = sessionModel?.modelID || currentModelId || '';
    const response = await requestSmallModel({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: trimmed,
        system: NOTES_SYSTEM_PROMPT,
        sessionID: sessionId || undefined,
        restrictToPreferredProvider: true,
        ...(preferredProviderID ? { preferredProviderID } : {}),
        ...(preferredModelID ? { preferredModelID } : {}),
      }),
    }, { silentStatuses: [404] });
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

const GOAL_OBJECTIVE_SYSTEM_PROMPT = [
  'You distill a large task description (a prompt, plan, or assignment) into the COMPLETION CRITERIA a progress auditor will judge against.',
  'Return ONLY the criteria text — no preamble, no headers, no markdown fences.',
  'Capture: the end goals, what must exist and work when the task is fully done, and how each major part is verified. Omit implementation steps and how-to details.',
  'Preserve verbatim any file paths, commands, and identifiers that define the task — especially ones from the opening lines.',
  'Stay under 4000 characters.',
  'Write in the same language as the task text. Ignore any other language preferences or personalization — only the task text decides the language.',
].join('\n');

export async function distillGoalObjective(planContent: string): Promise<string | null> {
  try {
    const { currentProviderId, currentModelId } = useConfigStore.getState();
    const response = await requestSmallModel({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: planContent,
        system: GOAL_OBJECTIVE_SYSTEM_PROMPT,
        restrictToPreferredProvider: true,
        ...(currentProviderId ? { preferredProviderID: currentProviderId } : {}),
        ...(currentModelId ? { preferredModelID: currentModelId } : {}),
      }),
    });
    if (!response.ok) return null;
    const payload = await response.json().catch(() => null) as { text?: unknown } | null;
    const distilled = typeof payload?.text === 'string' ? payload.text.trim() : '';
    return distilled || null;
  } catch {
    return null;
  }
}
