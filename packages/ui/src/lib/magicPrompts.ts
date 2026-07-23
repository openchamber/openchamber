import { runtimeFetch } from './runtime-fetch';

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
  | 'plan.implement.instructions'
  | 'session.summary.visible'
  | 'session.summary.instructions'
  | 'session.review.visible'
  | 'session.review.instructions'
  | 'session.reviewHandoff.visible'
  | 'session.reviewHandoff.instructions'
  | 'session.reviewSession.visible'
  | 'session.reviewSessionWithoutHandoff.visible'
  | 'session.reviewFeedbackToImplementer.visible'
  | 'session.implementationResponseToReviewer.visible'
  | 'session.plan.visible'
  | 'session.plan.instructions'
  | 'session.craftGoal.visible'
  | 'session.craftGoal.instructions'
  | 'session.catchup.visible'
  | 'session.catchup.instructions'
  | 'session.debug.visible'
  | 'session.debug.instructions'
  | 'session.weigh.visible'
  | 'session.weigh.instructions'
  | 'session.explore.visible'
  | 'session.explore.instructions'
  | 'session.fusion.visible'
  | 'session.fusion.instructions';

export interface MagicPromptDefinition {
  id: MagicPromptId;
  title: string;
  description: string;
  group: 'Git' | 'GitHub' | 'Planning' | 'Session';
  template: string;
  placeholders?: Array<{ key: string; description: string }>;
}

export interface MagicPromptOverridesPayload {
  version: number;
  overrides: Record<string, string>;
}

const API_ENDPOINT = '/api/magic-prompts';

