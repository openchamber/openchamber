export const meta = { name: 'split-large-files', description: 'Split large source files into focused modules under the behavior net, one worktree per file', phases: ['Net', 'Split', 'Verify', 'Review', 'Fix', 'Land'] };

const files = args.files ?? [];
const models = { net: 'claude-agent/opus', split: 'claude-agent/sonnet', verify: 'opencode-go/deepseek-v4.1-flash', review: 'openai/gpt-6.1-sol', land: 'claude-agent/sonnet', ...(args.models ?? {}) };
const width = args.width ?? 2;

const slug = (file) => file.split('/').pop().replace(/\.[a-z]+$/, '').replace(/[^A-Za-z0-9]+/g, '-').toLowerCase();
const place = (file) => `Work only in the git worktree for this file. If it does not exist, create it: git worktree add -b split/${slug(file)} ../split-${slug(file)} bohdan/dev, then bun install there. Its path is the sibling folder split-${slug(file)} of the main checkout. Never edit the main checkout, never push.`;

const verdict = { type: 'object', properties: { ok: { type: 'boolean' }, summary: { type: 'string' }, problems: { type: 'array', items: { type: 'string' } } }, required: ['ok', 'summary', 'problems'] };

const net = (_, file) => agent(`${place(file)}\n\nFile to be split later: ${file}. Do not split it. Read .agents/skills/openchamber-change-discipline (Refactoring under the behavior net) and scripts/verify/DOCUMENTATION.md. List every behavior a user can reach that lives in this file. For each one no scenario plays, add a scenario to the right zone in scripts/verify/zones, green three times in a row on the unchanged code, and prove it catches by breaking that behavior in the file, seeing red, and reverting (git diff of the file empty at the end). If no zone lists this file, add it to the fitting zone or create one. Commit as test(verify): ... . Answer ok=false when a behavior could not be covered, with the reason in problems; ok=true with the zone names to run in summary.`, { label: `net ${slug(file)}`, phase: 'Net', model: models.net, schema: verdict });

const split = (prev, file) => prev && agent(`${place(file)}\n\nSplit ${file} into modules without changing behavior. Read AGENTS.md and the openchamber-change-discipline skill first. Only move code: no logic change, no new dependency, the file's public exports and props stay as they are. Done means: the original file only composes parts (no leftover body that is the old component with pieces removed), every module has one responsibility its name states, no file is over 800 lines, and bun run check:changed passes in full, including dead code and lint. Update a test or doc only where the move requires it. Commit as refactor(...): ... . Zones the coordinator will play after you: ${prev.summary}. Do not run bun run verify yourself. Answer ok=true with the list of new files and their line counts in summary, or ok=false with what stopped you.`, { label: `split ${slug(file)}`, phase: 'Split', model: models.split, schema: verdict });

const verify = (prev, file) => prev && prev.ok && agent(`${place(file)}\n\nRun exactly these two commands in the worktree and report their result, changing no file: (1) bun run check:changed (2) bun run verify -- <the zones named here: ${prev.summary}>. If the split step did not name zones, run bun run verify -- --list and pick the zones whose sources include ${file} or the folder its modules moved to. ok=true only when both exit with code 0. In problems put each failing check or scenario with the line the command printed for it.`, { label: `verify ${slug(file)}`, phase: 'Verify', model: models.verify, schema: verdict });

const review = (prev, file) => prev && agent(`${place(file)}\n\nRead-only review of the last refactor commit on this branch against the commit before the scenarios and the split (git log shows them). It claims to be a pure move of ${file} into modules. Find where that is false: a changed condition, dependency array, hook order, default, memoization boundary, ref identity, effect cleanup, CSS text, a module-level singleton that became per-instance or the reverse, a dropped or renamed export. Then judge the cut: does the original file only compose parts, and does each module have one responsibility? Checks reported by the previous step: ${prev.ok ? 'all green' : prev.problems.join('; ')}. ok=true only with zero behavior changes, an acceptable cut and green checks. Put every finding in problems with file and line.`, { label: `review ${slug(file)}`, phase: 'Review', model: models.review, schema: verdict });

const fix = (prev, file) => {
  if (!prev) return null;
  if (prev.ok) return prev;
  return agent(`${place(file)}\n\nThe split of ${file} on this branch did not pass. Fix exactly these findings, with the smallest change, keeping it a pure move:\n- ${prev.problems.join('\n- ')}\nThen run bun run check:changed and bun run verify for the file's zones until both are green, and amend nothing: add one commit. Answer ok=true only when both commands exit 0 and every finding is fixed or shown wrong with evidence.`, { label: `fix ${slug(file)}`, phase: 'Fix', model: models.split, schema: verdict });
};

const results = [];
for (let start = 0; start < files.length; start += width) {
  const batch = files.slice(start, start + width);
  log(`Files ${start + 1}-${start + batch.length} of ${files.length}`);
  const done = await pipeline(batch, net, split, verify, review, fix);
  batch.forEach((file, index) => results.push({ file, ok: Boolean(done[index] && done[index].ok), note: done[index] ? done[index].summary : 'a step failed' }));
}

phase('Land');
const ready = results.filter((result) => result.ok).map((result) => result.file);
const landed = ready.length === 0 ? null : await agent(`In the main checkout on branch bohdan/dev, bring in these finished branches one at a time, in this order: ${ready.map((file) => `split/${slug(file)} (${file})`).join(', ')}. For each: git cherry-pick its commits onto bohdan/dev. The zone files under scripts/verify/zones and scripts/verify/vocabulary.json are edited by several branches: resolve those conflicts by keeping both sides' scenarios and names. Any other conflict means stop that branch, abort its cherry-pick and name it in problems. After all are in, run bun run check:changed and bun run verify once; if either is red, find the branch that caused it, revert its commits and name it in problems. Do not push. ok=true when everything named landed green.`, { label: 'land', model: models.land, schema: verdict });

return { split: results, landed };
