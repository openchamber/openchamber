export const meta = {
  name: 'pr-triage-review',
  description: 'Sweep the open OpenChamber PR queue, review every PR in the review pool with a skeptical scope pass, and write the decision report for the maintainer.',
  phases: ['Sweep', 'Review', 'Report'],
};

// args: { prs?: number[], skip?: string[], date?: 'YYYY-MM-DD', models?: { sweep?, review?, report? } }
// prs narrows the run to those PRs; skip leaves out PR numbers or author logins.
// Agree the models with the maintainer before the run.
const REPO = 'openchamber/openchamber';
const SKILL = '.agents/skills/triage-prs/SKILL.md';
const SOL = 'openai/gpt-6.1-sol';
const models = { sweep: SOL, review: SOL, report: SOL, ...(args.models || {}) };
const onlyPrs = Array.isArray(args.prs) ? args.prs.map(Number) : [];
const skip = Array.isArray(args.skip) ? args.skip.map(String) : [];
const prLink = (number) => `[#${number}](https://github.com/${REPO}/pull/${number})`;

const prRef = {
  type: 'object',
  properties: {
    number: { type: 'number' },
    title: { type: 'string' },
    author: { type: 'string' },
    note: { type: 'string' },
  },
  required: ['number', 'title', 'author', 'note'],
};

const sweepSchema = {
  type: 'object',
  properties: {
    date: { type: 'string' },
    openCount: { type: 'number' },
    team: { type: 'array', items: prRef },
    skipped: { type: 'array', items: prRef },
    keptDrafts: { type: 'array', items: prRef },
    waiting: { type: 'array', items: prRef },
    mechanicalCloses: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          number: { type: 'number' },
          title: { type: 'string' },
          author: { type: 'string' },
          template: { type: 'string', enum: ['stale-close', 'stale-draft', 'duplicate-close', 'russian-locale'] },
          note: { type: 'string' },
        },
        required: ['number', 'title', 'author', 'template', 'note'],
      },
    },
    duplicates: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          keeper: { type: 'number' },
          close: { type: 'array', items: { type: 'number' } },
          reason: { type: 'string' },
        },
        required: ['keeper', 'close', 'reason'],
      },
    },
    groups: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          prs: { type: 'array', items: { type: 'number' } },
          note: { type: 'string' },
        },
        required: ['prs', 'note'],
      },
    },
  },
  required: ['date', 'openCount', 'team', 'skipped', 'keptDrafts', 'waiting', 'mechanicalCloses', 'duplicates', 'groups'],
};

const verdictSchema = {
  type: 'object',
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          number: { type: 'number' },
          title: { type: 'string' },
          author: { type: 'string' },
          verdict: { type: 'string', enum: ['MERGE', 'MERGE-THEN-FIX', 'PUSH-BACK', 'DECLINE'] },
          threadState: {
            type: 'object',
            properties: {
              asked: { type: 'string' },
              answered: { type: 'string' },
              unresolved: { type: 'string' },
            },
            required: ['asked', 'answered', 'unresolved'],
          },
          productQuestion: { type: 'string' },
          standingDecision: { type: 'string' },
          summary: { type: 'string' },
          reasoning: { type: 'string' },
          scope: {
            type: 'object',
            properties: {
              hiddenProductDecision: { type: 'string' },
              coupling: { type: 'string' },
              proportion: { type: 'string' },
              slop: { type: 'string' },
            },
            required: ['hiddenProductDecision', 'coupling', 'proportion', 'slop'],
          },
          readyAction: { type: 'string' },
          closes: { type: 'array', items: { type: 'number' } },
          needsHands: { type: 'string' },
        },
        required: ['number', 'title', 'author', 'verdict', 'threadState', 'productQuestion', 'standingDecision', 'summary', 'reasoning', 'scope', 'readyAction', 'closes', 'needsHands'],
      },
    },
  },
  required: ['verdicts'],
};

