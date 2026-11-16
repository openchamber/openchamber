/** Pure goal-spec helpers for the writer dialog: a length estimate and the
 * old-versus-new line diff shown after a rewrite. Kept out of the component
 * file so its exports stay component-only (fast refresh). */

/** Cheap chars/4 heuristic - an estimate only, labelled as such in the UI; no tokenizer runs per keystroke. */
export const estimateGoalSpecTokens = (spec: string): number => Math.ceil(spec.length / 4);

/**
 * The `## heading` sections of a spec, in order — the units a per-section
 * rewrite (#1829) can target. Text before the first heading belongs to no
 * section. Mirrors the server writer's section shape in
 * packages/web/server/lib/session-goal/spec-writer.js.
 */
export const parseGoalSpecSections = (spec: string): { heading: string; body: string }[] => {
  const raw: { heading: string; lines: string[] }[] = [];
  for (const line of spec.split('\n')) {
    const heading = /^##[ \t]+(.+?)[ \t]*$/.exec(line);
    if (heading) raw.push({ heading: heading[1], lines: [] });
    else if (raw.length) raw[raw.length - 1].lines.push(line);
  }
  return raw.map((section) => ({ heading: section.heading, body: section.lines.join('\n').trim() }));
};

/** Just the headings a per-section rewrite can offer, in spec order. */
export const goalSpecSectionHeadings = (spec: string): string[] => parseGoalSpecSections(spec).map((section) => section.heading);

type GoalSpecDiffLine = { kind: 'same' | 'add' | 'remove'; text: string };

/**
 * Line diff between the spec a rewrite replaced and the spec it produced, so the
 * dialog can show what changed before it is accepted. Specs are a few thousand
 * characters at most, so the plain LCS table stays small.
 */
export const diffGoalSpecLines = (previous: string, next: string): GoalSpecDiffLine[] => {
  const before = previous === '' ? [] : previous.split('\n');
  const after = next === '' ? [] : next.split('\n');
  const lcs: number[][] = Array.from({ length: before.length + 1 }, () => new Array<number>(after.length + 1).fill(0));
  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      lcs[i][j] = before[i] === after[j]
        ? lcs[i + 1][j + 1] + 1
        : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const lines: GoalSpecDiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      lines.push({ kind: 'same', text: before[i] });
      i += 1;
      j += 1;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      lines.push({ kind: 'remove', text: before[i] });
      i += 1;
    } else {
      lines.push({ kind: 'add', text: after[j] });
      j += 1;
    }
  }
  while (i < before.length) { lines.push({ kind: 'remove', text: before[i] }); i += 1; }
  while (j < after.length) { lines.push({ kind: 'add', text: after[j] }); j += 1; }
  return lines;
};
