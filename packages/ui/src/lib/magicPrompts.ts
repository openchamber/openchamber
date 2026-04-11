export type MagicPromptId =
  | 'git.commit.generate.visible'
  | 'git.commit.generate.instructions'
  | 'git.pr.generate.visible'
  | 'git.pr.generate.instructions'
  | 'git.conflict.resolve.visible'
  | 'git.conflict.resolve.instructions'
  | 'git.integrate.cherrypick.resolve.visible'
  | 'git.integrate.cherrypick.resolve.instructions'
  | 'github.pr.review.visible'
  | 'github.pr.review.instructions'
  | 'github.issue.review.visible'
  | 'github.issue.review.instructions'
  | 'github.pr.checks.review.visible'
  | 'github.pr.checks.review.instructions'
  | 'github.pr.comments.review.visible'
  | 'github.pr.comments.review.instructions'
  | 'github.pr.comment.single.visible'
  | 'github.pr.comment.single.instructions';

export interface MagicPromptDefinition {
  id: MagicPromptId;
  title: string;
  description: string;
  group: 'Git' | 'GitHub';
  template: string;
  placeholders?: Array<{ key: string; description: string }>;
}

export interface MagicPromptOverridesPayload {
  version: number;
  overrides: Record<string, string>;
}

const API_ENDPOINT = '/api/magic-prompts';