const MAGIC_PROMPT_DEFINITIONS: readonly MagicPromptDefinition[] = [
  {
    id: 'git.commit.generate.visible',
    title: 'Commit Generation Visible Prompt',
    group: 'Git',
    description: 'Visible user message for commit message generation.',
    template: 'You are generating a Conventional Commits subject line from the diffs of the selected files.',
  },
  {
    id: 'git.commit.generate.instructions',
    title: 'Commit Generation Instructions',
    group: 'Git',
    description: 'Hidden instructions for commit message generation.',
    placeholders: [
      { key: 'selected_files', description: 'Bullet list of currently selected file paths.' },
    ],
    template: `Return exactly one JSON object and nothing else. Do not include prose, markdown, explanations, or code fences.

The JSON object must have exactly this shape:
{"subject": string, "highlights": string[]}

Rules:
- subject format: <type>: <summary>
- allowed types: feat, fix, refactor, perf, docs, test, build, ci, chore, style, revert
- no scope in subject
- keep subject concise and user-facing
- highlights: 0-3 concise user-facing points
- use double quotes for all JSON strings
- do not include trailing commas or comments

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
    template: `Return exactly one JSON object and nothing else. Do not include prose, markdown outside JSON, explanations, or code fences.

The JSON object must have exactly this shape:
{"title": string, "body": string}

Rules:
- title: concise, outcome-first, conventional style
- body: markdown with sections: ## Summary, ## Why, ## Testing
- keep output concrete and user-facing
- put all markdown inside the body string
- use double quotes for all JSON strings and escape newlines as \\n
- do not include trailing commas or comments

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
    template: 'Investigate the {{operation_label}} conflicts and concisely report the intended resolution strategy without making modifications. Wait for confirmation before resolving, staging, or continuing the {{operation_label}}. Preserve the intent of changes from {{head_ref}}.',
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

Required steps before confirmation:
1. Read each conflicted file to understand the conflict markers (<<<<<<< HEAD, =======, >>>>>>> ...)
2. Inspect the relevant surrounding code and changes from both sides
3. Report a concise per-file resolution strategy and any assumptions or tradeoffs
4. Wait for explicit user confirmation before editing files, staging files, or running: {{continue_cmd}}

Important:
- Do not modify files before the user confirms the proposed strategy
- Do not stage files before the user confirms the proposed strategy
- Do not continue the {{operation_label}} before the user confirms the proposed strategy
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
  {
    id: 'session.summary.visible',
    title: 'Session Summary Visible Prompt',
    group: 'Session',
    description: 'Visible user message sent by the /summary command.',
    placeholders: [
      { key: 'topic_line', description: 'Pre-formatted topic clause (e.g. " focused on: <topic>") or empty string.' },
    ],
    template: 'Summarize this session{{topic_line}}.',
  },
  {
    id: 'session.summary.instructions',
    title: 'Session Summary Instructions',
    group: 'Session',
    description: 'Hidden instructions attached to the /summary command. Produces a non-destructive summary usable for handing off to a new session.',
    placeholders: [
      { key: 'topic_block', description: 'Pre-formatted topic focus paragraph, or empty string when no topic hint was given.' },
    ],
    template: `Produce a non-destructive summary of this conversation. Do NOT compact or mutate session history — your output is an additional assistant message the user will read and may use to hand off to a new session.

Cover the information useful for continuing this work:
- What was done (completed work, in order)
- What is currently in progress
- Files modified — brief what and why per file
- Open questions and next steps
- User requests, constraints, or preferences to carry forward
- Important technical decisions and why they were made

{{topic_block}}

Formatting:
- Concise markdown with short sections and bullet lists
- No preamble like "Here is a summary" — jump straight to content
- Do not answer questions found in the conversation — only summarize
- Keep length proportional to session length; do not pad

Respond in the same language the user used most in the conversation.`,
  },
  {
    id: 'session.review.visible',
    title: 'Workspace Review Visible Prompt',
    group: 'Session',
    description: 'Visible user message sent by the /workspace-review command.',
    template: 'Review the changes made in this workspace.',
  },
  {
    id: 'session.review.instructions',
    title: 'Workspace Review Instructions',
    group: 'Session',
    description: 'Hidden instructions attached to the /workspace-review command. Reviews the workspace diff for intent, correctness, and adequacy, with severity-classified findings.',
    template: `Review the changes in this workspace and judge whether they are correct and adequate — not just whether they contain catastrophic bugs.

The diff is the source of truth. Read the relevant code around the diff too, not only the diff itself, so you understand the change in context.

First, understand the intent and whether it was achieved:
- Work out what these changes are trying to do — the intent behind them — from the diff and the surrounding code.
- Judge whether the implementation actually achieves that intent, and whether it is the smallest correct way to do it. Call out where the change is incomplete, only partially solves the goal, misses cases it clearly set out to handle, or solves it in a way that will not hold up.

Then look for concrete problems. Report real failure modes, not abstract suspicions, and do not nitpick without impact.

Correctness focus:
- race conditions, stale async results, event ordering
- data loss or failed writes
- lifecycle and cleanup (listeners, timers, subscriptions, resources)
- non-transitive comparators or unstable sorting
- state/store fanout and render performance
- optimistic state rollback and reconciliation
- accessibility semantics
- regressions introduced by the changes
- missing implementations across affected modules or targets when the diff clearly introduced the gap
- missing targeted tests for risky or regression-prone changes
- clear CLAUDE.md or AGENTS.md violations that apply to the changed files

Security and supply-chain focus (when the diff touches these):
- dependencies, build/release/CI scripts
- auth, tokens, secrets, credentials
- filesystem boundaries and path traversal
- shell execution
- network calls, telemetry, exfiltration
- IPC, native bridge, updater, desktop shell
- hidden behavior behind small diffs or broad refactors

Do not report:
- pre-existing issues unrelated to the diff
- pedantic nitpicks a senior engineer would not flag, or issues a linter would catch
- subjective style preferences not required by CLAUDE.md or AGENTS.md
- speculative concerns you cannot tie to a concrete failure
- rules mentioned in CLAUDE.md or AGENTS.md but explicitly silenced in the code

Validation pass:
- Before reporting an issue, re-check it against the diff plus only the context you actually read.
- For CLAUDE.md or AGENTS.md violations, verify the rule applies to the affected file path and cite the exact rule.
- If you cannot tie a finding to a concrete impact, drop it.

Classify each finding:
- blocker: likely regression, data loss, security issue, broken invariant, or a serious correctness problem — or the change does not actually achieve its intent
- non-blocker: a real but minor issue, a test gap, or a maintainability concern
- nit: mention only if useful, never treat as blocking

This is a review only — do not edit, fix, or commit anything unless the user asks you to.

Output:
- Start with one or two sentences: what the change does and whether it achieves its intent.
- Then list findings grouped by severity. For each: short title, why it is a real problem, the affected file path, and category (correctness / security / rule violation / adequacy gap).
- If you find nothing real, say so plainly instead of inventing findings.

Keep the review concise and practical. Respond in the same language the user uses.`,
  },
  {
    id: 'session.reviewHandoff.visible',
    title: 'Review Handoff Visible Prompt',
    group: 'Session',
    description: 'Visible user message sent by the /handoff-review command.',
    template: 'Prepare a handoff for another agent to review this work.',
  },
  {
    id: 'session.reviewHandoff.instructions',
    title: 'Review Handoff Instructions',
    group: 'Session',
    description: 'Hidden instructions attached to the /handoff-review command. Produces a handoff for a separate review agent.',
    template: `Produce a review handoff for another agent. Do not compact or mutate session history. Your output is an assistant message that OpenChamber will send to a separate reviewer agent.

Include:
- The user's original intent and any later clarifications that changed the intent
- What was implemented and why
- Files changed, with brief purpose per file
- Important design decisions and tradeoffs
- Validation/tests run, if known
- Known gaps, uncertainty, or areas the reviewer should inspect closely

Formatting:
- Concise markdown with clear sections
- No preamble like "Here is a handoff"
- Do not mention OpenChamber metadata, linked sessions, session IDs, or routing
- Respond in the same language the user used most in the conversation`,
  },
  {
    id: 'session.reviewSession.visible',
    title: 'Review Session Starter Prompt',
    group: 'Session',
    description: 'Visible user message sent to the generated review session.',
    placeholders: [
      { key: 'handoff', description: 'The generated implementation handoff.' },
    ],
    template: `Please review the changes described in this handoff.

Focus on correctness, regressions, missing implementation, missing tests, and whether the implementation satisfies the stated intent. Provide concise, actionable feedback for the agent implementing the changes.

{{handoff}}`,
  },
  {
    id: 'session.reviewSessionWithoutHandoff.visible',
    title: 'Review Session Starter Prompt Without Handoff',
    group: 'Session',
    description: 'Visible user message sent to a generated review session when no implementation handoff is generated first.',
    template: `Please review the current workspace changes.

There is no generated implementation handoff. Infer the likely user intent from the current diff, recent session context if available, changed files, and surrounding code. Judge whether the implementation is correct for that inferred intent, and call out uncertainty explicitly when intent cannot be recovered.

Focus on correctness, regressions, missing implementation, missing tests, and whether the implementation is the smallest maintainable way to satisfy the likely goal. Provide concise, actionable feedback for the agent implementing the changes.`,
  },
  {
    id: 'session.reviewFeedbackToImplementer.visible',
    title: 'Review Feedback Transfer Prompt',
    group: 'Session',
    description: 'Visible user message sent from a review session back to the implementing agent.',
    placeholders: [
      { key: 'review_feedback', description: 'Reviewer assistant feedback text.' },
    ],
    template: `Another agent reviewed your changes and left the feedback below.

Please review the feedback, resolve the relevant issues, and explain what you changed.

{{review_feedback}}`,
  },
  {
    id: 'session.implementationResponseToReviewer.visible',
    title: 'Implementation Response Transfer Prompt',
    group: 'Session',
    description: 'Visible user message sent from the implementing agent back to the review session.',
    placeholders: [
      { key: 'implementation_response', description: 'Implementing assistant response text.' },
    ],
    template: `The agent implementing the changes has responded to the previous review feedback.

Please review the latest state again and report any remaining issues.

{{implementation_response}}`,
  },
  {
    id: 'session.plan.visible',
    title: 'Feature Planning Visible Prompt',
    group: 'Session',
    description: 'Visible user message sent by the /plan-feature command.',
    template: 'I want to start planning a feature.',
  },
  {
    id: 'session.plan.instructions',
    title: 'Feature Planning Instructions',
    group: 'Session',
    description: 'Hidden instructions attached to the /plan-feature command. Runs a guided, batched-question dialogue that researches the code before producing an implementation plan.',
    template: `The user wants to plan a feature through a guided, back-and-forth conversation. They will describe an idea — often briefly and informally. Your job is to turn that idea into a concrete, validated implementation plan, without guessing.

Run this as a dialogue, not a one-shot answer.

Whenever you ask the user a question, use the \`question\` tool. Do not ask questions in plain assistant text.

1. Understand before asking. Once the user describes the idea, first investigate the codebase yourself — read the relevant files, existing patterns, data flow, and constraints. Ground every question in what the code actually shows, not in assumptions.

2. Ask in small batches. Ask at most 3 clarifying questions at a time — a number a person can comfortably answer in one reply. Prefer concrete, decision-oriented questions (option A/B/C, edge cases, scope boundaries) over vague open-ended ones. Number them.

3. Keep going until it is resolved. After each batch of answers, integrate them, do any further code investigation the answers require, then ask the next batch. Continue until there are no unresolved decisions or implementation details left. Do not stop early or start summarizing prematurely.

4. Surface what the user has not considered. Proactively raise edge cases, pitfalls, affected modules, migration/backward-compatibility concerns, and trade-offs the user likely did not think about. Fold these into your questions so the user decides — never silently decide for them.

5. Do not write code or begin implementing during this phase. Planning is for understanding and deciding only.

6. When everything is settled, produce the final implementation plan: a clear, ordered breakdown of the work, the files and areas affected, the decisions that were made (and why), known risks, and any remaining assumptions flagged explicitly. The plan must reflect the user's actual answers — never fill gaps with guesses.

Respond in the same language the user uses.`,
  },
  {
    id: 'session.craftGoal.visible',
    title: 'Goal Crafting Visible Prompt',
    group: 'Session',
    description: 'Visible user message sent by the /craft-goal command.',
    placeholders: [
      { key: 'idea_block', description: 'Optional initial task or idea supplied after the command.' },
    ],
    template: `Help me turn an idea or task into a clear, verifiable Goal.{{idea_block}}`,
  },
  {
    id: 'session.craftGoal.instructions',
    title: 'Goal Crafting Instructions',
    group: 'Session',
    description: 'Hidden instructions attached to the /craft-goal command. Guides discovery and produces a ready-to-use Goal objective.',
    template: `The user wants help turning a task, idea, or desired outcome into a strong Goal for an autonomous, multi-turn working session.

A Goal is a persistent completion contract, not an implementation plan and not a larger one-shot prompt. Help the user define what "done" means clearly enough that another agent can work toward it, verify it against evidence, continue through uncertain intermediate steps, and stop honestly when completion is blocked.

Run this as a guided dialogue, not a one-shot answer.

Whenever you ask the user a question, use the \`question\` tool. Do not ask questions in plain assistant text.

1. Start from the user's intent. If the visible message includes an initial idea, use it immediately. Otherwise ask what they want to accomplish. Do not ask them to formulate the Goal themselves.

2. Investigate before asking when context is available. For repository work, inspect relevant code, tests, scripts, documentation, and conventions when that would answer questions or expose constraints. Do not ask for information that can be determined reliably from the workspace.

3. Decide whether a Goal is appropriate. Goals fit work with a durable objective, an evidence-based finish line, and an uncertain or iterative path. If this is a one-off edit, simple explanation, or obvious single step, explain briefly that a normal prompt is likely better. Continue crafting a Goal if the user still wants one.

4. Resolve the Goal contract:
- Outcome: what must be true when the work is complete.
- Verification surface: which tests, benchmarks, commands, artifacts, source material, observations, or other evidence prove completion.
- Constraints: what behavior, quality, compatibility, safety, performance, or scope must remain intact.
- Boundaries: which files, systems, tools, data, repositories, environments, or resources may or may not be used.
- Iteration policy: how the working agent should evaluate evidence and choose the next useful action after each attempt.
- Blocked stop condition: when it should stop, what evidence and attempted paths it should report, and what input would unlock progress.

5. Ask only necessary questions, in batches of at most 3. Prefer concrete, decision-oriented questions. Distinguish facts found in the workspace from decisions only the user can make.

6. Do not over-prescribe the path. Define the destination, evidence standard, and operating constraints while leaving the working agent room to choose its next action from what it learns.

7. Do not invent precision. Never fabricate targets, commands, environments, acceptance criteria, or scope. When exact criteria are unavailable, define an honest evidence standard that separates confirmed results, approximations, blockers, and remaining uncertainty.

8. Do not implement the task. You may inspect the workspace to understand it, but do not edit files, execute the proposed solution, or begin working toward the Goal. This session's deliverable is the Goal itself.

9. Once the contract is resolved, respond in exactly this structure:

## Proposed Goal

\`\`\`text
<one self-contained Goal objective ready to paste into the Goal dialog; do not prefix it with /goal>
\`\`\`

## Why This Is Verifiable

- <brief explanation of the outcome and evidence>
- <brief explanation of the preserved constraints>
- <brief explanation of the blocked stop condition>

## Assumptions

- <only assumptions that still matter, or "None">

The proposed Goal should normally be one compact paragraph. Keep enough operational detail to make completion auditable, but remove conversational history, rationale, repetition, and implementation details that are not part of the completion contract.

Do not activate, execute, or claim completion of the proposed Goal. End by inviting the user to revise it or use it in the Goal dialog.

Respond in the same language the user uses.`,
  },
  {
    id: 'session.catchup.visible',
    title: 'Catch Up Visible Prompt',
    group: 'Session',
    description: 'Visible user message sent by the /catch-up command.',
    template: 'Catch me up on where this project is right now.',
  },
  {
    id: 'session.catchup.instructions',
    title: 'Catch Up Instructions',
    group: 'Session',
    description: 'Hidden instructions attached to the /catch-up command. Inspects git state and branches on it: in-progress diff, open PR review state, or recent commits.',
    template: `The user is returning to this project after stepping away and wants to quickly get their bearings — a quick, easy-to-digest "here's where you are and where to pick up", not a status report. Investigate the actual repository state first, then orient them conversationally. Do not assume; check.

Quietly inspect git state first, and do this work silently — the user wants the takeaway, not a play-by-play of the commands you ran. Look at: the current branch and whether it is the repo's default branch (main/master, or whatever this repo uses), uncommitted changes (status and diff), recent commits, and where the branch stands relative to its remote.

Build context in LAYERS — they combine, they are not either/or. Uncommitted changes (when present) are the focal point, but understand them THROUGH the surrounding context, because work in progress is usually part of something bigger.

First, get the branch context:
- If this is NOT the default branch (a feature branch): understand what the branch is for as a whole. Read its recent commits and their diffs — not all of them, just enough, going back until the intent and how it is being implemented become clear. Also check whether the branch has its OWN open pull request, even when there are uncommitted changes — the PR explains what the current diff is in service of (continuing the feature, or addressing review feedback) and helps you judge whether the work looks finished or still mid-flight. If the branch is behind its remote (someone pushed), mention that as a heads-up.
- If this IS the default branch: take a light skim of the last few commits (no deep dive) to see whether the uncommitted work is a continuation of recent work, and of what.

Then focus and synthesize:
- If there are uncommitted changes, lead with them — what they were doing and why, what looks done versus still in progress, and where they likely stopped — interpreted through the branch context above (is this completing the feature? addressing review? a new direction?). Open with that, e.g. "Looks like you were in the middle of X…".
- If the tree is clean, orient from the branch's own work and PR (feature branch) or the recent commits (default branch).

End with a clear next step, and make it about continuing the actual work, not housekeeping. The fact that they ran this command means they stepped away — if the work were finished they would most likely have shipped it already, so assume there is more to do and point to the substantive next piece ("next you'd wire X into Y and handle Z"). Only suggest housekeeping — pushing, opening a PR, running checks — when there is genuinely nothing left to build, or when it is truly the most useful thing to do next.

Hard rules:
- Only ever discuss the CURRENT branch and its own work. Never mention unrelated branches, other people's PRs, review requests assigned to the user, or PRs that belong to other branches — that is noise here.
- Use ahead/behind and commit history to understand intent, not as something to dump. Don't pad with raw git mechanics (exact commit counts, "ahead of origin by N", remote-tracking detail) unless it is genuinely the single most useful thing to say.
- Depth goes into your understanding, not the length of the reply. Keep the output short, easy to digest, and scannable — a couple of sentences of orientation plus a clear next step. Write like a teammate catching them up, not a CI summary.

Respond in the same language the user uses.`,
  },
  {
    id: 'session.debug.visible',
    title: 'Debugging Visible Prompt',
    group: 'Session',
    description: 'Visible user message sent by the /debug command.',
    template: 'I want to debug an issue.',
  },
  {
    id: 'session.debug.instructions',
    title: 'Debugging Instructions',
    group: 'Session',
    description: 'Hidden instructions attached to the /debug command. Runs a guided root-cause investigation before proposing a fix.',
    template: `The user wants help debugging an issue. Drive this as a focused root-cause investigation — not a plan, and not an immediate fix.

Whenever you ask the user a question, use the \`question\` tool. Do not ask questions in plain assistant text.

1. Get the symptom. When the user describes the problem, capture exactly what is observed versus expected — error messages, stack traces, failing behavior, and when it started. If a key detail is missing to even begin, ask for it briefly.

2. Form hypotheses. List the most likely causes, ordered by probability given the symptom and the code, and be explicit about your reasoning.

3. Investigate to confirm or rule out. Read the relevant code, trace the data and control flow, and check the leading hypotheses against what the code actually does. Prefer evidence from the code over speculation.

4. Ask only what you need. If you need a reproduction, logs, environment details, or a specific value to narrow it down, ask for the minimum required — in small batches — rather than guessing.

5. Identify the root cause. Before touching any code, state the actual cause and the evidence for it, and distinguish the root cause from its symptoms.

6. Only then propose a fix — the smallest change that addresses the root cause, plus how to verify it. Do not start editing code until the cause is confirmed or the user asks you to.

Respond in the same language the user uses.`,
  },
  {
    id: 'session.weigh.visible',
    title: 'Weigh Options Visible Prompt',
    group: 'Session',
    description: 'Visible user message sent by the /weigh command.',
    template: 'Help me decide how to approach this.',
  },
  {
    id: 'session.weigh.instructions',
    title: 'Weigh Options Instructions',
    group: 'Session',
    description: 'Hidden instructions attached to the /weigh command. Investigates the code, then compares distinct approaches with trade-offs and a recommendation — no plan, no code.',
    template: `The user knows WHAT they want to do but not HOW to approach it. Help them choose a direction — this is about weighing options and recommending one, not producing a detailed plan and not writing code.

Whenever you ask the user a question, use the \`question\` tool. Do not ask questions in plain assistant text.

First, investigate. Once the user describes the goal, read the relevant code, existing patterns, and constraints so your options are grounded in this codebase rather than generic advice. Make sure you actually understand what they are trying to achieve and why. Ask a clarifying question only if a key constraint is missing and would actually change the options.

Then lay out 2-3 genuinely distinct approaches — real alternatives, not minor variations of one idea. Include the approaches that properly deliver what the user wants, even when they are more involved; never leave out a strong option just because it is harder to build. For each, cover:
- what it involves, in a sentence or two
- how well it actually satisfies the user's goal — does it fully solve it, or only partially?
- how it fits (or fights) the existing patterns in this codebase
- trade-offs and consequences: complexity, risk, blast radius, effort, long-term maintainability
- when it is the right choice

Then give a clear recommendation. Anchor it on what best serves the user's actual need and intent — NOT on whatever is fastest, easiest, or the path of least resistance. Effort and complexity are consequences to lay out honestly, never reasons to steer the user toward a weaker option. Never recommend a watered-down or partial solution just because the proper one is more work: if the approach that truly fits is also the hard one, recommend it and be upfront about what it will cost. Favor a simpler option only when it genuinely meets the goal about as well. State which one you would pick and why, and name what would change your mind (for example, "go with A unless you expect X, in which case B").

Keep it concrete and scannable. Do not start implementing and do not write a step-by-step plan — once the user picks a direction, they can take it into planning or build it directly.

Respond in the same language the user uses.`,
  },
  {
    id: 'session.explore.visible',
    title: 'Codebase Tour Visible Prompt',
    group: 'Session',
    description: 'Visible user message sent by the /explore command.',
    template: 'Give me a high-level tour of this codebase.',
  },
  {
    id: 'session.explore.instructions',
    title: 'Codebase Tour Instructions',
    group: 'Session',
    description: 'Hidden instructions attached to the /explore command. Investigates the repository and gives a structured orientation rather than a file-by-file dump.',
    template: `The user wants to get oriented in this codebase — a high-level tour, as if you were onboarding a new contributor. Investigate first, then explain; do not guess from file or symbol names alone.

Explore the actual repository: entry points, the top-level structure, how it is built and run, and the main modules and how they connect. Read enough real code to be accurate.

Then give a clear orientation covering:
- The big picture: what this project is and how it is structured at a high level.
- Main parts: the key modules, packages, or directories, what each is responsible for, and where they live.
- How it fits together: the main flow — how a request or action moves through the system, and how the pieces talk to each other.
- Conventions worth knowing: notable patterns, where shared code, types, and config live, and anything non-obvious a newcomer would trip on.
- Where to start: a few concrete pointers for finding your way around or making a first change.

Keep it a readable orientation, not an exhaustive file-by-file dump — favor the structure and the mental model over listing everything. Lead with the big picture, then drill down. If the user named a specific area, focus the tour there.

Respond in the same language the user uses.`,
  },
  {
    id: 'session.fusion.visible',
    title: 'Fusion Visible Prompt',
    group: 'Session',
    description: 'Visible user message for multi-run fusion sessions.',
    template: 'Create the best combined answer from the multi-run results.',
  },
  {
    id: 'session.fusion.instructions',
    title: 'Fusion Instructions',
    group: 'Session',
    description: 'Hidden instructions used before multi-run source outputs in fusion sessions.',
    template: `You are performing fusion over multiple model outputs from the same original task.

Goal: produce the strongest possible final answer by combining complementary information, resolving conflicts, removing duplicates, and preserving useful nuance.

Use the results below as source material. Do not mention that the inputs were hidden parts. If sources disagree, prefer the most specific, well-supported, and internally consistent answer.

--- FUSION INPUTS START ---`,
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
    inFlightOverridesRequest = runtimeFetch(API_ENDPOINT, {
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

const getEffectiveMagicPromptTemplate = async (id: MagicPromptId): Promise<string> => {
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
  const response = await runtimeFetch(`${API_ENDPOINT}/${encodeURIComponent(id)}`, {
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
  const response = await runtimeFetch(`${API_ENDPOINT}/${encodeURIComponent(id)}`, {
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
  const response = await runtimeFetch(API_ENDPOINT, {
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
