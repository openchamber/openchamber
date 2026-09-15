// Commit-message prompt assembly and parse/format helpers for the VS Code
// extension host. Keep these templates aligned with
// `packages/ui/src/lib/magicPrompts.ts` (`git.commit.generate.*`).

export const COMMIT_DIFF_FILE_LIMIT = 30;
export const COMMIT_DIFF_TOTAL_CHAR_LIMIT = 120_000;
export const COMMIT_STYLE_SAMPLE_COUNT = 10;
export const COMMIT_STYLE_SUBJECT_CHAR_LIMIT = 200;

export type GitStatusFileLike = {
  path: string;
  index: string;
  working_dir: string;
};

export type GeneratedCommitMessage = {
  subject: string;
  highlights: string[];
};

type CommitGenerationPrompt = {
  system: string;
  prompt: string;
};

const DEFAULT_VISIBLE_PROMPT =
  'You are generating a Conventional Commits subject line from the diffs of the selected files.';

const DEFAULT_INSTRUCTIONS_PROMPT = `Return exactly one JSON object and nothing else. Do not include prose, markdown, explanations, or code fences.

The JSON object must have exactly this shape:
{"subject": string, "highlights": string[]}

Rules:
- match the style of the recent commits below: their language, capitalization, use or absence of a type prefix or scope, and typical length
- if the recent commits are written in a language other than English, write the subject and highlights in that language
- when the recent commits show no consistent style, use the format <type>: <summary> with one of: feat, fix, refactor, perf, docs, test, build, ci, chore, style, revert, and no scope
- keep subject concise and user-facing
- highlights: 0-3 concise user-facing points
- use double quotes for all JSON strings
- do not include trailing commas or comments

Recent commits on this branch (newest first):
{{recent_commits}}

Selected files:
{{selected_files}}`;

const isMeaningfulStatus = (value: string): boolean => {
  const token = value.trim();
  return token.length > 0 && token !== '?' && token !== '!';
};

export const commitPathUsesStagedDiff = (file: GitStatusFileLike | undefined): boolean => {
  return Boolean(file && isMeaningfulStatus(file.index));
};

export const selectCommitFilePaths = (files: GitStatusFileLike[]): string[] => {
  const staged: string[] = [];
  const unstaged: string[] = [];
  for (const file of files) {
    const filePath = file.path.trim();
    if (!filePath) continue;
    if (isMeaningfulStatus(file.index)) {
      staged.push(filePath);
      continue;
    }
    if (file.working_dir.trim().length > 0 && file.working_dir.trim() !== '!') {
      unstaged.push(filePath);
    }
  }
  const chosen = staged.length > 0 ? staged : unstaged;
  return [...new Set(chosen)].sort();
};

const applyCommitPromptVariables = (
  template: string,
  selectedFiles: string,
  recentCommits: string,
): string => {
  return template
    .replace(/\{\{\s*selected_files\s*\}\}/g, selectedFiles)
    .replace(/\{\{\s*recent_commits\s*\}\}/g, recentCommits);
};

export const formatRecentCommitSubjects = (messages: string[]): string => {
  const subjects = messages
    .map((message) => message.trim().split('\n')[0]?.trim() ?? '')
    .filter(Boolean)
    .map((subject) => subject.slice(0, COMMIT_STYLE_SUBJECT_CHAR_LIMIT));
  if (subjects.length === 0) return '(no commits yet)';
  return subjects.map((subject) => `- ${subject}`).join('\n');
};

export const buildCommitGenerationPrompt = (
  files: string[],
  recentCommits: string,
  diffs: string,
  visibleOverride: string,
  instructionsOverride: string,
): CommitGenerationPrompt => {
  const system = visibleOverride.trim().length > 0 ? visibleOverride : DEFAULT_VISIBLE_PROMPT;
  const instructionsTemplate = instructionsOverride.trim().length > 0
    ? instructionsOverride
    : DEFAULT_INSTRUCTIONS_PROMPT;
  const hiddenPrompt = applyCommitPromptVariables(
    instructionsTemplate,
    files.map((file) => `- ${file}`).join('\n'),
    recentCommits,
  );
  return {
    system,
    prompt: `${hiddenPrompt}\n\nDiffs of the selected files:\n${diffs}`,
  };
};

export const parseGeneratedCommitMessage = (raw: string): GeneratedCommitMessage | null => {
  const text = raw.trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced?.[1] ?? text).trim();
  const start = candidate.indexOf('{');
  if (start < 0) return null;

  for (let end = candidate.length; end > start; end -= 1) {
    if (candidate[end - 1] !== '}') continue;
    try {
      // SAFETY: this slice is JSON object text from the model; we only keep a non-empty subject.
      const parsed = JSON.parse(candidate.slice(start, end)) as {
        subject?: string;
        highlights?: string[];
      };
      const subject = parsed.subject?.trim() ?? '';
      if (!subject) continue;
      const highlights: string[] = [];
      if (Array.isArray(parsed.highlights)) {
        for (const item of parsed.highlights) {
          const trimmed = item?.trim() ?? '';
          if (!trimmed) continue;
          highlights.push(trimmed);
          if (highlights.length === 3) break;
        }
      }
      return { subject, highlights };
    } catch {
      // Keep scanning; models sometimes wrap JSON with prose or fences.
    }
  }
  return null;
};

export const formatCommitMessageForScm = (message: GeneratedCommitMessage): string => {
  const subject = message.subject.trim();
  const highlights = message.highlights
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => `- ${item}`);
  if (highlights.length === 0) return subject;
  return `${subject}\n\n${highlights.join('\n')}`;
};