export const MAGIC_PROMPT_DEFINITIONS: readonly MagicPromptDefinition[] = [
  {
    id: 'git.commit.generate.visible',
    title: 'Commit Generation Visible Prompt',
    group: 'Git',
    description: 'Visible user message for commit message generation.',
    template: 'You are generating a Conventional Commits subject line using session context and selected file paths.',
  },
  {
    id: 'git.commit.generate.instructions',
    title: 'Commit Generation Instructions',
    group: 'Git',
    description: 'Hidden instructions for commit message generation.',
    placeholders: [
      { key: 'selected_files', description: 'Bullet list of currently selected file paths.' },
    ],
    template: `Return JSON with exactly this shape:
{"subject": string, "highlights": string[]}

Rules:
- subject format: <type>: <summary>
- allowed types: feat, fix, refactor, perf, docs, test, build, ci, chore, style, revert
- no scope in subject
- keep subject concise and user-facing
- highlights: 0-3 concise user-facing points

Selected files:
{{selected_files}}`,
  },
  {
    id: 'git.pr.generate.visible',
    title: 'PR Generation Visible Prompt',
    group: 'Git',
    description: 'Visible user message for PR title/body generation.',
    template: 'You are drafting GitHub Pull Request title and body using session context, commit list, and changed files.',
  },
  {
    id: 'git.pr.generate.instructions',
    title: 'PR Generation Instructions',
    group: 'Git',
    description: 'Hidden instructions for PR title/body generation.',
    placeholders: [
      { key: 'base_branch', description: 'Base branch name.' },
      { key: 'head_branch', description: 'Head branch name.' },
      { key: 'commits', description: 'Bullet list of commits in base...head.' },
      { key: 'changed_files', description: 'Bullet list of changed files in base...head.' },
      { key: 'additional_context_block', description: 'Optional Additional context block (already formatted).' },
    ],
    template: `Return JSON with exactly this shape:
{"title": string, "body": string}

Rules:
- title: concise, outcome-first, conventional style
- body: markdown with sections: ## Summary, ## Why, ## Testing
- keep output concrete and user-facing

Base branch: {{base_branch}}
Head branch: {{head_branch}}

Commits in range (base...head):
{{commits}}

Files changed across these commits:
{{changed_files}}{{additional_context_block}}`,
  },
  {
    id: 'github.pr.review.visible',
    title: 'PR Review Visible Prompt',
    group: 'GitHub',
    description: 'Visible user message when creating PR review requests from GitHub context.',
    placeholders: [
      { key: 'pr_number', description: 'Pull request number.' },
    ],
    template: 'Review this pull request #{{pr_number}} using the provided PR context',
  },
  {
    id: 'github.pr.review.instructions',
    title: 'PR Review Instructions',
    group: 'GitHub',
    description: 'Hidden instructions attached when generating a PR review response.',
    template: `Before reporting issues:
- First identify the PR intent (what it's trying to achieve) from title/body/diff, then evaluate whether the implementation matches that intent; call out missing pieces, incorrect behavior vs intent, and scope creep.
- Gather any needed repository context (code, config, docs) to validate assumptions.
- No speculation: if something is unclear or cannot be verified, say what's missing and ask for it instead of guessing.

Output rules:
- Start with a 1-2 sentence summary.
- Provide a single concise PR review comment.
- No emojis. No code snippets. No fenced blocks.
- Short inline code identifiers allowed, but no snippets or fenced blocks.
- Reference evidence with file paths and line ranges (e.g., path/to/file.ts:120-138). If exact lines aren't available, cite the file and say "approx" + why.
- Keep the entire comment under ~300 words.

Report:
- Must-fix issues (blocking)-brief why and a one-line action each.
- Nice-to-have improvements (optional)-brief why and a one-line action each.

Quality & safety (general):
- Call out correctness risks, edge cases, performance regressions, security/privacy concerns, and backwards-compatibility risks.
- Call out missing tests/verification steps and suggest the minimal validation needed.
- Note readability/maintainability issues when they materially affect future changes.

Applicability (only if relevant):
- If changes affect multiple components/targets/environments (e.g., client/server, OSs, deployments), state what is affected vs not, and why.

Architecture:
- Call out breakages, missing implementations across modules/targets, boundary violations, and cross-cutting concerns (errors, logging/observability, accessibility).

Precedence:
- If local precedent conflicts with best practices, state it and suggest a follow-up task.

Do not implement changes until I confirm; end with a short "Next actions" sentence describing the recommended plan.

Format exactly:
Must-fix:
- <issue> - <brief why> - <file:line-range> - Action: <one-line action>
Nice-to-have:
- <issue> - <brief why> - <file:line-range> - Action: <one-line action>
If no issues, write:
Must-fix:
- None
Nice-to-have:
- None`,
  },
  {
    id: 'github.issue.review.visible',
    title: 'Issue Review Visible Prompt',
    group: 'GitHub',
    description: 'Visible user message when creating issue review requests from GitHub context.',
    placeholders: [
      { key: 'issue_number', description: 'Issue number.' },
    ],
    template: 'Review this issue #{{issue_number}} using the provided issue context',
  },
  {
    id: 'github.issue.review.instructions',
    title: 'Issue Review Instructions',
    group: 'GitHub',
    description: 'Hidden instructions attached when generating an issue review response.',
    template: `Review this issue using the provided issue context.

Process:
- First classify the issue type (bug / feature request / question/support / refactor / ops) and state it as: Type: <one label>.
- Gather any needed repository context (code, config, docs) to validate assumptions.
- After gathering, if anything is still unclear or cannot be verified, do not speculate-state what's missing and ask targeted questions.

Output rules:
- Compact output; pick ONE template below and omit the others.
- No emojis. No code snippets. No fenced blocks.
- Short inline code identifiers allowed.
- Reference evidence with file paths and line ranges when applicable; if exact lines are not available, cite the file and say "approx" + why.
- Keep the entire response under ~300 words.

Templates (choose one):
Bug:
- Summary (1-2 sentences)
- Likely cause (max 2)
- Repro/diagnostics needed (max 3)
- Fix approach (max 4 steps)
- Verification (max 3)

Feature:
- Summary (1-2 sentences)
- Requirements (max 4)
- Unknowns/questions (max 4)
- Proposed plan (max 5 steps)
- Verification (max 3)

Question/Support:
- Summary (1-2 sentences)
- Answer/guidance (max 6 lines)
- Missing info (max 4)

Do not implement changes until I confirm; end with: "Next actions: <1 sentence>".`,
  },
  {
    id: 'github.pr.checks.review.visible',
    title: 'PR Failed Checks Visible Prompt',
    group: 'GitHub',
    description: 'Visible user message for PR failed checks analysis.',
    template: 'Review these PR failed checks and propose likely fixes. Do not implement until I confirm.',
  },
  {
    id: 'github.pr.checks.review.instructions',
    title: 'PR Failed Checks Instructions',
    group: 'GitHub',
    description: 'Hidden instructions for PR failed checks analysis.',
    template: `Use the attached checks payload.
- Summarize what is failing.
- Prioritize check annotations/errors over generic status text.
- Identify likely root cause(s).
- Propose a minimal fix plan and verification steps.
- No speculation: ask for missing info if needed.`,
  },
  {
    id: 'github.pr.comments.review.visible',
    title: 'PR Comments Review Visible Prompt',
    group: 'GitHub',
    description: 'Visible user message for PR comments analysis.',
    template: 'Review these PR comments and propose the required changes and next actions. Do not implement until I confirm.',
  },
  {
    id: 'github.pr.comments.review.instructions',
    title: 'PR Comments Review Instructions',
    group: 'GitHub',
    description: 'Hidden instructions for PR comments analysis.',
    template: `Use the attached comments payload.
- Identify required vs optional changes.
- Call out intent/implementation mismatch if present.
- Propose a minimal plan and verification steps.
- No speculation: ask for missing info if needed.`,
  },
  {
    id: 'github.pr.comment.single.visible',
    title: 'Single PR Comment Visible Prompt',
    group: 'GitHub',
    description: 'Visible user message for single PR comment analysis.',
    template: 'Address this comment from PR and propose required changes. Do not implement until I confirm.',
  },
  {
    id: 'github.pr.comment.single.instructions',
    title: 'Single PR Comment Instructions',
    group: 'GitHub',
    description: 'Hidden instructions for single PR comment analysis.',
    template: `Use the attached single-comment payload.
- Explain what the reviewer is asking for.
- Identify exact code areas likely impacted.
- Propose a minimal implementation plan and verification steps.
- Call out ambiguity and ask focused follow-up questions if needed.`,
  },
  {
    id: 'git.conflict.resolve.visible',
    title: 'Merge/Rebase Conflict Visible Prompt',
    group: 'Git',
    description: 'Visible user message for merge/rebase conflict resolution help.',
    placeholders: [
      { key: 'operation_label', description: 'Operation label in lower-case (merge/rebase).' },
      { key: 'head_ref', description: 'Head reference for preserving intent.' },
    ],
    template: 'Resolve {{operation_label}} conflicts, stage the resolved files, and complete the {{operation_label}}. Preserve the intent of changes from {{head_ref}}.',
  },
  {
    id: 'git.conflict.resolve.instructions',
    title: 'Merge/Rebase Conflict Instructions',
    group: 'Git',
    description: 'Hidden instructions for merge/rebase conflict resolution help.',
    placeholders: [
      { key: 'operation_label', description: 'Operation label in lower-case (merge/rebase).' },
      { key: 'directory', description: 'Repository directory path.' },
      { key: 'operation', description: 'Operation name.' },
      { key: 'head_info', description: 'Head metadata if available.' },
      { key: 'continue_cmd', description: 'Command to continue operation.' },
    ],
    template: `Git {{operation_label}} operation is in progress with conflicts.
- Directory: {{directory}}
- Operation: {{operation}}
- Head Info: {{head_info}}

Required steps:
1. Read each conflicted file to understand the conflict markers (<<<<<<< HEAD, =======, >>>>>>> ...)
2. Edit each file to resolve conflicts by choosing the correct code or merging both changes appropriately
3. Stage all resolved files with: git add <file>
4. Complete the {{operation_label}} with: {{continue_cmd}}

Important:
- Remove ALL conflict markers from files (<<<<<<< HEAD, =======, >>>>>>>)
- Make sure the final code is syntactically correct and preserves intent from both sides
- Do not leave any files with unresolved conflict markers
- After completing all steps, confirm the {{operation_label}} was successful`,
  },
  {
    id: 'git.integrate.cherrypick.resolve.visible',
    title: 'Cherry-pick Conflict Visible Prompt',
    group: 'Git',
    description: 'Visible user message for cherry-pick conflict resolution help.',
    placeholders: [
      { key: 'current_commit', description: 'Current commit hash being applied.' },
      { key: 'target_branch', description: 'Target branch name.' },
    ],
    template: 'Resolve cherry-pick conflicts, stage the resolved files, and continue the cherry-pick. Keep intent of commit {{current_commit}} onto branch {{target_branch}}.',
  },
  {
    id: 'git.integrate.cherrypick.resolve.instructions',
    title: 'Cherry-pick Conflict Instructions',
    group: 'Git',
    description: 'Hidden instructions for cherry-pick conflict resolution help.',
    placeholders: [
      { key: 'repo_root', description: 'Repository root path.' },
      { key: 'temp_worktree_path', description: 'Temporary worktree path.' },
      { key: 'source_branch', description: 'Source branch name.' },
      { key: 'target_branch', description: 'Target branch name.' },
      { key: 'current_commit', description: 'Current commit hash being applied.' },
    ],
    template: `Worktree commit integration (cherry-pick) is in progress with conflicts.
- Repo root: {{repo_root}}
- Temp target worktree: {{temp_worktree_path}}
- Source branch: {{source_branch}}
- Target branch: {{target_branch}}
- Current commit: {{current_commit}}

Required steps:
1. Read each conflicted file in the temp worktree to understand the conflict markers (<<<<<<< HEAD, =======, >>>>>>> ...)
2. Edit each file to resolve conflicts by choosing the correct code or merging both changes appropriately
3. Stage all resolved files with: git add <file>
4. Complete the cherry-pick with: git cherry-pick --continue

Important:
- Work inside the temp worktree directory: {{temp_worktree_path}}
- Remove ALL conflict markers from files (<<<<<<< HEAD, =======, >>>>>>>)
- Preserve the intent of the commit being applied
- Make sure the final code is syntactically correct
- Do not leave any files with unresolved conflict markers
- After completing all steps, confirm the cherry-pick was successful`,
  },
] as const;

