// packages/sdk/examples/git-graph-status/service/main.ts
import { execFile } from "node:child_process";
import http from "node:http";
import path from "node:path";
var port = Number(process.env.OPENCHAMBER_SERVICE_PORT);
var token = process.env.OPENCHAMBER_SERVICE_TOKEN ?? "";
if (!port || !token) {
  console.error("OPENCHAMBER_SERVICE_PORT and OPENCHAMBER_SERVICE_TOKEN are required");
  process.exit(1);
}
var LIMIT_DEFAULT = 40;
var LIMIT_MAX = 100;
var REFS_MAX = 200;
var FIELD = "\x1F";
var RECORD = "\x1E";
var SHA = /^[0-9a-f]{7,64}$/i;
var LOG_FORMAT = ["%H", "%P", "%an", "%ar", "%aI", "%D", "%s"].join("%x1f") + "%x1e";
var SHOW_FORMAT = ["%H", "%P", "%an", "%ae", "%ar", "%aI", "%s", "%b"].join("%x1f");
var json = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};
var git = (directory, args) => new Promise((resolve) => {
  execFile("git", ["-C", directory, ...args], {
    timeout: 8000,
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" }
  }, (error, stdout, stderr) => {
    if (!error) {
      resolve({ ok: true, stdout });
      return;
    }
    if ("code" in error && error.code === "ENOENT") {
      resolve({ ok: false, failure: "no-git" });
      return;
    }
    if (/not a git repository/i.test(stderr)) {
      resolve({ ok: false, failure: "not-a-repo" });
      return;
    }
    if (/bad object|unknown revision|bad revision|ambiguous argument/i.test(stderr)) {
      resolve({ ok: false, failure: "unknown-commit" });
      return;
    }
    resolve({ ok: false, failure: "git-failed" });
  });
});
var failureStatus = (failure) => failure === "not-a-repo" || failure === "unknown-commit" ? 422 : 500;
var refKind = (full) => {
  if (full.startsWith("refs/heads/"))
    return { name: full.slice("refs/heads/".length), kind: "local" };
  if (full.startsWith("refs/remotes/")) {
    const name = full.slice("refs/remotes/".length);
    return name.endsWith("/HEAD") ? null : { name, kind: "remote" };
  }
  if (full.startsWith("refs/tags/"))
    return { name: full.slice("refs/tags/".length), kind: "tag" };
  return null;
};
var parseDecorations = (value) => {
  const refs = [];
  for (const raw of value.split(",").map((part) => part.trim()).filter(Boolean)) {
    if (raw === "HEAD")
      continue;
    const head = raw.startsWith("HEAD -> ");
    const full = head ? raw.slice("HEAD -> ".length) : raw.startsWith("tag: ") ? raw.slice("tag: ".length) : raw;
    const ref = refKind(full);
    if (!ref)
      continue;
    if (head)
      refs.unshift({ ...ref, head });
    else
      refs.push({ ...ref, head });
  }
  return refs;
};
var parseLog = (stdout) => stdout.split(RECORD).map((record) => record.replace(/^\n/, "")).filter(Boolean).map((record) => {
  const [hash = "", parents = "", author = "", when = "", date = "", decorations = "", subject = ""] = record.split(FIELD);
  return { hash, parents: parents.split(" ").filter(Boolean), author, when, date, refs: parseDecorations(decorations), subject };
});
var githubWebUrl = (remote) => {
  const match = /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(remote.trim());
  return match ? `https://github.com/${match[1]}/${match[2]}` : null;
};
var readRefs = async (directory) => {
  const listed = await git(directory, ["for-each-ref", `--count=${REFS_MAX}`, "--sort=-committerdate", "--format=%(refname)", "refs/heads", "refs/remotes", "refs/tags"]);
  if (!listed.ok)
    return listed;
  const branch = await git(directory, ["symbolic-ref", "--short", "-q", "HEAD"]);
  const upstream = await git(directory, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
  const remote = await git(directory, ["remote", "get-url", "origin"]);
  return { ok: true, value: {
    branch: branch.ok ? branch.stdout.trim() || null : null,
    upstream: upstream.ok ? upstream.stdout.trim() || null : null,
    github: remote.ok ? githubWebUrl(remote.stdout) : null,
    refs: listed.stdout.split(`
`).map((line) => refKind(line.trim())).filter((ref) => ref !== null)
  } };
};
var fullRefName = (ref) => ref.kind === "local" ? `refs/heads/${ref.name}` : ref.kind === "remote" ? `refs/remotes/${ref.name}` : `refs/tags/${ref.name}`;
var revisions = async (directory, mode, picked) => {
  if (mode === "all")
    return { ok: true, revisions: ["--branches", "--remotes", "--tags", "HEAD"] };
  const listed = await readRefs(directory);
  if (!listed.ok)
    return listed;
  const refs = listed.value;
  if (mode === "manual") {
    const wanted = new Set(picked);
    const chosen = refs.refs.filter((ref) => wanted.has(`${ref.kind}:${ref.name}`)).map(fullRefName);
    return { ok: true, revisions: chosen.length > 0 ? chosen : ["HEAD"] };
  }
  const upstream = refs.upstream ? refs.refs.find((ref) => ref.kind === "remote" && ref.name === refs.upstream) : undefined;
  return { ok: true, revisions: upstream ? ["HEAD", fullRefName(upstream)] : ["HEAD"] };
};
var readLog = async (directory, mode, picked, limit) => {
  const revs = await revisions(directory, mode, picked);
  if (!revs.ok)
    return { status: failureStatus(revs.failure), body: { error: revs.failure } };
  const log = await git(directory, ["log", "--topo-order", "--decorate=full", `--max-count=${limit}`, `--format=${LOG_FORMAT}`, ...revs.revisions, "--"]);
  if (!log.ok) {
    return log.failure === "unknown-commit" ? { status: 200, body: { commits: [], uncommitted: 0 } } : { status: failureStatus(log.failure), body: { error: log.failure } };
  }
  const status = await git(directory, ["status", "--porcelain=v1", "--untracked-files=no"]);
  const uncommitted = status.ok ? status.stdout.split(`
`).filter(Boolean).length : 0;
  return { status: 200, body: { commits: parseLog(log.stdout), uncommitted } };
};
var shortstat = (value) => ({
  files: Number(/(\d+) files? changed/.exec(value)?.[1] ?? 0),
  insertions: Number(/(\d+) insertions?\(\+\)/.exec(value)?.[1] ?? 0),
  deletions: Number(/(\d+) deletions?\(-\)/.exec(value)?.[1] ?? 0)
});
var readCommit = async (directory, sha) => {
  const shown = await git(directory, ["show", "--no-patch", `--format=${SHOW_FORMAT}`, sha, "--"]);
  if (!shown.ok)
    return { status: failureStatus(shown.failure), body: { error: shown.failure } };
  const [hash = "", parents = "", author = "", email = "", when = "", date = "", subject = "", body = ""] = shown.stdout.split(FIELD);
  const parentList = parents.split(" ").filter(Boolean);
  const firstParent = parentList[0];
  const stat = firstParent ? await git(directory, ["diff", "--shortstat", firstParent, hash, "--"]) : await git(directory, ["show", "--shortstat", "--format=", hash, "--"]);
  return {
    status: 200,
    body: { hash, parents: parentList, author, email, when, date, subject, body: body.trim(), ...shortstat(stat.ok ? stat.stdout : "") }
  };
};
var parseLimit = (value) => {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, LIMIT_MAX) : LIMIT_DEFAULT;
};
var server = http.createServer((req, res) => {
  if (req.headers.authorization !== `Bearer ${token}`) {
    json(res, 401, { error: "unauthorized" });
    return;
  }
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/health") {
    json(res, 200, { ok: true });
    return;
  }
  const directory = url.searchParams.get("directory") ?? "";
  if (req.method !== "GET" || !["/log", "/refs", "/commit"].includes(url.pathname)) {
    json(res, 404, { error: "not-found" });
    return;
  }
  if (!path.isAbsolute(directory)) {
    json(res, 400, { error: "bad-request" });
    return;
  }
  const answer = async () => {
    if (url.pathname === "/refs") {
      const refs = await readRefs(directory);
      return refs.ok ? { status: 200, body: refs.value } : { status: failureStatus(refs.failure), body: { error: refs.failure } };
    }
    if (url.pathname === "/commit") {
      const sha = url.searchParams.get("sha") ?? "";
      return SHA.test(sha) ? readCommit(directory, sha) : { status: 400, body: { error: "bad-request" } };
    }
    const picked = (url.searchParams.get("refs") ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
    return readLog(directory, url.searchParams.get("mode") ?? "auto", picked, parseLimit(url.searchParams.get("limit")));
  };
  answer().then(({ status, body }) => json(res, status, body));
});
server.listen(port, "127.0.0.1");
