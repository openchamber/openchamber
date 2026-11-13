#!/usr/bin/env node
// Compares judges on the same runs: per model, each judge's mean score, and how
// much each judge lifts its own model above the other judges' view of it.
//
//   node scripts/model-bench/cross-judge.mjs <judgeName>=<workflow-run-id>[:<key>] ...
//
// A workflow result is either { code, review } or { <key>: { code, review } }.
// Runs whose event log fetched the public repository are left out.

import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = os.homedir();
const cache = path.join(home, '.cache/openchamber-model-bench');
const map = new Map(readFileSync(path.join(cache, 'judge-map.txt'), 'utf8').trim().split('\n').map((l) => l.split(' ')));
const REMOTE_REPO = /github\.com\/[\w.-]+\/openchamber|githubusercontent\.com\/[\w.-]+\/openchamber|repos\/[\w.-]+\/openchamber|gh (api|pr|search|repo|browse)\b/i;
const leaked = new Set([...map].filter(([, run]) => readFileSync(path.join(cache, 'results', run, 'events.jsonl'), 'utf8')
  .split('\n').some((line) => { try { const ev = JSON.parse(line); return ev.type === 'tool_use' && REMOTE_REPO.test(JSON.stringify(ev.part?.state?.input ?? {})); } catch { return false; } }))
  .map(([id]) => id));
const modelOf = (id) => map.get(id).split('__')[1].replace(/_(medium|high)$/, '').replace(/^[^_]+_/, '');

// One judge's grades may come from several runs: name=runA:key+runB:key.
const judges = process.argv.slice(2).map((arg) => {
  const [name, refs] = arg.split('=');
  const grades = new Map();
  for (const ref of refs.split('+')) {
    const [runId, key] = ref.split(':');
    const run = JSON.parse(readFileSync(path.join(home, '.config/openchamber/workflow-runs', `${runId}.json`), 'utf8'));
    const result = key ? run.result[key] : run.result;
    for (const g of result.code ?? []) if (!g.failed) grades.set(g.id, { ...g, review: false });
    for (const g of result.review ?? []) if (!g.failed) grades.set(g.id, { ...g, review: true });
  }
  return { name, grades };
});

const shared = [...judges[0].grades.keys()].filter((id) => judges.every((j) => j.grades.has(id)) && !leaked.has(id));
const models = [...new Set(shared.map(modelOf))].sort();
const avg = (xs) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);
const table = (kind) => models.map((model) => {
  const ids = shared.filter((id) => modelOf(id) === model && judges[0].grades.get(id).review === (kind === 'review'));
  return { model, n: ids.length, ...Object.fromEntries(judges.map((j) => [j.name, avg(ids.map((id) => j.grades.get(id).total))])) };
});
const verdicts = models.map((model) => {
  const ids = shared.filter((id) => modelOf(id) === model && !judges[0].grades.get(id).review);
  return { model, ...Object.fromEntries(judges.map((j) => [j.name, ['merge', 'merge-after-small-fix', 'redo'].map((v) => ids.filter((id) => j.grades.get(id).verdict === v).length).join('/')])) };
});
const disagreements = shared.map((id) => {
  const totals = judges.map((j) => j.grades.get(id).total);
  return { id, model: modelOf(id), task: map.get(id).split('__')[0], spread: Math.max(...totals) - Math.min(...totals), ...Object.fromEntries(judges.map((j, i) => [j.name, totals[i]])) };
}).filter((d) => d.spread >= 4).sort((a, b) => b.spread - a.spread);

console.log(JSON.stringify({ leaked: [...leaked].map((id) => `${id} ${map.get(id).split('__2026')[0]}`), shared: shared.length, code: table('code'), review: table('review'), verdicts, disagreements }, null, 1));