phase('Sweep');
const scopeLine = onlyPrs.length > 0
  ? `Work only on these PRs: ${onlyPrs.map((number) => `#${number}`).join(', ')}. Every one of them that is still open lands in exactly one output list.`
  : 'Work on every open PR in the queue. Every open PR lands in exactly one output list.';
const sweep = await agent(`Run the mechanical sweep of the ${REPO} pull request queue. Read ${SKILL} first and follow its "Phase 1 — Mechanical sweep" exactly, including the timeline rule, the waiting-on-author bucket and the duplicate clusters. Read its "Standing decisions" too, so a PR that adds Russian localization goes to mechanicalCloses with template russian-locale.

${scopeLine}
${skip.length > 0 ? `Leave out, into "skipped" with a note, these PR numbers or author logins: ${skip.join(', ')}.` : ''}

This is read-only: gh and git reads, no comments, labels, closes, checkouts or edits. No subagents.

Fill the answer:
- date: today's date from \`date +%F\`.
- openCount: the open PR total you fetched (pass --limit above the queue size).
- team: PRs by the team authors the skill names, skipped from review.
- keptDrafts: drafts that stay untouched; note says why (recent commits, team).
- waiting: PRs waiting on the author; note says in a few words what was asked of them.
- mechanicalCloses: dead conflicted PRs (stale-close), stale drafts (stale-draft), the non-keepers of duplicate clusters (duplicate-close) and Russian localization (russian-locale); note gives the reason in a few words, and for duplicate-close the keeper's number.
- duplicates: each cluster with its keeper and the PRs to close.
- groups: every other PR, the review pool, split into review groups. Order the groups smallest diff first. Put related PRs (same area, a duplicate keeper with its context) in one group of at most 4, and give a large or contentious PR its own group. note names the shared area, and for each PR with human activity beyond the bots says "pickup mode: <what was asked or answered>".`, { label: 'Sweep the queue', phase: 'Sweep', model: models.sweep, schema: sweepSchema });

if (!sweep) throw new Error('The sweep agent gave no answer; nothing to review.');
const date = typeof args.date === 'string' && args.date ? args.date : sweep.date;
log(`Sweep: ${sweep.openCount} open, ${sweep.groups.length} review groups, ${sweep.mechanicalCloses.length} mechanical closes, ${sweep.waiting.length} waiting on author`);

const reviewPrompt = (numbers, note) => `Review these OpenChamber pull requests: ${numbers.map(prLink).join(', ')}.
${note ? `From the sweep: ${note}\n` : ''}
Follow your pull request instructions and the pr-review skill. Then read ${SKILL}: the "Skeptical scope pass" paragraph under Phase 3 and the "Standing decisions" section. Both apply to every PR here.

For each PR:
1. The correctness review the pr-review skill describes, with the symptom traced to the code the PR changes at its current head.
2. The skeptical scope pass for every PR you would MERGE or MERGE-THEN-FIX: answer the four questions (hidden product decision, coupling to a third-party plugin, tool, format or one user's setup, proportion, slop), each with file evidence or "none". A yes moves the verdict or lands on the action list.
3. A PR that contradicts a standing decision gets the verdict the decision implies; name the decision in standingDecision. Otherwise standingDecision is "".

Judge each PR on its merits: landing it is not the goal, and neither is closing it.

Fill one verdict per PR, every number above, none left out:
- summary: one or two plain Ukrainian sentences for the maintainer: what changes for the user and what the decision turns on.
- reasoning: the short Ukrainian reasoning paragraph from the skill.
- threadState: for a PR in pickup mode (a maintainer or trusted reviewer comment, or an author reply to one), in Ukrainian: asked (what the maintainer or reviewers asked for), answered (what the author answered or pushed since), unresolved (which points still stand at the current head). All three "" when the thread has no human exchange.
- productQuestion: the product question in Ukrainian, or "" for a plain bug fix.
- readyAction: the ready action in English, written to post or execute as is (close comment, push-back list, follow-up list, thank-you).
- closes: issue numbers the merge should close; needsHands: the gating manual check in Ukrainian, or "".
Review only: no comments, merges, checkouts, edits or pushes.`;

