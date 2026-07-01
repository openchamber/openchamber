#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PROJECT_NAME = "openchamber-monorepo";
const RUNS_DIR = join(process.cwd(), ".tmp", "react-doctor", "runs");

const PRIORITY_RULES = new Map([
  ["effect-needs-cleanup", 100],
  ["no-mutable-in-deps", 95],
  ["click-events-have-key-events", 90],
  ["no-static-element-interactions", 88],
  ["no-direct-state-mutation", 86],
  ["no-secrets-in-client-code", 85],
  ["no-danger", 84],
  ["no-prevent-default", 82],
  ["async-await-in-loop", 80],
  ["server-sequential-independent-await", 80],
  ["async-parallel", 78],
  ["async-defer-await", 76],
  ["js-set-map-lookups", 75],
  ["js-index-maps", 74],
  ["js-cache-property-access", 72],
  ["advanced-event-handler-refs", 70],
  ["client-passive-event-listeners", 70],
  ["js-combine-iterations", 68],
  ["js-flatmap-filter", 66],
  ["js-batch-dom-css", 66],
  ["js-cache-storage", 64],
  ["js-hoist-intl", 64],
  ["js-hoist-regexp", 64],
  ["js-length-check-first", 64],
  ["js-min-max-loop", 64],
  ["js-tosorted-immutable", 62],
  ["no-fetch-in-effect", 62],
  ["rerender-state-only-in-handlers", 62],
  ["rerender-functional-setstate", 60],
  ["rerender-lazy-state-init", 60],
  ["rerender-memo-before-early-return", 60],
  ["rerender-memo-with-default-value", 60],
  ["rendering-hydration-mismatch-time", 58],
  ["rendering-hydration-no-flicker", 58],
  ["rendering-usetransition-loading", 58],
  ["rendering-conditional-render", 56],
  ["rendering-svg-precision", 56],
  ["no-unknown-property", 55],
  ["no-autofocus", 54],
  ["no-array-index-as-key", 52],
  ["no-react19-deprecated-apis", 52],
  ["client-localstorage-no-version", 50],
  ["no-dynamic-import-path", 50],
  ["no-flush-sync", 50],
  ["no-long-transition-duration", 48],
  ["no-tiny-text", 48],
  ["prefer-dynamic-import", 48],
  ["use-lazy-motion", 48],
  ["duplicates", 45],
  ["no-barrel-import", 45],
  ["no-derived-useState", 44],
  ["no-derived-state-effect", 42],
  ["no-effect-chain", 42],
  ["no-effect-event-handler", 42],
  ["no-mirror-prop-effect", 42],
  ["no-prop-callback-in-effect", 42],
  ["prefer-use-effect-event", 42],
  ["no-cascading-set-state", 40],
  ["no-usememo-simple-expression", 40],
  ["design-no-redundant-size-axes", 35],
  ["design-no-redundant-padding-axes", 35],
  ["design-no-em-dash-in-jsx-text", 34],
  ["design-no-space-on-flex-children", 34],
  ["design-no-three-period-ellipsis", 34],
  ["no-inline-prop-on-memo-component", 32],
  ["no-many-boolean-props", 30],
  ["no-polymorphic-children", 30],
  ["no-render-in-render", 28],
  ["prefer-useReducer", 26],
  ["no-generic-handler-names", 24],
  ["no-giant-component", 15],
  ["exports", 10],
  ["types", 10],
  ["files", 5],
]);

function usage(exitCode = 0) {
  const out = exitCode === 0 ? console.log : console.error;
  out(`Usage:
  bun run doctor -- next-batch [--min-issues 75] [--max-issues 120] [--max-files 4]
  bun run doctor -- check-batch --run <run-id>
  bun run doctor -- file <path>
  bun run doctor -- top [--limit 10]

Examples:
  bun run doctor -- next-batch --min-issues 75 --max-issues 120
  bun run doctor -- file packages/ui/src/components/chat/ChatInput.tsx
  bun run doctor -- check-batch --run 2026-05-14T12-31-44`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      args._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    i += 1;
  }
  return args;
}