const MAGIC_PROMPT_DEFINITION_BY_ID = new Map<MagicPromptId, MagicPromptDefinition>(
  MAGIC_PROMPT_DEFINITIONS.map((definition) => [definition.id, definition])
);

const LEGACY_PROMPT_KEY_MAP: Record<string, { visible: MagicPromptId; instructions: MagicPromptId }> = {
  'git.commit.generate': {
    visible: 'git.commit.generate.visible',
    instructions: 'git.commit.generate.instructions',
  },
  'git.pr.generate': {
    visible: 'git.pr.generate.visible',
    instructions: 'git.pr.generate.instructions',
  },
};

let cachedOverrides: Record<string, string> | null = null;
let inFlightOverridesRequest: Promise<Record<string, string>> | null = null;

const replaceTemplateVariables = (template: string, variables: Record<string, string>) => {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key: string) => {
    if (!Object.prototype.hasOwnProperty.call(variables, key)) {
      return '';
    }
    return variables[key] ?? '';
  });
};

const normalizeOverridesPayload = (payload: unknown): Record<string, string> => {
  const overridesRaw = (payload as { overrides?: unknown } | null)?.overrides;
  if (!overridesRaw || typeof overridesRaw !== 'object' || Array.isArray(overridesRaw)) {
    return {};
  }

  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(overridesRaw as Record<string, unknown>)) {
    if (typeof value !== 'string') {
      continue;
    }
    result[key] = value;
  }

  for (const [legacyKey, splitKeys] of Object.entries(LEGACY_PROMPT_KEY_MAP)) {
    const legacyValue = result[legacyKey];
    if (typeof legacyValue !== 'string') {
      continue;
    }

    const firstNewlineIndex = legacyValue.indexOf('\n');
    const visible = (firstNewlineIndex === -1 ? legacyValue : legacyValue.slice(0, firstNewlineIndex)).trim();
    const instructions = (firstNewlineIndex === -1 ? '' : legacyValue.slice(firstNewlineIndex + 1)).trim();

    if (!(splitKeys.visible in result) && visible.length > 0) {
      result[splitKeys.visible] = visible;
    }
    if (!(splitKeys.instructions in result) && instructions.length > 0) {
      result[splitKeys.instructions] = instructions;
    }
  }

  return result;
};

