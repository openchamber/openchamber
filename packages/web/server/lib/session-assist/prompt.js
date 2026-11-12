import { excerpt } from './context.js';

const MAX_PROMPT_CHARS = 32_000;

export function buildAssistSystemPrompt({ recap, suggestion }) {
  return [
    `Return exactly one JSON object with string fields: ${[recap ? '"recap"' : '', suggestion ? '"suggestion"' : ''].filter(Boolean).join(', ')}.`,
    recap ? 'recap is a reminder of the actual work accomplished or conclusion reached in the recent conversation. In at most 20 words, name the concrete behavior or subject and its current result. The reader wants to remember WHAT changed or was learned.' : '',
    recap ? 'Write the recap for the person using the app, not for someone reviewing its code. Name the feature and the concrete difference the user will notice. Replace generic "implemented and tested" summaries with what now works differently or what was learned. File paths, internal module names, test counts, and lists of checks belong in the recap only when they are the subject of the user\'s request. Preserve a specific finding or limitation when it changes the meaning of the result.' : '',
    recap ? 'For a closing exchange such as a commit, push, acknowledgment, or thank-you, summarize the substantive work from the preceding answers. Commit bookkeeping, authorship, branch names, and hashes are secondary and usually omitted. A recap saying only that optimizations or changes were committed does not serve this purpose.' : '',
    recap ? 'Use the latest state of that work. Distinguish recommendations from actions already performed, and implementations from verified deployments. Retain the reported conclusion without recalculating detailed lists. Earlier unrelated topics are not part of the recap.' : '',
    suggestion ? 'suggestion is optional. Return "" when the current request is satisfied or continuing requires a user decision. Otherwise return one concise message the user could send to continue specific unfinished work they requested.' : '',
    suggestion ? 'suggestion: return an empty string if the latest request has been satisfied, the next move requires the user\'s decision, or the context does not establish unfinished requested work. Finishing is a normal outcome.' : '',
    suggestion ? 'Otherwise write one concise, specific next message the user can send unchanged to continue the unfinished request. Use the user\'s voice addressing the agent.' : '',
    suggestion ? 'A request to analyze, explain, or recommend is satisfied by that analysis, explanation, or recommendation unless the user also asked for execution. An optional offer, an implementation plan, a caveat about untested platforms, or uncommitted work is not permission for a new task. Do not revive old requests after the user changes topic.' : '',
    'Language: all requested fields follow the latest user-authored communication, including the user\'s comments on quotes. Ignore the language of the quoted material, code, logs, assistant responses, and these instructions. For a language-neutral acknowledgment use recent user-authored communication. Keep technical names unchanged where useful.',
    recap && suggestion ? 'Keep recap and suggestion independent: recap may carry earlier substantive work forward, while suggestion must be justified by the current request, not by that earlier work.' : '',
    suggestion ? 'Only suggest work the coding agent can perform in the session. If the next action belongs to the user, such as checking their phone, choosing a design, or approving a change, return "". A suggestion is a message sent TO the agent, never a reminder addressed to the user.' : '',
  ].filter(Boolean).join('\n');
}

function renderTurn(turn, index, userText = turn.user.text, answerText = turn.assistant?.text ?? '') {
  return [
    `Turn ${index + 1}${turn.complete ? '' : ' (interrupted before a final response)'}`,
    'User message with attached context:', userText,
    turn.complete ? 'Assistant final response:' : 'Assistant progress before interruption:', answerText,
  ].join('\n');
}

export function buildAssistPrompt(turns, targets, charBudget) {
  const budget = Math.min(MAX_PROMPT_CHARS, Math.floor(charBudget));
  if (!Number.isFinite(budget) || budget < 1_000 || !turns.length) return null;
  const languageBudget = Math.min(3_600, Math.floor(budget / 5));
  const language = excerpt(turns.map((turn) => excerpt(turn.user.authored, 1_200)).filter(Boolean).join('\n'), languageBudget);
  const header = 'Recent conversation turns, oldest first. Older turns may be omitted.\n\n';
  const requested = [targets.recap ? 'a reminder of the recent substantive work in recap' : '', targets.suggestion ? 'an optional current next step in suggestion' : ''].filter(Boolean).join(', and ');
  const footer = `\n\n--- End of conversation evidence ---\n\nRecent user-authored communication, excluding attached quotes, oldest first:\n\n${language}\n\nReturn ${requested}.`;
  const available = budget - header.length - footer.length;
  const kept = turns.slice();
  let body = kept.map((turn, i) => renderTurn(turn, i)).join('\n\n---\n\n');
  while (body.length > available && kept.length > 1) {
    kept.shift();
    body = kept.map((turn, i) => renderTurn(turn, i)).join('\n\n---\n\n');
  }
  if (body.length > available) {
    const turn = kept[0];
    const textBudget = available - renderTurn(turn, 0, '', '').length;
    if (textBudget < 128) return null;
    const answer = turn.assistant?.text ?? '';
    const userBudget = Math.min(turn.user.text.length, Math.max(Math.floor(textBudget / 3), textBudget - answer.length));
    body = renderTurn(turn, 0, excerpt(turn.user.text, userBudget), excerpt(answer, textBudget - userBudget));
  }
  return { text: header + body + footer, language };
}
