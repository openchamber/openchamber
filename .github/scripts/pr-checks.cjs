// Checks every pull request goes through. pr-intake acts on them (closes,
// labels, comments); pr-review runs no model on a PR that fails one. Both
// workflows load this file from the base checkout, never from the PR head.
//
// - The contribution gate: a PR from outside the team needs a linked issue
//   that is a bug report or a feature request the maintainer marked `accepted`.
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

// PRs opened before the gate existed keep the rules they were opened under.
const GATE_CUTOVER = "2026-10-28T14:00:00Z";

const PASSING_ISSUE_LABELS = ["bug", "accepted"];

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
const evaluateContributionGate = async ({ github, owner, repo, pr, files, workspace }) => {
  if (pr.created_at < GATE_CUTOVER) return { exempt: "opened before the gate" };
  if (pr.draft) return { exempt: "draft" };
  if (pr.user.type === "Bot") return { exempt: "bot" };
  if (readTrustedContributors(workspace).includes(pr.user.login.toLowerCase())) return { exempt: "trusted contributor" };
  if (await hasRepoAccess({ github, owner, repo, pr })) return { exempt: "collaborator" };

  // A rename counts by both names, so moving code into a test path is not a test change.
  const paths = files.flatMap(({ filename, previous_filename }) => (previous_filename ? [filename, previous_filename] : [filename]));
  if (paths.length > 0 && paths.every((file) => isDocsFile(file) || isTestFile(file))) {
    return { exempt: "docs or tests only" };
  }

  const issues = await linkedIssues({ github, owner, repo, pr });
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
  MISSING_SCREENSHOTS,
  evaluateContributionGate,
  evaluateVisualEvidence,
  hasMarkerComment,
  isWaived,
  listPullFiles,
};
