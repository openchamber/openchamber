// Checks every pull request goes through. pr-intake acts on them (closes,
// labels, comments); pr-review runs no model on a PR that fails one. Workflows
// load this file from the base checkout, never from the PR head; stale loads it
// for the team label only.
//
// - The contribution gate: a PR from outside the team needs a linked issue
//   that is a bug report or a feature request the maintainer marked `accepted`.
//   An issue labeled `in-house` is built by the core team (the chambermakers,
//   who hold maintain or admin on the repository): a PR from anyone else that
//   links one is closed whatever else it links, triage collaborators, trusted
//   contributors and docs-only changes included.
// - Visual evidence: screenshots belong in the PR description, never in the
//   branch, and a PR that changes UI shows one.
//
// Each check's comment carries a marker and is posted once per PR. A PR with
// the comment but not the label had the label taken off by a maintainer, which
// waives that check for the PR for good; pr-intake retires the marker itself
// when a check passes, so it can apply again later.

const fs = require("node:fs");
const path = require("node:path");

const GATE_LABEL = {
  name: "needs-accepted-issue",
  color: "c5def5",
  description: "Closed: no linked bug report or accepted feature request. Reopens when one is linked.",
};

const GATE_MARKER = "<!-- pr-intake:needs-accepted-issue -->";

const TEAM_LABEL = {
  name: "team",
  color: "5319e7",
  description: "Opened by a maintainer. Never closed as stale.",
};

const COMMITTED_MEDIA = {
  label: {
    name: "evidence-in-branch",
    color: "e99695",
    description: "Screenshots, recordings or logs committed to the branch. They go in the PR description.",
  },
  // Not the marker of the older one-off evidence comment, which carried no
  // label and would otherwise read as a waiver.
  marker: "<!-- pr-intake:evidence-in-branch -->",
};

const MISSING_SCREENSHOTS = {
  label: {
    name: "needs-visual-evidence",
    color: "fbca04",
    description: "Changes UI with no screenshot in the PR description. Not reviewed until one is there.",
  },
  marker: "<!-- pr-intake:needs-visual-evidence -->",
};

const UNPROVEN_RUNTIME = {
  label: {
    name: "needs-live-run",
    color: "fbca04",
    description: "Touches a runtime it was not run in, or lists a known problem. Not reviewed until fixed.",
  },
  marker: "<!-- pr-intake:needs-live-run -->",
};

// PRs opened before the gate existed keep the rules they were opened under.
const GATE_CUTOVER = "2026-10-28T14:00:00Z";

const PASSING_ISSUE_LABELS = ["bug", "accepted"];

const IN_HOUSE_LABEL = {
  name: "in-house",
  color: "0e8a16",
  description: "The team builds this one. Outside PRs that link it are closed.",
};

