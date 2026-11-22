export const meta = {
  name: 'pr-port',
  description: 'Carry contributor PRs that conflict with main onto current main unchanged in behavior, review each port for fidelity and defects, fix only what the port itself broke, and leave one commit per PR without pushing.',
  phases: ['Port', 'Review', 'Apply'],
};

// args: { prs: number[], briefs?: string, limit?: number, models?: { port?, review?, apply? } }
// A port is mechanical: the PR's own change, moved onto main as main is now
// (files renamed to TypeScript, large files split into modules). Nothing the
// PR did not do gets added. The review sorts findings into what the port
// broke (fixed here, on the same cheap model) and what the PR itself gets
// wrong or decides (returned to the coordinator, who decides who fixes it).
// Nothing here pushes or writes to GitHub.
const SKILL = '.agents/skills/triage-prs/SKILL.md';
const SOL = 'openai/gpt-6.2-sol';
const models = { port: SOL, review: SOL, apply: SOL, ...(args.models || {}) };
const requested = Array.isArray(args.prs) ? args.prs : [];
if (requested.length === 0 || !requested.every((number) => Number.isInteger(number) && number > 0)) {
  throw new Error('args.prs is required: a list of positive integer PR numbers');
}
const prs = [...new Set(requested)];
const briefs = typeof args.briefs === 'string' && args.briefs ? args.briefs : null;
const limit = Number.isInteger(args.limit) && args.limit > 0 ? args.limit : 3;

const worktree = (number) => `/tmp/triage/wt-${number}`;
const state = (number) => `/tmp/triage/st-${number}`;

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
  ? `If ${briefs} has a section for #${number}, it is binding for this PR: read it before anything else.`
  : '');

const workRules = (number) => `Rules for this work:
- Work only in ${worktree(number)}: every edit and every command runs there (set the shell's workdir). The main checkout belongs to the maintainer and other sessions; never edit it. Never run git stash.
- Start no OpenChamber or dev server, Electron, browser or simulator, and no subagents.
- Validate with the test files for the code you touched and \`bun run type-check\` in ${worktree(number)}, until both are green; then \`bun run check:changed\` once. Its last line must be "✓ All checks passed"; fix what it reports in the ported code (types, lint, ratchet, file size by putting new code in the module that owns it).
- No push, no gh writes.`;

const portSchema = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['PORTED', 'ON_MAIN', 'OBSOLETE', 'BLOCKED'] },
    commit: { type: 'string' },
    subject: { type: 'string' },
    summary: { type: 'string' },
    authorComment: { type: 'string' },
    closes: { type: 'array', items: { type: 'number' } },
    validation: { type: 'string' },
    notes: { type: 'string' },
    reason: { type: 'string' },
  },
  required: ['status', 'commit', 'subject', 'summary', 'authorComment', 'closes', 'validation', 'notes', 'reason'],
};

const findingsSchema = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['port', 'defect', 'scope'] },
          file: { type: 'string' },
          scenario: { type: 'string' },
          cause: { type: 'string' },
          fix: { type: 'string' },
        },
        required: ['kind', 'file', 'scenario', 'cause', 'fix'],
      },
    },
  },
  required: ['findings'],
};

const applySchema = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['PORTED', 'BLOCKED'] },
    commit: { type: 'string' },
    applied: { type: 'array', items: { type: 'string' } },
    declined: { type: 'array', items: { type: 'string' } },
    validation: { type: 'string' },
    notes: { type: 'string' },
    reason: { type: 'string' },
  },
  required: ['status', 'commit', 'applied', 'declined', 'validation', 'notes', 'reason'],
};

const port = (number) => limited(() => agent(`Port OpenChamber PR #${number} onto current main. It conflicts because main went through a large refactor after the PR was written: the server moved from JavaScript to TypeScript (a \`.js\` file is often \`.ts\` now), large files were split into modules in the same folder, and code moved between modules. Your job is mechanical: the PR's own change, carried onto main as main is now, with the same behavior. The PR's author keeps the credit.

Read ${SKILL} ("Landing a PR ourselves", "Fix agents", "Standing decisions"), then AGENTS.md and the DOCUMENTATION.md of each module the change lands in.
${briefLine(number)}

Steps:
1. From the main checkout run \`TRIAGE_WT=${worktree(number)} TRIAGE_STATE=${state(number)} .agents/skills/triage-prs/scripts/prep.sh ${number}\`. It stages the whole PR on current origin/main; on CONFLICTS, the conflicted files are yours to resolve.
2. Read the PR's own diff (\`gh pr diff ${number}\`) and description to know what it changes. For each hunk find where that code lives on main now (\`git log --follow\`, grep for the function or the string) and make the same change there. A file the PR edits that main deleted or renamed: carry the edit to its successor, and leave no resurrected copy of the old file.
3. Do not fix review comments, add features, refactor, or improve the PR. A defect you notice goes in notes, not in the code.
4. Validate as the rules below say, until green.
5. Stage everything (\`git add -A\`) and commit once as the author: \`git -c core.hooksPath=/dev/null commit --author="$(git log -1 --format='%an <%ae>' pr${number}-head)" -m "<conventional subject, no (#N)>"\`.

Stop early instead of porting when:
- ON_MAIN: main already does what the PR does (another PR or the refactor landed it). Name the commit or code that does it.
- OBSOLETE: the code path the PR changes no longer exists on main and the change has no meaningful successor.
- BLOCKED: carrying it needs a decision, not a translation (two plausible places with different behavior, a conflict with something main changed on purpose).

${workRules(number)}

Answer: status; commit (the sha, or ""); subject; summary (one or two plain Ukrainian sentences: what the PR does for a user and where it landed on main); authorComment (one or two English sentences to the author in the maintainer's voice, such as "Thanks, merging. I carried it onto the TypeScript server after the refactor." plus only what they don't know yet); closes (issue numbers the PR closes, from its body); validation (commands and results); notes (Ukrainian, defects you noticed and checks you could not run, or ""); reason ("" for PORTED; the evidence otherwise).`, { label: `Port #${number}`, phase: 'Port', agent: 'build', model: models.port, schema: portSchema }));

