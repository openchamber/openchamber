#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  claimedFilePaths,
  printClaims,
  readActiveClaims,
  releaseRun,
  resolveRunsDir,
  runDirPath,
} from "./lib/batch-claims.mjs";

const PIPELINE = "as";
// Resolved before command dispatch so every command shares one claims location.
const { runsDir: RUNS_DIR, shared: SHARED_CLAIMS } = resolveRunsDir(parseArgs(process.argv.slice(2))["claims-dir"]);
const DEFAULT_MAX_ACTIVE = 20;
const DEFAULT_CLAIM_TTL_DAYS = 3;

// Rules ordered by how mechanical and behavior-safe their fixes are. Higher
// scores are preferred when selecting the next batch.
const PRIORITY_RULES = new Map([
  ["no-object-parameters", 100],
  ["no-shape-in-symbol-names", 95],
  ["no-unknown-type-aliases", 90],
  ["no-unknown-returns", 85],
  ["no-unknown-parameters", 80],
  ["no-unsafe-dictionary-type", 75],
  ["no-conditional-empty-object-spread", 70],
  ["no-known-value-widening", 65],
  ["no-chained-type-assertions", 60],
  ["no-widen-then-assert", 55],
  ["no-reflect-get", 50],
  ["no-reflect-apply", 50],
  ["no-module-mocking", 30],
  ["require-safety-comment-for-type-assertion", 20],
  ["no-runtime-typeof", 10],
]);

// Excluded by default because they account for most of the existing backlog and
// their fixes are the least mechanical. Opt in with --include-noisy.
const NOISY_RULES = new Set(["no-runtime-typeof", "require-safety-comment-for-type-assertion"]);

