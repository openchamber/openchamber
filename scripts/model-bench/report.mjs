#!/usr/bin/env node
// Joins a judge workflow's grades with the run map and prints per-model tables.
//
//   node scripts/model-bench/report.mjs <workflow-run-id>
//
// Reads ~/.config/openchamber/workflow-runs/<id>.json and
// ~/.cache/openchamber-model-bench/judge-map.txt, appends the joined grades to
// ~/.config/openchamber/model-bench/judgments.jsonl, and prints JSON summaries.

import { appendFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const runId = process.argv[2];
if (!runId) {
  console.error('Usage: report.mjs <workflow-run-id>');
  process.exit(1);
}
const home = os.homedir();
const run = JSON.parse(readFileSync(path.join(home, '.config/openchamber/workflow-runs', `${runId}.json`), 'utf8'));
const { result } = run;
const map = new Map(readFileSync(path.join(home, '.cache/openchamber-model-bench/judge-map.txt'), 'utf8')
  .trim().split('\n').map((line) => line.split(' ')));
const records = new Map(readFileSync(path.join(home, '.config/openchamber/model-bench/results.jsonl'), 'utf8')
  .trim().split('\n').map((line) => JSON.parse(line)).map((r) => [path.basename(r.out), r]));

const grades = [...(result.code ?? []), ...(result.review ?? [])].map((g) => {
  const runDir = map.get(g.id);
  const record = records.get(runDir) ?? {};
  return { ...g, run: runDir, model: record.model?.replace(/#.*/, '').split('/').pop(), task: record.task, type: record.type, level: record.level, minutes: record.minutes };
});
appendFileSync(path.join(home, '.config/openchamber/model-bench/judgments.jsonl'),
  `${grades.map((g) => JSON.stringify({ judge: runId, ...g })).join('\n')}\n`);

const by = (list, key) => list.reduce((acc, g) => ((acc[g[key]] ??= []).push(g), acc), {});
const avg = (xs) => Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10;
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

const code = grades.filter((g) => g.type !== 'review' && !g.failed);
const review = grades.filter((g) => g.type === 'review' && !g.failed);
const summary = Object.entries(by(code, 'model')).map(([model, gs]) => {
  const rv = review.filter((g) => g.model === model);
  return {
    model,
    code: avg(gs.map((g) => g.total)),
    merge: gs.filter((g) => g.verdict === 'merge').length,
    fix: gs.filter((g) => g.verdict === 'merge-after-small-fix').length,
    redo: gs.filter((g) => g.verdict === 'redo').length,
    l3: avg(gs.filter((g) => g.level === 3).map((g) => g.total)),
    review: rv.length ? avg(rv.map((g) => g.total)) : null,
    reviewFound: rv.filter((g) => g.found >= 2).length + '/' + rv.length,
    medianMin: median([...gs, ...rv].map((g) => g.minutes)),
  };
}).sort((a, b) => b.code - a.code);
const perTask = Object.fromEntries(Object.entries(by(grades.filter((g) => !g.failed), 'task'))
  .map(([task, gs]) => [task, Object.fromEntries(Object.entries(by(gs, 'model')).map(([m, x]) => [m, x.map((g) => g.total).join('/')]))]));
console.log(JSON.stringify({ failed: grades.filter((g) => g.failed).map((g) => g.id), summary, perTask }, null, 1));