function asPositiveInt(value, fallback, name) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid --${name}: expected a positive integer.`);
  }
  return parsed;
}

function runReactDoctor() {
  const output = execFileSync(
    "npx",
    [
      "react-doctor@latest",
      "--project",
      PROJECT_NAME,
      "--json",
      "--offline",
      "--fail-on",
      "none",
    ],
    { cwd: process.cwd(), encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] },
  );
  return JSON.parse(output);
}

function allDiagnostics(report) {
  return report.diagnostics ?? report.projects?.flatMap((project) => project.diagnostics ?? []) ?? [];
}

function groupByFile(diagnostics) {
  const byFile = new Map();
  for (const diagnostic of diagnostics) {
    const list = byFile.get(diagnostic.filePath) ?? [];
    list.push(diagnostic);
    byFile.set(diagnostic.filePath, list);
  }
  return byFile;
}

function rulePriority(rule) {
  return PRIORITY_RULES.get(rule) ?? 50;
}

function filePriority(diagnostics) {
  const usefulScore = diagnostics.reduce((sum, diagnostic) => sum + rulePriority(diagnostic.rule), 0);
  const noisyCount = diagnostics.filter((diagnostic) => rulePriority(diagnostic.rule) <= 35).length;
  const highSignalCount = diagnostics.filter((diagnostic) => rulePriority(diagnostic.rule) >= 66).length;
  const noisyRatio = diagnostics.length === 0 ? 0 : noisyCount / diagnostics.length;
  const noisyPenalty = noisyRatio > 0.5 ? diagnostics.length * 35 : noisyCount * 8;
  return usefulScore + highSignalCount * 25 - noisyPenalty;
}

function sortedFileEntries(diagnostics) {
  return [...groupByFile(diagnostics).entries()].sort((a, b) => {
    const scoreDiff = filePriority(b[1]) - filePriority(a[1]);
    if (scoreDiff !== 0) return scoreDiff;
    const countDiff = b[1].length - a[1].length;
    if (countDiff !== 0) return countDiff;
    return a[0].localeCompare(b[0]);
  });
}

function summarizeRules(diagnostics) {
  const counts = new Map();
  for (const diagnostic of diagnostics) {
    const key = `${diagnostic.category} / ${diagnostic.rule}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function summarizeCategories(diagnostics) {
  const counts = new Map();
  for (const diagnostic of diagnostics) {
    counts.set(diagnostic.category, (counts.get(diagnostic.category) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function createRunId() {
  return new Date().toISOString().replace(/:/g, "-").replace(/\.\d{3}Z$/, "Z");
}

function titleCase(value) {
  return value
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .trim();
}

function fileNameWithoutExtension(filePath) {
  const fileName = filePath.split("/").at(-1) ?? filePath;
  return fileName.replace(/\.[^.]+$/, "");
}

function slugify(value) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function createBatchMetadata(runId, selectedFiles) {
  const [datePart, timePart = ""] = runId.replace(/Z$/, "").split("T");
  const timestamp = `${datePart.replace(/-/g, "")}-${timePart.replace(/-/g, "")}`;
  const stems = selectedFiles.map((file) => fileNameWithoutExtension(file.filePath));
  const readableArea = stems.length === 1 ? stems[0] : `${stems.slice(0, 2).join(" and ")}${stems.length > 2 ? ` plus ${stems.length - 2}` : ""}`;
  const areaSlug = slugify(stems.slice(0, 3).join("-")) || "batch";
  const batchName = `rd-${timestamp}-${areaSlug}`;

  return {
    batchName,
    branchName: `react-doctor/${batchName}`,
    prTitle: `Reduce React Doctor diagnostics in ${titleCase(readableArea)}`,
  };
}

function selectBatch(entries, minIssues, maxIssues, maxFiles) {
  if (entries.length === 0) return { selected: [], oversized: false, belowTarget: false, reason: "No diagnostics found." };

  const firstFitting = entries.find(([, diagnostics]) => diagnostics.length >= minIssues && diagnostics.length <= maxIssues);
  if (firstFitting) {
    return {
      selected: [firstFitting],
      oversized: false,
      belowTarget: false,
      reason: "A prioritized file already fits the target window.",
    };
  }

  const oversized = entries.find(([, diagnostics]) => diagnostics.length > maxIssues);
  if (oversized) {
    return {
      selected: [oversized],
      oversized: true,
      belowTarget: false,
      reason: "A prioritized file exceeds the target window and was selected as a single complete-file batch.",
    };
  }

  const selected = [];
  let total = 0;
  for (const entry of entries) {
    if (selected.length >= maxFiles) break;
    const count = entry[1].length;
    if (total + count > maxIssues) {
      if (total >= minIssues) break;
      continue;
    }
    selected.push(entry);
    total += count;
    if (total >= minIssues) break;
  }

  if (selected.length > 0) {
    return {
      selected,
      oversized: false,
      belowTarget: total < minIssues,
      reason: total >= minIssues
        ? "Added complete files until the batch reached the target window."
        : "No combination reached the minimum without exceeding the maximum; selected the best smaller complete-file batch.",
    };
  }

  return {
    selected: [entries[0]],
    oversized: false,
    belowTarget: entries[0][1].length < minIssues,
    reason: "Selected the best available complete file below the target window.",
  };
}

function writeRun(runId, payload) {
  const dir = join(RUNS_DIR, runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "baseline.json"), `${JSON.stringify(payload.report, null, 2)}\n`);
  writeFileSync(join(dir, "batch.json"), `${JSON.stringify(payload.batch, null, 2)}\n`);
  return dir;
}

function readRun(runId) {
  const dir = join(RUNS_DIR, runId);
  const baselinePath = join(dir, "baseline.json");
  const batchPath = join(dir, "batch.json");
  if (!existsSync(baselinePath) || !existsSync(batchPath)) {
    throw new Error(`Unknown run: ${runId}`);
  }
  return {
    baseline: JSON.parse(readFileSync(baselinePath, "utf8")),
    batch: JSON.parse(readFileSync(batchPath, "utf8")),
  };
}

function printReportHeader(report) {
  const summary = report.summary ?? {};
  console.log(`Repository score: ${summary.score ?? "unknown"} / 100 ${summary.scoreLabel ?? ""}`.trim());
  console.log(`Total diagnostics: ${summary.totalDiagnosticCount ?? allDiagnostics(report).length} issues across ${summary.affectedFileCount ?? "unknown"} files`);
  console.log(`Severity: ${summary.errorCount ?? 0} errors, ${summary.warningCount ?? 0} warnings`);
}

function printDiagnostics(diagnostics, limit = diagnostics.length) {
  for (const diagnostic of diagnostics.slice(0, limit)) {
    console.log(`line ${diagnostic.line ?? "?"}:${diagnostic.column ?? "?"}  ${diagnostic.severity}  ${diagnostic.category} / ${diagnostic.rule}`);
    console.log(`  ${diagnostic.message}`);
    if (diagnostic.help && diagnostic.help !== diagnostic.message) console.log(`  Help: ${diagnostic.help}`);
  }
}

function commandNextBatch(args) {
  const minIssues = asPositiveInt(args["min-issues"], 75, "min-issues");
  const maxIssues = asPositiveInt(args["max-issues"], 120, "max-issues");
  const maxFiles = asPositiveInt(args["max-files"], 4, "max-files");
  if (minIssues > maxIssues) throw new Error("--min-issues cannot be greater than --max-issues.");

  const report = runReactDoctor();
  const diagnostics = allDiagnostics(report);
  const entries = sortedFileEntries(diagnostics);
  const selection = selectBatch(entries, minIssues, maxIssues, maxFiles);
  const runId = createRunId();
  const selectedFiles = selection.selected.map(([filePath, fileDiagnostics]) => ({
    filePath,
    diagnosticCount: fileDiagnostics.length,
    rules: summarizeRules(fileDiagnostics),
  }));
  const metadata = createBatchMetadata(runId, selectedFiles);
  const batch = { runId, ...metadata, minIssues, maxIssues, maxFiles, selectedFiles, oversized: selection.oversized, belowTarget: selection.belowTarget, reason: selection.reason };
  const runDir = writeRun(runId, { report, batch });

  console.log("React Doctor Next Batch");
  console.log("");
  console.log(`Run ID: ${runId}`);
  console.log(`Batch name: ${batch.batchName}`);
  console.log(`Branch name: ${batch.branchName}`);
  console.log(`PR title: ${batch.prTitle}`);
  console.log(`Baseline: ${join(runDir, "baseline.json")}`);
  console.log(`Batch metadata: ${join(runDir, "batch.json")}`);
  console.log("");
  printReportHeader(report);
  console.log("");
  console.log(`Batch window: ${minIssues}-${maxIssues} diagnostics`);
  console.log(`Selection mode: complete files only`);
  console.log(`Batch total: ${selectedFiles.reduce((sum, file) => sum + file.diagnosticCount, 0)} diagnostics`);
  console.log(`Oversized: ${selection.oversized ? "yes" : "no"}`);
  console.log(`Below target: ${selection.belowTarget ? "yes" : "no"}`);
  console.log(`Selection reason: ${selection.reason}`);
  console.log("");
  console.log("Selected files:");
  selection.selected.forEach(([filePath, fileDiagnostics], index) => {
    console.log(`${index + 1}. ${filePath}`);
    console.log(`   Diagnostics: ${fileDiagnostics.length}`);
    console.log("   Categories: " + summarizeCategories(fileDiagnostics).map(([category, count]) => `${category} ${count}`).join(", "));
    console.log("   Rules:");
    for (const [rule, count] of summarizeRules(fileDiagnostics).slice(0, 10)) {
      console.log(`   ${String(count).padStart(3)}  ${rule}`);
    }
    console.log("   Diagnostics:");
    for (const diagnostic of fileDiagnostics) {
      console.log(`   line ${diagnostic.line ?? "?"}:${diagnostic.column ?? "?"}  ${diagnostic.severity}  ${diagnostic.category} / ${diagnostic.rule}`);
      console.log(`     ${diagnostic.message}`);
    }
    console.log("");
  });
}

function commandTop(args) {
  const limit = asPositiveInt(args.limit, 10, "limit");
  const report = runReactDoctor();
  const entries = sortedFileEntries(allDiagnostics(report)).slice(0, limit);
  console.log(`Top ${limit} files by prioritized React Doctor diagnostics`);
  console.log("");
  for (const [filePath, diagnostics] of entries) {
    console.log(`${String(diagnostics.length).padStart(4)}  ${filePath}`);
    console.log(`      ${summarizeCategories(diagnostics).map(([category, count]) => `${category} ${count}`).join(", ")}`);
  }
}

function commandFile(args) {
  const filePath = args._[1];
  if (!filePath) throw new Error("Missing file path. Usage: bun run doctor -- file <path>");
  const report = runReactDoctor();
  const diagnostics = groupByFile(allDiagnostics(report)).get(filePath) ?? [];
  console.log(filePath);
  console.log(`${diagnostics.length} issues`);
  console.log("");
  if (diagnostics.length === 0) return;
  console.log("Rules:");
  for (const [rule, count] of summarizeRules(diagnostics)) {
    console.log(`${String(count).padStart(4)}  ${rule}`);
  }
  console.log("");
  console.log("Issues:");
  printDiagnostics(diagnostics);
}

function commandCheckBatch(args) {
  const runId = args.run;
  if (!runId || runId === true) throw new Error("Missing --run <run-id>.");
  const { baseline, batch } = readRun(runId);
  const current = runReactDoctor();
  const beforeByFile = groupByFile(allDiagnostics(baseline));
  const afterByFile = groupByFile(allDiagnostics(current));
  const selected = batch.selectedFiles ?? [];
  let beforeTotal = 0;
  let afterTotal = 0;

  console.log("React Doctor Batch Check");
  console.log("");
  console.log(`Run ID: ${runId}`);
  if (batch.batchName) console.log(`Batch name: ${batch.batchName}`);
  if (batch.branchName) console.log(`Branch name: ${batch.branchName}`);
  if (batch.prTitle) console.log(`PR title: ${batch.prTitle}`);
  console.log("");
  console.log("Selected files:");
  for (const file of selected) {
    const before = beforeByFile.get(file.filePath)?.length ?? 0;
    const after = afterByFile.get(file.filePath)?.length ?? 0;
    beforeTotal += before;
    afterTotal += after;
    console.log(file.filePath);
    console.log(`  Before: ${before}`);
    console.log(`  After:  ${after}`);
    console.log(`  Delta:  ${after - before}`);
  }

  const selectedPaths = new Set(selected.map((file) => file.filePath));
  const beforeOutside = allDiagnostics(baseline).filter((diagnostic) => !selectedPaths.has(diagnostic.filePath)).length;
  const afterOutside = allDiagnostics(current).filter((diagnostic) => !selectedPaths.has(diagnostic.filePath)).length;

  console.log("");
  console.log("Batch result:");
  console.log(`Fixed diagnostics in selected files: ${Math.max(0, beforeTotal - afterTotal)}`);
  console.log(`Remaining diagnostics in selected files: ${afterTotal}`);
  console.log(`Diagnostics outside selected files delta: ${afterOutside - beforeOutside}`);
  console.log("");
  console.log("Current repository summary:");
  printReportHeader(current);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  if (!command || command === "help" || args.help) usage(0);

  switch (command) {
    case "next-batch":
      commandNextBatch(args);
      break;
    case "top":
      commandTop(args);
      break;
    case "file":
      commandFile(args);
      break;
    case "check-batch":
      commandCheckBatch(args);
      break;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