const reviewGroup = async (group) => {
  const label = `Review ${group.prs.map((number) => `#${number}`).join(' ')}`;
  const first = await agent(reviewPrompt(group.prs, group.note), { label, phase: 'Review', agent: 'review-pr', model: models.review, schema: verdictSchema });
  const verdicts = first ? first.verdicts.filter((verdict) => group.prs.includes(verdict.number)) : [];
  const missing = group.prs.filter((number) => !verdicts.some((verdict) => verdict.number === number));
  if (missing.length === 0) return { verdicts, missing };
  log(`${label}: no verdict for ${missing.map((number) => `#${number}`).join(' ')}, asking again`);
  const retry = await agent(reviewPrompt(missing, group.note), { label: `Review again ${missing.map((number) => `#${number}`).join(' ')}`, phase: 'Review', agent: 'review-pr', model: models.review, schema: verdictSchema });
  const recovered = retry ? retry.verdicts.filter((verdict) => missing.includes(verdict.number)) : [];
  return {
    verdicts: [...verdicts, ...recovered],
    missing: missing.filter((number) => !recovered.some((verdict) => verdict.number === number)),
  };
};

phase('Review');
const reviewed = await parallel(sweep.groups.map((group) => () => reviewGroup(group)));
const verdicts = reviewed.flatMap((result) => (result ? result.verdicts : []));
const unreviewed = sweep.groups.flatMap((group, index) => (reviewed[index] ? reviewed[index].missing : group.prs));
log(`Review: ${verdicts.length} verdicts, ${unreviewed.length} PRs without one`);

phase('Report');
const reportPath = `docs/personal/pr-triage/pr-triage-${date}-report.md`;
const report = await agent(`Write the PR triage report for the maintainer to ${reportPath}, in Ukrainian, from the data below only: do not review the PRs again. Read the "Report format" and "Standing decisions" parts of ${SKILL} and the communication-style skill first. The file is personal and gitignored: do not commit it.

Layout, in this order:
1. A first line with the date (${date}), the open total, how many were reviewed, and the review model (${models.review}).
2. "Продуктові рішення": every verdict with a non-empty productQuestion, whatever its verdict.
3. "Мерджимо як є": MERGE verdicts.
4. "Доробляємо самі": MERGE-THEN-FIX, then PUSH-BACK (say for each PUSH-BACK that the list can also go back to the author).
5. "Закриваємо": DECLINE verdicts, then the mechanical closes with their template name and duplicates with their keeper.
6. "Чекають автора": the waiting PRs with what was asked, then kept drafts, then team PRs, each one line.
7. "Без вердикту": PRs the reviews skipped, if any, so they can be dispatched again.
Each PR appears once: one listed in section 2 stays out of sections 3 to 5.

Each PR entry: for a verdict whose threadState.asked is not empty, first a line "Стан треду: питали ...; відповіли ...; лишилось ..." from threadState. Then the PR as a markdown link (${prLink(1234)} style) with its title and @author, then one or two plain sentences from summary (with the product question for section 2, the standing decision when one applied), then "**Моя рекомендація:** ..." in a few words, then a "needs your hands" line only when needsHands is set. Under every entry of sections 2 to 5 put readyAction verbatim in a quote block: it is the English text that will be posted, and the maintainer approves what they read. A trivial MERGE gets a few words.

Answer with the path and the per-section counts.

Sweep:
${JSON.stringify(sweep)}

Verdicts:
${JSON.stringify(verdicts)}

PRs without a verdict: ${JSON.stringify(unreviewed)}`, { label: 'Write the report', phase: 'Report', model: models.report });

return {
  date,
  report: reportPath,
  reportAgent: report,
  open: sweep.openCount,
  reviewed: verdicts.length,
  unreviewed,
  verdicts: verdicts.map((verdict) => `#${verdict.number} ${verdict.verdict}${verdict.productQuestion ? ' (product question)' : ''}`),
};
