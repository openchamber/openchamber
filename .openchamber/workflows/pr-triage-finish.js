export const meta = {
  name: 'pr-triage-finish',
  description: 'Finish contributor PRs the maintainer wants landed: fix each in its own worktree on current main, review the result, apply confirmed findings, and leave one ready commit per PR without pushing.',
  phases: ['Fix', 'Review', 'Apply'],
};

// args: { prs: number[], briefs?: string, limit?: number, models?: { fix?, review?, apply? } }
// briefs is a file with a section per PR ("#1234") carrying the maintainer's
// decisions and what to land. limit caps the PRs building at once (default 3).
// Nothing here pushes or writes to GitHub: the coordinator runs finish.sh per
// READY PR after the maintainer's go, which rebases onto current main first.
const SKILL = '.agents/skills/triage-prs/SKILL.md';
const SOL = 'openai/gpt-6.1-sol';
// The review runs on another model than the fix, so it reads what Sol read past.
const OPUS = 'claude-agent/opus#medium';
const models = { fix: SOL, review: OPUS, apply: SOL, ...(args.models || {}) };
const requested = Array.isArray(args.prs) ? args.prs : [];
if (requested.length === 0 || !requested.every((number) => Number.isInteger(number) && number > 0)) {
  throw new Error('args.prs is required: a list of positive integer PR numbers');
}
// One PR is one worktree: a repeated number would run two agents in it, and
// the second prep would wipe the first one's work.
const prs = [...new Set(requested)];
const briefs = typeof args.briefs === 'string' && args.briefs ? args.briefs : null;
const limit = Number.isInteger(args.limit) && args.limit > 0 ? args.limit : 3;

const worktree = (number) => `/tmp/triage/wt-${number}`;
const state = (number) => `/tmp/triage/st-${number}`;

// Build-heavy stages take a slot each; a freed slot goes straight to the next
// waiting PR, so at most `limit` type-checks and test runs share the machine.
const makeLimiter = (size) => {
  let active = 0;
  const waiting = [];
  const acquire = () => {
    if (active < size) {
      active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => waiting.push(resolve));
  };
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else active -= 1;
  };
  return async (task) => {
    await acquire();
    try {
      return await task();
    } finally {
      release();
    }
  };
};
const limited = makeLimiter(limit);

const briefLine = (number) => (briefs
  ? `Your brief is the section for #${number} in ${briefs}. It carries the maintainer's decisions for this PR, and they are binding: read it before anything else. If the file has no section for #${number}, stop and return BLOCKED.`
  : 'No brief was given: land the PR as its author meant it, fixing what its review threads and checks found. A product question you meet is the maintainer\'s: stop and return BLOCKED with it.');

const workRules = (number) => `Rules for this work:
- Work only in ${worktree(number)}: every edit and every command runs there (set the shell's workdir). The main checkout, this session's directory, belongs to the maintainer and other sessions; never edit it.
- Start no OpenChamber or dev server, Electron, browser or simulator, and no subagents. Review is the workflow's next step.
- Validate with the test files for the code you touched and \`bun run type-check\` in ${worktree(number)}, until both are green; then \`bun run check:changed\` once.
- No push, no gh writes (comments, labels, merges): the coordinator does those after the maintainer's go.
- READY with notes for checks you could not run (a live scenario, a device). BLOCKED only when the work itself cannot finish: a conflict that needs a product decision, a brief that contradicts the code, a PR whose code path main no longer has.`;

const resultSchema = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['READY', 'BLOCKED'] },
    commit: { type: 'string' },
    subject: { type: 'string' },
    summary: { type: 'string' },
    authorComment: { type: 'string' },
    closes: { type: 'array', items: { type: 'number' } },
    validation: { type: 'string' },
    notes: { type: 'string' },
    blocker: { type: 'string' },
  },
  required: ['status', 'commit', 'subject', 'summary', 'authorComment', 'closes', 'validation', 'notes', 'blocker'],
};

const findingsSchema = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          scenario: { type: 'string' },
          cause: { type: 'string' },
          fix: { type: 'string' },
        },
        required: ['file', 'scenario', 'cause', 'fix'],
      },
    },
  },
  required: ['findings'],
};

const applySchema = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['READY', 'BLOCKED'] },
    commit: { type: 'string' },
    applied: { type: 'array', items: { type: 'string' } },
    declined: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
    validation: { type: 'string' },
    notes: { type: 'string' },
    blocker: { type: 'string' },
  },
  required: ['status', 'commit', 'applied', 'declined', 'summary', 'validation', 'notes', 'blocker'],
};