export const fetchMagicPromptOverrides = async (): Promise<Record<string, string>> => {
  if (cachedOverrides) {
    return cachedOverrides;
  }

  if (!inFlightOverridesRequest) {
    inFlightOverridesRequest = fetch(API_ENDPOINT, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error('Failed to load magic prompts');
        }
        const payload = await response.json().catch(() => ({}));
        const normalized = normalizeOverridesPayload(payload);
        cachedOverrides = normalized;
        return normalized;
      })
      .finally(() => {
        inFlightOverridesRequest = null;
      });
  }

  return inFlightOverridesRequest;
};

export const invalidateMagicPromptOverridesCache = () => {
  cachedOverrides = null;
  inFlightOverridesRequest = null;
};

export const getMagicPromptDefinition = (id: MagicPromptId): MagicPromptDefinition => {
  const definition = MAGIC_PROMPT_DEFINITION_BY_ID.get(id);
  if (!definition) {
    throw new Error(`Unknown magic prompt id: ${id}`);
  }
  return definition;
};

export const getDefaultMagicPromptTemplate = (id: MagicPromptId): string => {
  return getMagicPromptDefinition(id).template;
};

export const getEffectiveMagicPromptTemplate = async (id: MagicPromptId): Promise<string> => {
  const overrides = await fetchMagicPromptOverrides().catch((): Record<string, string> => ({}));
  const override = overrides[id];
  if (typeof override === 'string') {
    return override;
  }
  return getDefaultMagicPromptTemplate(id);
};

