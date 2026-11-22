/**
 * Worktree names generated from a session's first prompt.
 *
 * Shared by the composer's auto-create switch (`POST
 * /api/git/worktrees/generate-name`) and the agent tool's `session.create`, so
 * a worktree named by a person's prompt and one named by an agent's dispatch
 * come out of the same model call and the same cleanup.
 *
 * The model is the one the caller is about to run the session on (or one it
 * names explicitly). Naming is a convenience: every failure resolves to `''`
 * and the caller falls back to the random adjective-noun name, never to an
 * error that blocks the session.
 */

import { asNonEmptyString, isRecord } from '../shared/guards.js';

const WORKTREE_NAME_SYSTEM_PROMPT = [
  'You name git worktrees.',
  'Reply with ONLY a short kebab-case name (2 to 5 lowercase words joined by hyphens) that describes the task in the request.',
  'No quotes, no punctuation other than hyphens, no explanation, no prefix such as "feature/".',
  'Examples: fix-login-redirect, add-csv-export, refactor-session-store.',
].join(' ');

const MAX_NAME_LENGTH = 48;
const MAX_PROMPT_CHARS = 4000;

/** Reduces whatever the model said to one safe worktree slug, or ''. */
export const sanitizeGeneratedWorktreeName = (text) => {
  const value = asNonEmptyString(text);
  if (!value) return '';
  // Models wrap answers in quotes, code fences or a leading "Name:"; take the
  // first non-empty line and strip that dressing before slugging.
  const firstLine = value
    .replace(/```[a-z]*\n?/gi, '')
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? '';
  const withoutLabel = firstLine.replace(/^(worktree\s*)?name\s*:\s*/i, '');
  const slug = withoutLabel
    .toLowerCase()
    .replace(/^refs\/heads\//, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  if (!slug) return '';
  if (slug.length <= MAX_NAME_LENGTH) return slug;
  // Cut on a word boundary rather than mid-word.
  const cut = slug.slice(0, MAX_NAME_LENGTH);
  const lastDash = cut.lastIndexOf('-');
  return (lastDash > 8 ? cut.slice(0, lastDash) : cut).replace(/-$/, '');
};

/** `provider/model` from a string or `{ providerID, modelID }`, or ''. */
const modelRefOf = (model) => {
  const asText = asNonEmptyString(model);
  if (asText) return asText;
  if (!isRecord(model)) return '';
  const providerID = asNonEmptyString(model.providerID);
  const modelID = asNonEmptyString(model.modelID);
  return providerID && modelID ? `${providerID}/${modelID}` : '';
};

/**
 * Each field is checked here; a value of the wrong type is ignored.
 *
 * @param {object} options
 * @param {unknown} [options.prompt] the session's initial prompt
 * @param {unknown} [options.model] model to name with; `provider/model` or `{ providerID, modelID }`
 * @param {unknown} [options.directory] project directory (scopes the OpenCode request)
 * @param {Function} [options.generateText] injectable for tests; defaults to the small-model service
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<string>} a slug, or '' when no name could be generated
 */
export const generateWorktreeName = async ({ prompt, model, directory, generateText, signal } = {}) => {
  const text = asNonEmptyString(prompt);
  if (!text) return '';
  const generate = generateText
    ?? (await import('../small-model/index.js')).generateSmallModelText;
  const request = {
    prompt: `Request:\n${text.slice(0, MAX_PROMPT_CHARS)}`,
    system: WORKTREE_NAME_SYSTEM_PROMPT,
    maxOutputTokens: 32,
    timeoutMs: 20_000,
  };
  const modelRef = modelRefOf(model);
  if (modelRef) request.model = modelRef;
  const scopedDirectory = asNonEmptyString(directory);
  if (scopedDirectory) request.directory = scopedDirectory;
  if (signal) request.signal = signal;
  try {
    const result = await generate(request);
    return sanitizeGeneratedWorktreeName(isRecord(result) ? result.text : result);
  } catch (error) {
    console.warn('[worktree-name] generation failed:', error instanceof Error ? error.message : String(error));
    return '';
  }
};