const review = (number, ported) => agent(`Review a local change: the commit ${ported.commit} at HEAD of the worktree ${worktree(number)} (\`git -C ${worktree(number)} show HEAD\`). It ports OpenChamber PR #${number} onto current main after a refactor (server JavaScript to TypeScript, large files split into modules). Read code under ${worktree(number)}; the main checkout is a different tree. The original change is \`gh pr diff ${number}\`.

Classify every finding:
- port: the port lost, duplicated, or changed something compared with the PR's own diff, or put a change in a place main no longer uses (a resurrected old file, a dead module, a hunk that silently dropped).
- defect: the PR's own change is wrong in a concrete scenario (it would be wrong on the old main too).
- scope: a hidden product decision, a part out of the PR's purpose, coupling to one user's setup, size out of proportion. Read "Skeptical scope pass" and "Standing decisions" in ${SKILL}.

Missing live runs, screenshots or per-platform evidence are not findings. Report concrete findings only, each with file, scenario, cause and what the fix has to do. An empty list when clean. No edits.`, { label: `Review #${number}`, phase: 'Review', agent: 'review-changes', model: models.review, schema: findingsSchema });

const apply = (number, ported, findings) => limited(() => agent(`A reviewer checked the commit at HEAD of ${worktree(number)}, which ports OpenChamber PR #${number} onto current main. Fix the findings below: each says where the port differs from the PR's own diff (\`gh pr diff ${number}\`). Confirm each against that diff first; decline one that is wrong, with evidence (file and line, command output). Make the port match the PR, nothing more.

Findings:
${JSON.stringify(findings, null, 2)}

When you changed anything, validate again and amend keeping the author: \`git add -A && git -c core.hooksPath=/dev/null commit --amend --no-edit\`.

${workRules(number)}

Answer: status; commit (the sha now at HEAD); applied and declined (one line each); validation; notes (Ukrainian or ""); reason ("" unless BLOCKED).`, { label: `Apply port fixes #${number}`, phase: 'Apply', agent: 'build', model: models.apply, schema: applySchema }));

const results = await pipeline(
  prs,
  (number) => port(number),
  async (ported, number) => {
    if (ported.status !== 'PORTED') return { ported, findings: null };
    const reviewed = (await review(number, ported)) || (await review(number, ported));
    if (!reviewed) {
      log(`#${number}: the review gave no answer twice`);
      return { ported: { ...ported, status: 'REVIEW_FAILED', reason: 'The review failed twice.' }, findings: null };
    }
    return { ported, findings: reviewed.findings };
  },
  async ({ ported, findings }, number) => {
    const portFindings = (findings || []).filter((finding) => finding.kind === 'port');
    const defects = (findings || []).filter((finding) => finding.kind === 'defect');
    const scope = (findings || []).filter((finding) => finding.kind === 'scope');
    const base = { number, ...ported, reviewed: findings !== null, defects, scope, applied: [], declined: [] };
    if (ported.status !== 'PORTED' || portFindings.length === 0) return base;
    const applied = await apply(number, ported, portFindings);
    if (!applied) return { ...base, status: 'FAILED', reason: 'The port-fix agent gave no answer.' };
    return {
      ...base,
      status: applied.status,
      commit: applied.commit,
      validation: applied.validation,
      notes: [ported.notes, applied.notes].filter(Boolean).join(' '),
      reason: applied.reason,
      applied: applied.applied,
      declined: applied.declined,
    };
  },
);

const finished = results.map((result, index) => result || { number: prs[index], status: 'FAILED', summary: 'An agent failed or gave no answer; see the run.' });
const count = (status) => finished.filter((result) => result.status === status).length;
log(`PORTED ${count('PORTED')}, ON_MAIN ${count('ON_MAIN')}, OBSOLETE ${count('OBSOLETE')}, BLOCKED ${count('BLOCKED')}, REVIEW_FAILED ${count('REVIEW_FAILED')}, FAILED ${count('FAILED')}`);
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
  reason: result.reason,
  defects: result.defects,
  scope: result.scope,
  declined: result.declined,
}));