export const renderMagicPrompt = async (id: MagicPromptId, variables: Record<string, string> = {}): Promise<string> => {
  const template = await getEffectiveMagicPromptTemplate(id);
  return replaceTemplateVariables(template, variables);
};

export const saveMagicPromptOverride = async (id: MagicPromptId, text: string): Promise<MagicPromptOverridesPayload> => {
  const response = await fetch(`${API_ENDPOINT}/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ text }),
  });
  if (!response.ok) {
    const errorPayload = await response.json().catch(() => ({}));
    throw new Error((errorPayload as { error?: string })?.error || 'Failed to save magic prompt');
  }
  const payload = await response.json();
  cachedOverrides = normalizeOverridesPayload(payload);
  return {
    version: typeof payload?.version === 'number' ? payload.version : 1,
    overrides: cachedOverrides,
  };
};

export const resetMagicPromptOverride = async (id: MagicPromptId): Promise<MagicPromptOverridesPayload> => {
  const response = await fetch(`${API_ENDPOINT}/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    const errorPayload = await response.json().catch(() => ({}));
    throw new Error((errorPayload as { error?: string })?.error || 'Failed to reset magic prompt');
  }
  const payload = await response.json();
  cachedOverrides = normalizeOverridesPayload(payload);
  return {
    version: typeof payload?.version === 'number' ? payload.version : 1,
    overrides: cachedOverrides,
  };
};

export const resetAllMagicPromptOverrides = async (): Promise<MagicPromptOverridesPayload> => {
  const response = await fetch(API_ENDPOINT, {
    method: 'DELETE',
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    const errorPayload = await response.json().catch(() => ({}));
    throw new Error((errorPayload as { error?: string })?.error || 'Failed to reset all magic prompts');
  }
  const payload = await response.json();
  cachedOverrides = normalizeOverridesPayload(payload);
  return {
    version: typeof payload?.version === 'number' ? payload.version : 1,
    overrides: cachedOverrides,
  };
};
