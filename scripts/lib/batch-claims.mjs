import { readdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Batch handoff directories double as file claims. A run directory exists from
// the moment its batch is generated until its follow-up task releases it, so
// concurrent maintenance batches can be kept file-disjoint.
//
// Maintenance pipelines are expected to run from dedicated clones of the same
// repository, so claims live outside the working copy by default. Every clone
// and every pipeline therefore sees the same claims without any per-scheduler
// configuration. Override with --claims-dir or OPENCHAMBER_BATCH_CLAIMS_DIR
// only when a working copy must be isolated, for example while experimenting.

const DAY_MS = 24 * 60 * 60 * 1000;
const SHARED_CLAIMS_ENV = "OPENCHAMBER_BATCH_CLAIMS_DIR";
const DEFAULT_CLAIMS_DIR = join(homedir(), ".openchamber", "maintenance-claims");

function expandHome(path) {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

export function resolveRunsDir(claimsDirArgument) {
  const override = claimsDirArgument ?? process.env[SHARED_CLAIMS_ENV];
  if (override !== undefined && override !== true) {
    return { runsDir: join(expandHome(override), "runs"), shared: false };
  }
  return { runsDir: join(DEFAULT_CLAIMS_DIR, "runs"), shared: true };
}

export function runDirName(pipeline, runId) {
  return `${pipeline}-${runId}`;
}

export function runDirPath(runsDir, pipeline, runId) {
  return join(runsDir, runDirName(pipeline, runId));
}

function parseDirName(dirName) {
  const match = /^([a-z]+)-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z?)$/.exec(dirName);
  if (!match) return undefined;
  const [, pipeline, stamp] = match;
  const [date, time] = stamp.replace(/Z$/, "").split("T");
  const createdAt = Date.parse(`${date}T${time.replace(/-/g, ":")}Z`);
  return { pipeline, runId: stamp, createdAt: Number.isNaN(createdAt) ? undefined : createdAt };
}

export function readActiveClaims(runsDir, claimTtlDays) {
  if (!existsSync(runsDir)) return [];
  const now = Date.now();
  const claims = [];

  for (const entry of readdirSync(runsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const parsed = parseDirName(entry.name);
    if (!parsed) continue;

    const batchPath = join(runsDir, entry.name, "batch.json");
    if (!existsSync(batchPath)) continue;

    let batch;
    try {
      batch = JSON.parse(readFileSync(batchPath, "utf8"));
    } catch {
      continue;
    }

    const expired = parsed.createdAt !== undefined && now - parsed.createdAt > claimTtlDays * DAY_MS;
    if (expired) continue;

    claims.push({
      pipeline: parsed.pipeline,
      runId: batch.runId ?? parsed.runId,
      branchName: batch.branchName,
      createdAt: parsed.createdAt,
      filePaths: (batch.selectedFiles ?? []).map((file) => file.filePath),
    });
  }

  return claims.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
}

export function claimedFilePaths(claims) {
  return new Set(claims.flatMap((claim) => claim.filePaths));
}

export function releaseRun(runsDir, pipeline, runId) {
  const dir = runDirPath(runsDir, pipeline, runId);
  if (!existsSync(dir)) throw new Error(`Unknown run: ${runId}`);
  rmSync(dir, { recursive: true, force: true });
  return dir;
}

export function printClaims(claims, ownPipeline) {
  if (claims.length === 0) {
    console.log("Active batches: none");
    return;
  }
  console.log(`Active batches: ${claims.length}`);
  for (const claim of claims) {
    const owner = claim.pipeline === ownPipeline ? "this pipeline" : `pipeline ${claim.pipeline}`;
    console.log(`  ${claim.runId}  ${claim.branchName ?? "(no branch)"}  [${owner}]`);
    for (const filePath of claim.filePaths) console.log(`    ${filePath}`);
  }
}