const fix = (number) => limited(() => agent(`Land OpenChamber PR #${number} ourselves: finish it in one commit on current main, with the PR's author keeping the credit, so the maintainer can merge it.

Read ${SKILL} first: "Landing a PR ourselves", its "Fix agents" rules and "Standing decisions". Then AGENTS.md, and the project skills and DOCUMENTATION.md it routes the change to.

${briefLine(number)}

Steps:
1. From the main checkout run \`TRIAGE_WT=${worktree(number)} TRIAGE_STATE=${state(number)} .agents/skills/triage-prs/scripts/prep.sh ${number}\`. It creates the worktree if needed and stages the whole PR on current origin/main. On CONFLICTS, resolve each file in ${worktree(number)} against what main does now.
2. Read the PR's timeline (\`gh pr view ${number} --comments\`, its reviews and \`gh pr checks ${number}\`) and apply the brief. Take the essence; a concern you leave out is searched for in the whole staged diff and removed there too.
3. Validate as the rules below say, until green.
4. Stage everything (\`git add -A\`) and commit once as the author: \`git -c core.hooksPath=/dev/null commit --author="$(git log -1 --format='%an <%ae>' pr${number}-head)" -m "<conventional subject>"\`.

${workRules(number)}

Answer: status; commit (the sha); subject; summary (one or two plain Ukrainian sentences on what lands and what was left out); authorComment (one or two English sentences to the author in the maintainer's voice: thanks, plus only what they don't know yet, such as what we changed or dropped); closes (issue numbers the merge closes); validation (the commands you ran and their result); notes (checks left for the maintainer, in Ukrainian, or ""); blocker ("" unless BLOCKED).`, { label: `Fix #${number}`, phase: 'Fix', agent: 'build', model: models.fix, schema: resultSchema }));

const review = (number, fixed) => agent(`Review a local change: the commit ${fixed.commit} at HEAD of the worktree ${worktree(number)} (\`git -C ${worktree(number)} show HEAD\`), which lands OpenChamber PR #${number} on current main. Read the code around it with paths under ${worktree(number)}; the main checkout is a different tree.

${briefs ? `The maintainer's decisions for it are the section for #${number} in ${briefs}: a finding that argues against one of them is out of scope.` : ''}
Read the "Skeptical scope pass" paragraph and "Standing decisions" in ${SKILL}: a hidden product decision, coupling to a third-party plugin, tool, format or one user's setup, size out of proportion, or slop in this commit is a finding too.

Report concrete defects only, each with the file, the scenario, the cause and what the fix has to do. An empty list when the change is clean. No edits.`, { label: `Review #${number}`, phase: 'Review', agent: 'review-changes', model: models.review, schema: findingsSchema });

const apply = (number, fixed, findings) => limited(() => agent(`A reviewer checked the commit that lands OpenChamber PR #${number}, at HEAD of ${worktree(number)}. Weigh its findings and fix the confirmed ones.

Read "Answering Review Findings" in the openchamber-change-discipline skill and follow it: you own the change, the reviewer advises. Fix what is wrong in the case this PR is for, with the smallest fix; decline the rest with evidence (file and line, a test, command output).
${briefs ? `The maintainer's decisions in the section for #${number} of ${briefs} stand over any finding.` : ''}

Findings:
${JSON.stringify(findings, null, 2)}

When you changed anything, validate again and amend the commit keeping its author: \`git add -A && git -c core.hooksPath=/dev/null commit --amend --no-edit\`.

${workRules(number)}

Answer: status; commit (the sha now at HEAD); applied and declined (one line each, a declined one with its evidence); summary (one or two plain Ukrainian sentences on what the review changed); validation; notes; blocker.`, { label: `Apply review #${number}`, phase: 'Apply', agent: 'build', model: models.apply, schema: applySchema }));

const results = await pipeline(
  prs,
  (number) => fix(number),
  async (fixed, number) => {
    if (fixed.status !== 'READY') return { fixed, findings: null };
    const reviewed = (await review(number, fixed)) || (await review(number, fixed));
    if (!reviewed) {
      log(`#${number}: the review gave no answer twice; the commit is held back as REVIEW_FAILED`);
      return { fixed: { ...fixed, status: 'REVIEW_FAILED', blocker: 'The review failed twice: the commit has had no second look.' }, findings: null };
    }
    return { fixed, findings: reviewed.findings };
  },
  async ({ fixed, findings }, number) => {
    if (fixed.status !== 'READY' || findings.length === 0) {
      return { number, ...fixed, reviewed: findings !== null, applied: [], declined: [] };
    }
    const applied = await apply(number, fixed, findings);
    if (!applied) return null;
    return {
      number,
      ...fixed,
      status: applied.status,
      commit: applied.commit,
      summary: `${fixed.summary} ${applied.summary}`.trim(),
      validation: applied.validation,
      notes: [fixed.notes, applied.notes].filter(Boolean).join(' '),
      blocker: applied.blocker,
      reviewed: true,
      applied: applied.applied,
      declined: applied.declined,
    };
  },
);

const finished = results.map((result, index) => result || { number: prs[index], status: 'FAILED', summary: 'An agent failed or gave no answer; see the run.' });
const count = (status) => finished.filter((result) => result.status === status).length;
log(`READY ${count('READY')}, BLOCKED ${count('BLOCKED')}, REVIEW_FAILED ${count('REVIEW_FAILED')}, FAILED ${count('FAILED')}`);
return finished.map((result) => ({
  number: result.number,
  status: result.status,
  worktree: worktree(result.number),
  commit: result.commit,
  subject: result.subject,
  summary: result.summary,
  authorComment: result.authorComment,
  closes: result.closes,
  notes: result.notes,
  blocker: result.blocker,
  reviewed: result.reviewed,
  declined: result.declined,
}));