function usage(exitCode = 0) {
  const out = exitCode === 0 ? console.log : console.error;
  out(`Usage:
  bun run deslop -- next-batch [--min-issues 60] [--max-issues 120] [--max-files 4]
                              [--max-active ${DEFAULT_MAX_ACTIVE}] [--claim-ttl ${DEFAULT_CLAIM_TTL_DAYS}] [--include-noisy]
  bun run deslop -- check-batch --run <run-id>
  bun run deslop -- active [--claim-ttl ${DEFAULT_CLAIM_TTL_DAYS}]

Every command accepts --claims-dir <path> to isolate a working copy.
  bun run deslop -- release --run <run-id>
  bun run deslop -- file <path> [--include-noisy]
  bun run deslop -- top [--limit 10] [--include-noisy]

Files selected by an active batch are excluded from later batches, so concurrent
batches never touch the same file, including batches created by the React Doctor
pipeline. Claims are shared across clones by default. A batch stays active until
it is released.

Examples:
  bun run deslop -- next-batch --min-issues 60 --max-issues 120
  bun run deslop -- file packages/ui/src/lib/settings/metadata.ts
  bun run deslop -- check-batch --run 2026-08-16T10-12-44Z
  bun run deslop -- release --run 2026-08-16T10-12-44Z`);
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

function runOxlint() {
  // Oxlint exits non-zero whenever it reports findings, so the report has to be
  // read from stdout of the failed invocation rather than treated as an error.
  let output;
  try {
    output = execFileSync("bunx", ["oxlint", "--format", "json"], {
      cwd: process.cwd(),
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    // The utf8 encoding above makes stdout a string whenever the run produced
    // a report; an empty stdout means the run itself failed.
    if (!error.stdout) throw error;
    output = error.stdout;
  }
  const report = JSON.parse(output);
  return { diagnostics: normalizeDiagnostics(report.diagnostics ?? []) };
}

function ruleOf(code) {
  const match = /^anti-slop\((.+)\)$/.exec(code ?? "");
  return match ? match[1] : (code ?? "unknown");
}

function normalizeDiagnostics(rawDiagnostics) {
  return rawDiagnostics.map((diagnostic) => {
    const span = diagnostic.labels?.[0]?.span;
    return {
      filePath: diagnostic.filename,
      rule: ruleOf(diagnostic.code),
      severity: diagnostic.severity ?? "error",
      message: diagnostic.message,
      line: span?.line,
      column: span?.column,
    };
  });
}

function selectableDiagnostics(report, includeNoisy) {
  if (includeNoisy) return report.diagnostics;
  return report.diagnostics.filter((diagnostic) => !NOISY_RULES.has(diagnostic.rule));
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
  const score = diagnostics.reduce((sum, diagnostic) => sum + rulePriority(diagnostic.rule), 0);
  const mechanicalCount = diagnostics.filter((diagnostic) => rulePriority(diagnostic.rule) >= 75).length;
  return score + mechanicalCount * 20;
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
    counts.set(diagnostic.rule, (counts.get(diagnostic.rule) ?? 0) + 1);
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
  const readableArea = stems.length === 1
    ? stems[0]
    : `${stems.slice(0, 2).join(" and ")}${stems.length > 2 ? ` plus ${stems.length - 2}` : ""}`;
  const areaSlug = slugify(stems.slice(0, 3).join("-")) || "batch";
  const batchName = `as-${timestamp}-${areaSlug}`;

  return {
    batchName,
    branchName: `anti-slop/${batchName}`,
    prTitle: `Reduce anti-slop findings in ${titleCase(readableArea)}`,
  };
}

function selectBatch(entries, minIssues, maxIssues, maxFiles) {
  if (entries.length === 0) {
    return { selected: [], oversized: false, belowTarget: false, reason: "No findings available for selection." };
  }

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
  const dir = runDirPath(RUNS_DIR, PIPELINE, runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "baseline.json"), `${JSON.stringify(payload.report, null, 2)}\n`);
  writeFileSync(join(dir, "batch.json"), `${JSON.stringify(payload.batch, null, 2)}\n`);
  return dir;
}

function readRun(runId) {
  const dir = runDirPath(RUNS_DIR, PIPELINE, runId);
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
  const total = report.diagnostics.length;
  const affected = groupByFile(report.diagnostics).size;
  const noisy = report.diagnostics.filter((diagnostic) => NOISY_RULES.has(diagnostic.rule)).length;
  console.log(`Total findings: ${total} across ${affected} files`);
  console.log(`Excluded-by-default findings: ${noisy} (${[...NOISY_RULES].join(", ")})`);
}

function commandNextBatch(args) {
  const minIssues = asPositiveInt(args["min-issues"], 60, "min-issues");
  const maxIssues = asPositiveInt(args["max-issues"], 120, "max-issues");
  const maxFiles = asPositiveInt(args["max-files"], 4, "max-files");
  if (minIssues > maxIssues) throw new Error("--min-issues cannot be greater than --max-issues.");
  const maxActive = asPositiveInt(args["max-active"], DEFAULT_MAX_ACTIVE, "max-active");
  const claimTtlDays = asPositiveInt(args["claim-ttl"], DEFAULT_CLAIM_TTL_DAYS, "claim-ttl");
  const includeNoisy = args["include-noisy"] === true;

  const claims = readActiveClaims(RUNS_DIR, claimTtlDays);
  if (claims.length >= maxActive) {
    console.log("Anti-Slop Next Batch");
    console.log("");
    console.log("NO BATCH AVAILABLE");
    console.log(`Reason: ${claims.length} active batches already exist and the limit is ${maxActive}.`);
    console.log("Stop here. Do not create a branch or a pull request.");
    console.log("");
    printClaims(claims, PIPELINE);
    return;
  }

  const report = runOxlint();
  const claimedPaths = claimedFilePaths(claims);
  const candidates = selectableDiagnostics(report, includeNoisy)
    .filter((diagnostic) => !claimedPaths.has(diagnostic.filePath));
  const entries = sortedFileEntries(candidates);

  if (entries.length === 0) {
    console.log("Anti-Slop Next Batch");
    console.log("");
    console.log("NO BATCH AVAILABLE");
    console.log("Reason: no unclaimed findings remain for the selected rules.");
    console.log("Stop here. Do not create a branch or a pull request.");
    console.log("");
    printClaims(claims, PIPELINE);
    return;
  }
  const selection = selectBatch(entries, minIssues, maxIssues, maxFiles);
  const runId = createRunId();
  const selectedFiles = selection.selected.map(([filePath, fileDiagnostics]) => ({
    filePath,
    diagnosticCount: fileDiagnostics.length,
    rules: summarizeRules(fileDiagnostics),
  }));
  const metadata = createBatchMetadata(runId, selectedFiles);
  const batch = {
    runId,
    ...metadata,
    minIssues,
    maxIssues,
    maxFiles,
    maxActive,
    includeNoisy,
    selectedFiles,
    oversized: selection.oversized,
    belowTarget: selection.belowTarget,
    reason: selection.reason,
  };
  const runDir = writeRun(runId, { report, batch });

  console.log("Anti-Slop Next Batch");
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
  console.log(`Batch window: ${minIssues}-${maxIssues} findings`);
  console.log(`Noisy rules included: ${includeNoisy ? "yes" : "no"}`);
  console.log(`Active batches before this one: ${claims.length} of ${maxActive}`);
  console.log(`Claims directory: ${RUNS_DIR} (${SHARED_CLAIMS ? "shared default" : "override"})`);
  console.log(`Files excluded as claimed by active batches: ${claimedPaths.size}`);
  console.log(`Selection mode: complete files only`);
  console.log(`Batch total: ${selectedFiles.reduce((sum, file) => sum + file.diagnosticCount, 0)} findings`);
  console.log(`Oversized: ${selection.oversized ? "yes" : "no"}`);
  console.log(`Below target: ${selection.belowTarget ? "yes" : "no"}`);
  console.log(`Selection reason: ${selection.reason}`);
  console.log("");
  console.log("Selected files:");
  selection.selected.forEach(([filePath, fileDiagnostics], index) => {
    console.log(`${index + 1}. ${filePath}`);
    console.log(`   Findings: ${fileDiagnostics.length}`);
    console.log("   Rules:");
    for (const [rule, count] of summarizeRules(fileDiagnostics)) {
      console.log(`   ${String(count).padStart(3)}  ${rule}`);
    }
    console.log("   Findings detail:");
    for (const diagnostic of fileDiagnostics) {
      console.log(`   line ${diagnostic.line ?? "?"}:${diagnostic.column ?? "?"}  ${diagnostic.severity}  ${diagnostic.rule}`);
      console.log(`     ${diagnostic.message}`);
    }
    console.log("");
  });
}

function commandActive(args) {
  const claimTtlDays = asPositiveInt(args["claim-ttl"], DEFAULT_CLAIM_TTL_DAYS, "claim-ttl");
  console.log(`Claims directory: ${RUNS_DIR} (${SHARED_CLAIMS ? "shared default" : "override"})`);
  printClaims(readActiveClaims(RUNS_DIR, claimTtlDays), PIPELINE);
}

function commandRelease(args) {
  const runId = args.run;
  if (!runId || runId === true) throw new Error("Missing --run <run-id>.");
  const dir = releaseRun(RUNS_DIR, PIPELINE, runId);
  console.log(`Released batch ${runId}`);
  console.log(`Removed ${dir}`);
}

function commandTop(args) {
  const limit = asPositiveInt(args.limit, 10, "limit");
  const includeNoisy = args["include-noisy"] === true;
  const report = runOxlint();
  const entries = sortedFileEntries(selectableDiagnostics(report, includeNoisy)).slice(0, limit);
  console.log(`Top ${limit} files by prioritized anti-slop findings`);
  console.log("");
  for (const [filePath, diagnostics] of entries) {
    console.log(`${String(diagnostics.length).padStart(4)}  ${filePath}`);
    console.log(`      ${summarizeRules(diagnostics).map(([rule, count]) => `${rule} ${count}`).join(", ")}`);
  }
}

function commandFile(args) {
  const filePath = args._[1];
  if (!filePath) throw new Error("Missing file path. Usage: bun run deslop -- file <path>");
  const includeNoisy = args["include-noisy"] === true;
  const report = runOxlint();
  const diagnostics = groupByFile(selectableDiagnostics(report, includeNoisy)).get(filePath) ?? [];
  console.log(filePath);
  console.log(`${diagnostics.length} findings`);
  console.log("");
  if (diagnostics.length === 0) return;
  console.log("Rules:");
  for (const [rule, count] of summarizeRules(diagnostics)) {
    console.log(`${String(count).padStart(4)}  ${rule}`);
  }
  console.log("");
  console.log("Findings:");
  for (const diagnostic of diagnostics) {
    console.log(`line ${diagnostic.line ?? "?"}:${diagnostic.column ?? "?"}  ${diagnostic.severity}  ${diagnostic.rule}`);
    console.log(`  ${diagnostic.message}`);
  }
}

function commandCheckBatch(args) {
  const runId = args.run;
  if (!runId || runId === true) throw new Error("Missing --run <run-id>.");
  const { baseline, batch } = readRun(runId);
  const current = runOxlint();
  const includeNoisy = batch.includeNoisy === true;
  const beforeDiagnostics = selectableDiagnostics(baseline, includeNoisy);
  const afterDiagnostics = selectableDiagnostics(current, includeNoisy);
  const beforeByFile = groupByFile(beforeDiagnostics);
  const afterByFile = groupByFile(afterDiagnostics);
  const selected = batch.selectedFiles ?? [];
  let beforeTotal = 0;
  let afterTotal = 0;

  console.log("Anti-Slop Batch Check");
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
  const beforeOutside = beforeDiagnostics.filter((diagnostic) => !selectedPaths.has(diagnostic.filePath)).length;
  const afterOutside = afterDiagnostics.filter((diagnostic) => !selectedPaths.has(diagnostic.filePath)).length;

  console.log("");
  console.log("Batch result:");
  console.log(`Fixed findings in selected files: ${Math.max(0, beforeTotal - afterTotal)}`);
  console.log(`Remaining findings in selected files: ${afterTotal}`);
  console.log(`Findings outside selected files delta: ${afterOutside - beforeOutside}`);
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
    case "active":
      commandActive(args);
      break;
    case "release":
      commandRelease(args);
      break;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
