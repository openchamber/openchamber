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
  | 'github.pr.comment.single.instructions'
  | 'plan.todo.visible'
  | 'plan.todo.instructions'
  | 'plan.improve.visible'
  | 'plan.improve.instructions'
  | 'plan.implement.visible'
  | 'plan.implement.instructions';

export interface MagicPromptDefinition {
  id: MagicPromptId;
  title: string;
  description: string;
  group: 'Git' | 'GitHub' | 'Planning';
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
    template: `You are drafting a pull request review comment that will be posted back to the PR author. You are not the implementer; do not propose to write code or run commands.

Before drafting:
- Read the PR title and body first to anchor on the author's intent. Evaluate whether the implementation matches that intent — missing pieces, incorrect behavior vs intent, scope creep.
- The PR diff is the source of truth for what changed; the repo on disk may not yet reflect those changes. Read the diff carefully. Use the repo only as ancillary context (imports, call sites, existing patterns, nearby code) when you need to verify a specific claim — not to discover the changes themselves.
- No speculation: every reported issue must be grounded in the diff plus ancillary repo evidence you actually read. If a claim cannot be verified, drop it — do not hedge or guess.
- Clarifying question: if the PR's intent itself is unreadable (title/body give no "why", diff is ambiguous on purpose), ask me one focused question about intent and stop. Do not open a discovery loop — this is a review, not a planning session.

High-signal bar — only report issues that meet all of:
- Objective and verifiable from the diff plus ancillary repo evidence.
- Introduced by this PR (not pre-existing).
- Material: bugs that will cause incorrect runtime behavior, security/privacy risks, correctness edge cases, backwards-compat breakage, missing implementations across modules/targets, boundary violations, OR a clear CLAUDE.md / AGENTS.md violation where you can quote the exact rule.

Do NOT report:
- Pre-existing issues unrelated to the diff.
- Pedantic nitpicks a senior engineer would not flag.
- Issues a linter would catch.
- Subjective style preferences not explicitly required by CLAUDE.md / AGENTS.md.
- "Might" / "could" / "potential" concerns without concrete evidence.
- Rules mentioned in CLAUDE.md / AGENTS.md but explicitly silenced in the code (e.g., via an ignore comment or documented exception).
- Missing tests / coverage gaps unless CLAUDE.md / AGENTS.md explicitly requires them for the changed area.

Validation pass: before writing the final comment, re-check each candidate issue against the diff + ancillary repo evidence. Drop anything you are not certain about. False positives waste the author's time.

Output rules:
- Produce a single review comment addressed to the PR author, using the exact format below.
- No emojis. No code snippets. No fenced blocks. Short inline code identifiers are fine.
- Reference evidence with file paths and line ranges (e.g., path/to/file.ts:120-138) derived from the diff. Use "approx" only as a last resort when the diff does not expose exact lines.
- One bullet per unique issue; do not duplicate an issue across sections.
- Keep the whole comment under ~300 words.

Format exactly:
<1-2 sentence summary of intent and top-level verdict>

Must-fix:
- <issue> - <brief why> - <file:line-range> - Action: <one-line action>
Nice-to-have:
- <issue> - <brief why> - <file:line-range> - Action: <one-line action>

If nothing clears the high-signal bar, write:
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
- After gathering, if anything is still unclear or cannot be verified, do not speculate — state what's missing and ask targeted questions.

Mode selection by type:
- Bug / Question/Support / Ops: deliver the response directly using the matching template below. Do not bombard me with questions for straightforward diagnosis; use "Missing info" / "Repro/diagnostics needed" fields instead.
- Feature request / Refactor with substantive unknowns: this is effectively a planning session. Do not emit the Feature template on the first turn. Instead, ask me focused clarifying questions in batches of at most 3, one topic at a time (scope, constraints, tradeoffs, UX, etc.), wait for answers, drop questions that became irrelevant, and repeat until you have no more substantive questions. Only then emit the Feature template.

Output rules:
- Compact output; pick ONE template below and omit the others.
- No emojis. No code snippets. No fenced blocks.
- Short inline code identifiers allowed.
- Reference evidence with file paths and line ranges when applicable; if exact lines are not available, cite the file and say "approx" + why.
- Keep the entire response under ~300 words (applies to the final template output, not to clarifying-question turns).

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
- Before proposing a plan: if a comment's intent is ambiguous, or the required change depends on a tradeoff only I can decide, ask me focused clarifying questions in batches of at most 3 and wait for answers. Do not speculate.
- Once intent is clear, propose a minimal plan and verification steps.`,
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
- Before proposing a plan: if the reviewer's intent is ambiguous or the required change depends on a tradeoff only I can decide, ask me focused clarifying questions in batches of at most 3 and wait for answers. Do not speculate.
- Once intent is clear, propose a minimal implementation plan and verification steps.`,
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
  {
    id: 'plan.todo.visible',
    title: 'Todo Planning Visible Prompt',
    group: 'Planning',
    description: 'Visible user message when sending a todo into a new planning session.',
    placeholders: [
      { key: 'todo_text', description: 'Todo text selected by the user.' },
    ],
    template: '{{todo_text}}',
  },
  {
    id: 'plan.todo.instructions',
    title: 'Todo Planning Instructions',
    group: 'Planning',
    description: 'Hidden instructions for sending a project todo into a new planning session.',
    placeholders: [
      { key: 'todo_text', description: 'Todo text selected by the user.' },
    ],
    template: `You are starting from a project todo item.
Todo: {{todo_text}}
Your job right now is to produce a thorough implementation plan for this todo, not to implement it yet. Optimize for a well-considered plan, not a fast one.

Work back and forth with me. Do not dump a wall of questions. Do not jump to the full plan.

Discovery — questions in batches of 3:
1. First, inspect the repo — relevant files, module docs, existing patterns, nearby code, constraints, dependencies — enough to form informed questions, not enough to guess the plan.
2. Ask me at most 3 questions per turn. Each batch should be focused on one topic at a time (e.g., scope, architecture, data model, UX, edge cases). Pick the topic that most blocks the plan right now.
3. Wait for my answers. Use them to refine your understanding, re-read code if needed, and prepare the next batch.
4. Questions that became irrelevant after my earlier answers — drop them, don't ask.
5. Repeat until you have no more substantive questions.

Alignment:
6. Share a short outline: affected areas, proposed approach, main risks. Wait for my confirmation or corrections. Iterate on the outline until I confirm.

Final plan:
7. Once aligned, deliver the concrete implementation plan grounded in the repo context. Make remaining assumptions and missing context explicit.`,
  },
  {
    id: 'plan.improve.visible',
    title: 'Improve Plan Visible Prompt',
    group: 'Planning',
    description: 'Visible user message when sending a saved plan into an improve flow.',
    placeholders: [
      { key: 'plan_title', description: 'Current plan title.' },
    ],
    template: 'Improve this plan: {{plan_title}}',
  },
  {
    id: 'plan.improve.instructions',
    title: 'Improve Plan Instructions',
    group: 'Planning',
    description: 'Hidden instructions for improving a saved plan from project context.',
    placeholders: [
      { key: 'plan_title', description: 'Current plan title.' },
      { key: 'plan_path', description: 'Absolute path to the saved plan file.' },
    ],
    template: `You are starting from an existing implementation plan.
Plan title: {{plan_title}}
This plan is stored in the file: {{plan_path}}
Read that file first and treat its current contents as the source of truth for the plan.
Your job right now is to improve this plan so it is better grounded in the actual repo state. Do not implement yet. Optimize for a well-considered improved plan, not a fast one.

Work back and forth with me. Do not dump a wall of questions. Do not jump to the full improved plan.

Discovery — questions in batches of 3:
1. First, inspect the repo and map it against the plan — relevant files, module docs, existing patterns, nearby code, constraints, dependencies. Identify gaps, plan assumptions that don't match the repo, missing context, and risks.
2. Ask me at most 3 questions per turn. Each batch should be focused on one topic at a time (e.g., scope deltas, architecture assumptions, data model, UX, edge cases, tradeoffs between approaches). Pick the topic that most blocks a confident improvement right now.
3. Wait for my answers. Use them to refine your understanding, re-read code if needed, and prepare the next batch.
4. Questions that became irrelevant after my earlier answers — drop them, don't ask.
5. Repeat until you have no more substantive questions.

Alignment:
6. Share a short summary of proposed changes — what sections of the plan change and why, open questions, recommendations. Do not rewrite the whole plan inline and do not return the full plan as a code block. Quote only small targeted snippets or describe the exact sections to change. Wait for my confirmation or corrections. Iterate until I confirm.

Final step:
7. Once aligned, explicitly offer to edit this same file ({{plan_path}}) with the agreed changes. Make remaining assumptions and missing context explicit.`,
  },
  {
    id: 'plan.implement.visible',
    title: 'Implement Plan Visible Prompt',
    group: 'Planning',
    description: 'Visible user message when sending a saved plan into an implement flow.',
    placeholders: [
      { key: 'plan_title', description: 'Current plan title.' },
    ],
    template: 'Implement this plan: {{plan_title}}',
  },
  {
    id: 'plan.implement.instructions',
    title: 'Implement Plan Instructions',
    group: 'Planning',
    description: 'Hidden instructions for implementing a saved plan from project context.',
    placeholders: [
      { key: 'plan_title', description: 'Current plan title.' },
      { key: 'plan_path', description: 'Absolute path to the saved plan file.' },
    ],
    template: `You are starting from an existing implementation plan.
Plan title: {{plan_title}}
This plan is stored in the file: {{plan_path}}
Read that file first and treat its current contents as the source of truth for the plan. The plan is already agreed; implement it end-to-end without deviating from it.

Before and during implementation, build a deep understanding of the project — relevant files, module docs, existing patterns, nearby code, conventions — so your choices fit the repo's style.

Do the implementation work continuously. When a plan step is ambiguous, do not stop to ask — make the best judgment call consistent with the plan's intent and the repo's conventions, and briefly note the decision inline so it is visible on review. Prefer forward progress over interrupting me.

Do not expand scope beyond the plan. If during implementation you find the plan itself is wrong or genuinely blocks completion (not merely ambiguous), stop, state exactly what is broken and why, and propose a plan adjustment to save back into this same file ({{plan_path}}) before continuing.`,
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