const isDocsFile = (file) => {
  if (file.startsWith("packages/docs/")) return true;
  if (!/\.mdx?$/i.test(file)) return false;
  // Agent instructions steer every contributor's agent; they are not docs.
  if (/^\.(agents|github|opencode)\//.test(file)) return false;
  return !/(^|\/)(AGENTS|CLAUDE)\.md$/.test(file);
};

const isTestFile = (file) =>
  /(^|\/)(__tests__|test|tests)\//.test(file) || /\.(test|spec)\.[^/]+$/.test(file) || /\.snap$/.test(file);

const readTrustedContributors = (workspace) => {
  try {
    return fs
      .readFileSync(path.join(workspace, ".github", "trusted-contributors"), "utf8")
      .split("\n")
      .map((line) => line.replace(/#.*/, "").trim().toLowerCase())
      .filter(Boolean);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
};

// `author_association` reports MEMBER only when the caller can see the author's
// org membership, and an app token cannot see private members, so a maintainer
// with hidden membership reads as CONTRIBUTOR. The permission level is asked
// instead: it answers "read" for every GitHub user on a public repository, so
// Triage and up tells the team apart. The collaborator check is not used: the
// app token gets 404 there for maintainers whose access comes through the
// organization.
const hasRepoAccess = async ({ github, owner, repo, pr }) => {
  if (["OWNER", "MEMBER", "COLLABORATOR"].includes(pr.author_association)) return true;
  const { data } = await github.rest.repos.getCollaboratorPermissionLevel({ owner, repo, username: pr.user.login });
  return ["admin", "maintain", "write", "triage"].includes(data.role_name ?? data.permission);
};

// `role_name` tells maintain from write, which `permission` reports alike. An
// account that no longer exists has no role.
const isMaintainer = async ({ github, owner, repo, username }) => {
  try {
    const { data } = await github.rest.repos.getCollaboratorPermissionLevel({ owner, repo, username });
    return ["admin", "maintain"].includes(data.role_name);
  } catch (error) {
    if (error.status === 404) return false;
    throw error;
  }
};

// Issues the PR closes (`Fixes #N`, `Closes`, `Resolves`, or linked in the
// Development sidebar), plus `Part of #N` for one PR of a larger feature.
const linkedIssueNumbers = async ({ github, owner, repo, pr }) => {
  const { repository } = await github.graphql(
    `query($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
          closingIssuesReferences(first: 25) { nodes { number repository { nameWithOwner } } }
        }
      }
    }`,
    { owner, repo, number: pr.number },
  );
  const numbers = new Set(
    repository.pullRequest.closingIssuesReferences.nodes
      .filter((issue) => issue.repository.nameWithOwner.toLowerCase() === `${owner}/${repo}`.toLowerCase())
      .map((issue) => issue.number),
  );
  const partOf = new RegExp(
    `\\bpart of\\s+(?:${owner}/${repo}#|#|https://github\\.com/${owner}/${repo}/issues/)(\\d+)`,
    "gi",
  );
  for (const match of (pr.body ?? "").matchAll(partOf)) numbers.add(Number(match[1]));
  return [...numbers];
};

const linkedIssues = async ({ github, owner, repo, pr }) => {
  const issues = [];
  for (const number of await linkedIssueNumbers({ github, owner, repo, pr })) {
    try {
      const { data } = await github.rest.issues.get({ owner, repo, issue_number: number });
      if (data.pull_request) continue;
      issues.push({ number, labels: data.labels.map((label) => label.name) });
    } catch (error) {
      if (error.status !== 404 && error.status !== 410) throw error;
    }
  }
  return issues;
};

// Returns { exempt } when the gate does not apply to this PR, otherwise
// { passes, issues } with the linked issues and their labels.
// { passes: false, issues, inHouse } when a linked issue is one the team builds.
const evaluateContributionGate = async ({ github, owner, repo, pr, files, workspace }) => {
  if (pr.created_at < GATE_CUTOVER) return { exempt: "opened before the gate" };
  if (pr.draft) return { exempt: "draft" };
  if (pr.user.type === "Bot") return { exempt: "bot" };

  const issues = await linkedIssues({ github, owner, repo, pr });
  const inHouse = issues.filter((issue) => issue.labels.includes(IN_HOUSE_LABEL.name)).map((issue) => issue.number);
  // Team membership needs an org permission the app token lacks; the core
  // team is exactly the maintain/admin role on this repository.
  if (inHouse.length > 0 && !(await isMaintainer({ github, owner, repo, username: pr.user.login }))) {
    return { passes: false, issues, inHouse };
  }

  if (await hasRepoAccess({ github, owner, repo, pr })) return { exempt: "collaborator" };

  if (readTrustedContributors(workspace).includes(pr.user.login.toLowerCase())) return { exempt: "trusted contributor" };

  // A rename counts by both names, so moving code into a test path is not a test change.
  const paths = files.flatMap(({ filename, previous_filename }) => (previous_filename ? [filename, previous_filename] : [filename]));
  if (paths.length > 0 && paths.every((file) => isDocsFile(file) || isTestFile(file))) {
    return { exempt: "docs or tests only" };
  }

  const passes = issues.some((issue) => issue.labels.some((label) => PASSING_ISSUE_LABELS.includes(label)));
  return { passes, issues };
};

const listPullFiles = ({ github, owner, repo, pr }) =>
  github.paginate(github.rest.pulls.listFiles, { owner, repo, pull_number: pr.number, per_page: 100 });

// Media belongs only where the product's own assets live.
const ASSET_ROOTS = [
  "packages/ui/src/assets/",
  "packages/ui/public/",
  "packages/web/public/",
  "packages/electron/resources/",
  "packages/mobile/android/",
  "packages/mobile/ios/",
  "packages/mobile/assets/",
  "packages/vscode/",
  "packages/docs/",
  "packages/extensions/",
  "packages/sdk/examples/",
  "docs/references/",
];
const isMediaFile = (file) => /\.(png|jpe?g|gif|webp|bmp|mp4|mov|webm|har|trace|log)$/i.test(file);
const isEvidenceFile = (file) =>
  file.split("/").some((segment) => segment === "evidence" || segment === "pr-evidence") ||
  (isMediaFile(file) && !ASSET_ROOTS.some((root) => file.startsWith(root)));

// Rendered UI. All UI wording lives in the translation catalogs, so a wording
// change there needs no screenshot.
const isRenderedUiFile = (file) =>
  /^packages\/ui\/src\/.+\.(tsx|css)$/.test(file) && !isTestFile(file) && !file.startsWith("packages/ui/src/lib/i18n/messages/");

// A Markdown or HTML image, or a file GitHub hosts for the description.
const DESCRIPTION_IMAGE = /!\[[^\]]*\]\(\s*https?:\/\/|<img\s[^>]*src=["']?https?:\/\/|https:\/\/github\.com\/user-attachments\/assets\//i;

const evaluateVisualEvidence = ({ pr, files }) => ({
  committedMedia: files
    .filter(({ status }) => status !== "removed")
    .map(({ filename }) => filename)
    .filter(isEvidenceFile),
  missingScreenshots: !pr.draft && files.some(({ filename }) => isRenderedUiFile(filename)) && !DESCRIPTION_IMAGE.test(pr.body ?? ""),
});

// The runtimes a change has to be run in, by the paths it touches: code that
// only that runtime executes, or that behaves there in its own way. Shared UI
// outside these paths renders the same everywhere and is proven once.
const RUNTIME_PATHS = [
  {
    runtime: "Desktop (Electron)",
    paths: /^packages\/(electron\/|ui\/src\/(components\/(desktop|mini-chat)\/|apps\/(ElectronMiniChat|renderElectronMiniChat|miniChat)|(?!assets\/).*(MiniChat|Electron)[^/]*\.tsx?$))/,
  },
  {
    runtime: "VS Code",
    paths: /^packages\/(vscode\/|ui\/src\/apps\/(VSCode|vscode|renderVSCode))/,
  },
  {
    runtime: "Capacitor mobile",
    paths: /^packages\/(mobile\/|ui\/src\/(apps\/(Mobile|mobile|renderMobile|Ipad|ipad|useNative|useEdgeSwipe)|(?!assets\/).*[Mm]obile[^/]*\.tsx?$))/,
  },
  // The relay has two kinds of client with their own transport code, so a
  // change to it is run from both.
  {
    runtime: "Relay",
    paths: /^packages\/(ui\/src\/lib\/relay\/|web\/server\/lib\/relay\/|electron\/relay-)/,
    proof: [/\b(desktop|electron)\b/i, /\b(phone|mobile|simulator|ios|iphone|ipad|android)\b/i],
  },
];

const NOT_RUN = /\b(not\s+(yet\s+)?(run|ran|tested|verified|checked|exercised|applicable|available)\b|same\s+code\b|does\s+not\s+run\s+here|untested|unverified|n\/a|(could|can|did|was|were)\s?(not|n['’]t)\s+(be\s+)?(run|ran|test|tested|verify|verified|check|launch|build)|unable\s+to|no\s+access|no\s+(device|simulator|mac)\b)/i;

const stripComments = (text) => text.replace(/<!--[\s\S]*?-->/g, "");

const runtimeRow = (body, runtime) => {
  const escaped = runtime.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^\\|\\s*${escaped}\\s*\\|(.*)\\|\\s*$`, "im").exec(body);
  return match ? match[1].trim() : null;
};

const sectionText = (body, heading) => {
  const match = new RegExp(`^##\\s+${heading}\\s*$([\\s\\S]*?)(?=^##\\s|(?![\\s\\S]))`, "im").exec(body);
  return match ? match[1].trim() : null;
};

// PRs opened before the check existed keep the description they were opened with.
const RUNTIME_PROOF_CUTOVER = "2026-11-16T00:00:00Z";

// A change is ready when it was run in every runtime its paths require and
// its author knows of no problem in it. Drafts are still being worked on.
const evaluateRuntimeProof = ({ pr, files }) => {
  const body = stripComments(pr.body ?? "");
  // Deleting or moving a runtime's code changes that runtime too.
  const changed = files
    .flatMap(({ filename, previous_filename: previous }) => (previous ? [filename, previous] : [filename]))
    .filter((file) => !isDocsFile(file) && !isTestFile(file));
  const predates = pr.created_at !== undefined && pr.created_at < RUNTIME_PROOF_CUTOVER;
  if (pr.draft || predates || changed.length === 0) return { unproven: [], knownProblems: false };
  const unproven = RUNTIME_PATHS
    .filter(({ paths }) => changed.some((file) => paths.test(file)))
    .filter(({ runtime, proof = [] }) => {
      const row = runtimeRow(body, runtime);
      return row === null || row === "" || NOT_RUN.test(row) || proof.some((needed) => !needed.test(row));
    })
    .map(({ runtime }) => runtime);
  const known = sectionText(body, "Known problems");
  return { unproven, knownProblems: known !== null && !/^none(\s+(identified|known))?\.?$/i.test(known) };
};

const hasMarkerComment = (comments, marker) =>
  comments.some((comment) => comment.user?.type === "Bot" && (comment.body ?? "").includes(marker));

// Comments are read before the labels: pr-intake adds a label before it
// comments, so a check comment seen here comes with its label already set.
const isWaived = async ({ github, owner, repo, pr, label, marker }) => {
  const comments = await github.paginate(github.rest.issues.listComments, { owner, repo, issue_number: pr.number, per_page: 100 });
  if (!hasMarkerComment(comments, marker)) return false;
  const { data } = await github.rest.issues.get({ owner, repo, issue_number: pr.number });
  return !data.labels.some((item) => item.name === label.name);
};

module.exports = {
  COMMITTED_MEDIA,
  GATE_LABEL,
  GATE_MARKER,
  IN_HOUSE_LABEL,
  MISSING_SCREENSHOTS,
  TEAM_LABEL,
  UNPROVEN_RUNTIME,
  evaluateContributionGate,
  evaluateRuntimeProof,
  evaluateVisualEvidence,
  hasMarkerComment,
  isMaintainer,
  isWaived,
  listPullFiles,
};
