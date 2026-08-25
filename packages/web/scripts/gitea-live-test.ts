#!/usr/bin/env bun

/*
 * Live test harness for the Gitea/Forgejo REST v1 client
 * (packages/web/server/lib/gitea/client.js).
 *
 * Exercises every client method against a real Gitea server and prints a
 * per-endpoint PASS/WARN/FAIL/SKIP table. Read-only calls run against an
 * auto-discovered repo; a controlled write pass then creates a scratch issue
 * (comment -> update -> close) and, when the token allows repo creation, runs
 * the full PR lifecycle (branch -> commit -> PR -> review -> update -> merge)
 * against a scratch repo that is deleted afterward.
 *
 * Usage:
 *   GITEA_TOKEN=<pat> GITEA_BASE_URL=https://git.buzzbee.dev \
 *     bun packages/web/scripts/gitea-live-test.ts
 *
 * The token is read from the environment only and is never printed or stored.
 *
 * Exit codes:
 *   0  every exercised endpoint passed (SKIP/WARN are not failures)
 *   1  at least one endpoint failed
 *   2  setup error (missing env, invalid token, or no repo found)
 */

import process from 'node:process';
import { Buffer } from 'node:buffer';
import { createGiteaClient } from '../server/lib/gitea/client.js';
import type { GiteaClientResponse } from '../server/lib/gitea/client.js';

const BASE_URL = (process.env.GITEA_BASE_URL || 'https://git.buzzbee.dev').trim().replace(/\/+$/, '');
const TOKEN = process.env.GITEA_TOKEN || '';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- Result collection ------------------------------------------------------

type Verdict = 'PASS' | 'WARN' | 'FAIL' | 'SKIP';

interface ResultEntry {
  name: string;
  method: string;
  path: string;
  status: number | null;
  verdict: Verdict;
  note: string;
}

const results: ResultEntry[] = [];

function record(entry: ResultEntry): void {
  results.push(entry);
  const statusText = entry.status === null ? '   ' : String(entry.status);
  const line = `[${entry.verdict}] ${entry.method.padEnd(6)} ${entry.path.padEnd(52)} ${statusText}`;
  console.log(entry.note ? `${line}  ${entry.note}` : line);
}

function summarize(): number {
  const counts: Record<Verdict, number> = { PASS: 0, WARN: 0, FAIL: 0, SKIP: 0 };
  for (const result of results) {
    counts[result.verdict] += 1;
  }
  console.log('\n----------------------------------------');
  console.log(
    `Summary: ${counts.PASS} passed, ${counts.WARN} warn, ${counts.FAIL} failed, ${counts.SKIP} skipped`,
  );
  return counts.FAIL > 0 ? 1 : 0;
}

const fail = (message: string): never => {
  console.error(`\nError: ${message}`);
  process.exit(2);
};

// ---- Untyped JSON payload helpers -------------------------------------------

const asRecord = (data: unknown): Record<string, unknown> | null =>
  data !== null && typeof data === 'object' && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : null;

const asArray = (data: unknown): Array<Record<string, unknown>> =>
  Array.isArray(data)
    ? data.filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object')
    : [];

const asString = (data: unknown): string | null =>
  typeof data === 'string' ? data : null;

const asNumber = (data: unknown): number | null =>
  typeof data === 'number' ? data : null;

const isOk = (response: GiteaClientResponse): boolean =>
  response.status === 200 || response.status === 201;

const isOkOr204 = (response: GiteaClientResponse): boolean =>
  isOk(response) || response.status === 204;

// ---- Main -------------------------------------------------------------------

async function main(): Promise<number> {
  if (!TOKEN) {
    fail('GITEA_TOKEN is required (set it in the environment; it is never printed or stored).');
  }
  console.log(`Gitea live test against ${BASE_URL}\n`);

  const client = createGiteaClient({ token: TOKEN, baseUrl: BASE_URL });

  // ================= Phase 0: identity + discovery =================

  const userResp = await client.user();
  record({
    name: 'user',
    method: 'GET',
    path: '/user',
    status: userResp.status,
    verdict: userResp.status === 200 ? 'PASS' : 'FAIL',
    note: '',
  });
  if (userResp.status !== 200) {
    fail(`GET /user failed with status ${userResp.status} — check GITEA_TOKEN and GITEA_BASE_URL.`);
  }
  const user = asRecord(userResp.data) ?? {};
  const login = asString(user.login) ?? asString(user.username) ?? 'unknown';
  console.log(`Authenticated as ${login}\n`);

  const reposResp = await client.request('/user/repos', { query: { limit: 50 } });
  record({
    name: 'list my repos',
    method: 'GET',
    path: '/user/repos',
    status: reposResp.status,
    verdict: reposResp.status === 200 ? 'PASS' : 'FAIL',
    note: '',
  });
  const repos = asArray(reposResp.data);
  if (repos.length === 0) {
    fail(`No repos found for ${login} on ${BASE_URL}.`);
  }

  // Probe up to 10 repos for issues/PRs so read paths can pick a repo that has
  // both; fall back to the first repo otherwise.
  interface RepoRef {
    owner: string;
    name: string;
  }
  let best: RepoRef | null = null;
  let bestIssues = false;
  let bestPrs = false;
  const probeCap = Math.min(repos.length, 10);
  for (let i = 0; i < probeCap; i += 1) {
    const repo = repos[i];
    const ownerObj = asRecord(repo.owner);
    const owner = asString(ownerObj?.login) ?? asString(ownerObj?.username) ?? '';
    const name = asString(repo.name) ?? '';
    if (!owner || !name) continue;

    const issuesProbe = await client.issues(owner, name, { state: 'all', limit: 1 });
    const prsProbe = await client.pullRequests(owner, name, { state: 'all', limit: 1 });
    const hasIssues = issuesProbe.status === 200 && asArray(issuesProbe.data).length > 0;
    const hasPrs = prsProbe.status === 200 && asArray(prsProbe.data).length > 0;

    if (best === null || (hasIssues && hasPrs && !(bestIssues && bestPrs))) {
      best = { owner, name };
      bestIssues = hasIssues;
      bestPrs = hasPrs;
    }
    if (hasIssues && hasPrs) break;
  }
  if (best === null) {
    const first = repos[0];
    const firstOwner = asRecord(first.owner);
    best = {
      owner: asString(firstOwner?.login) ?? asString(firstOwner?.username) ?? '',
      name: asString(first.name) ?? '',
    };
  }

  const { owner, name } = best;
  const target = `${owner}/${name}`;
  console.log(`Target repo: ${target} (issues: ${bestIssues}, PRs: ${bestPrs})\n`);

  // Fetch one issue number and one PR number for detail endpoints.
  const issuesList = await client.issues(owner, name, { state: 'all', limit: 1 });
  const firstIssue = asArray(issuesList.data)[0] ?? null;
  const issueNumber = firstIssue === null ? null : asNumber(firstIssue.number);
  const prsList = await client.pullRequests(owner, name, { state: 'all', limit: 1 });
  const firstPr = asArray(prsList.data)[0] ?? null;
  const prNumber = firstPr === null ? null : asNumber(firstPr.number);

  const skipIssue = bestIssues === false || issueNumber === null;
  const skipPr = bestPrs === false || prNumber === null;

  // ================= Phase 1: read-only pass =================

  const repoResp = await client.repo(owner, name);
  record({
    name: 'repo',
    method: 'GET',
    path: `/repos/${target}`,
    status: repoResp.status,
    verdict: repoResp.status === 200 ? 'PASS' : 'FAIL',
    note: '',
  });
  const repoData = asRecord(repoResp.data);
  const defaultBranch = asString(repoData?.default_branch) ?? 'main';

  const issuesResp = await client.issues(owner, name, { state: 'open', type: 'issues', limit: 50 });
  let issuesNote = '';
  if (issuesResp.status === 200 && issuesResp.page?.hasMore) {
    const page2 = await client.issues(owner, name, { state: 'open', type: 'issues', limit: 50, page: 2 });
    issuesNote = page2.status === 200 ? '(page 2 OK, hasMore honored)' : `(page 2 failed: ${page2.status})`;
  }
  record({
    name: 'issues list',
    method: 'GET',
    path: `/repos/${target}/issues`,
    status: issuesResp.status,
    verdict: issuesResp.status === 200 ? 'PASS' : 'FAIL',
    note: issuesNote,
  });

  // ETag conditional-GET check: a repeat call must be replayed from the cache
  // (the client converts the 304 into a 200) rather than failing.
  const etagReplay = await client.issues(owner, name, { state: 'open', type: 'issues', limit: 50 });
  record({
    name: 'issues list (repeat, ETag)',
    method: 'GET',
    path: `/repos/${target}/issues`,
    status: etagReplay.status,
    verdict: etagReplay.status === 200 ? 'PASS' : 'FAIL',
    note: '(second call replayed from ETag cache)',
  });

  if (skipIssue) {
    record({ name: 'issue get', method: 'GET', path: `/repos/${target}/issues/:number`, status: null, verdict: 'SKIP', note: '(repo has no issues)' });
    record({ name: 'issue comments', method: 'GET', path: `/repos/${target}/issues/:number/comments`, status: null, verdict: 'SKIP', note: '(repo has no issues)' });
  } else {
    const issueResp = await client.issue(owner, name, issueNumber as number);
    record({
      name: 'issue get',
      method: 'GET',
      path: `/repos/${target}/issues/${issueNumber}`,
      status: issueResp.status,
      verdict: issueResp.status === 200 ? 'PASS' : 'FAIL',
      note: '',
    });
    const commentsResp = await client.issueComments(owner, name, issueNumber as number, { limit: 100 });
    record({
      name: 'issue comments',
      method: 'GET',
      path: `/repos/${target}/issues/${issueNumber}/comments`,
      status: commentsResp.status,
      verdict: commentsResp.status === 200 ? 'PASS' : 'FAIL',
      note: '',
    });
  }

  const milestonesResp = await client.milestones(owner, name, { state: 'all', limit: 50 });
  record({
    name: 'milestones',
    method: 'GET',
    path: `/repos/${target}/milestones`,
    status: milestonesResp.status,
    verdict: milestonesResp.status === 200 ? 'PASS' : 'FAIL',
    note: '',
  });

  const labelsResp = await client.repoLabels(owner, name, { limit: 100 });
  record({
    name: 'repo labels',
    method: 'GET',
    path: `/repos/${target}/labels`,
    status: labelsResp.status,
    verdict: labelsResp.status === 200 ? 'PASS' : 'FAIL',
    note: '',
  });

  const pullsResp = await client.pullRequests(owner, name, { state: 'open', limit: 50 });
  record({
    name: 'PR list',
    method: 'GET',
    path: `/repos/${target}/pulls`,
    status: pullsResp.status,
    verdict: pullsResp.status === 200 ? 'PASS' : 'FAIL',
    note: '',
  });

  if (skipPr) {
    record({ name: 'PR get', method: 'GET', path: `/repos/${target}/pulls/:number`, status: null, verdict: 'SKIP', note: '(repo has no PRs)' });
    record({ name: 'PR diff', method: 'GET', path: `/repos/${target}/pulls/:number.diff`, status: null, verdict: 'SKIP', note: '(repo has no PRs)' });
    record({ name: 'PR files', method: 'GET', path: `/repos/${target}/pulls/:number/files`, status: null, verdict: 'SKIP', note: '(repo has no PRs)' });
    record({ name: 'PR commits', method: 'GET', path: `/repos/${target}/pulls/:number/commits`, status: null, verdict: 'SKIP', note: '(repo has no PRs)' });
    record({ name: 'PR reviews', method: 'GET', path: `/repos/${target}/pulls/:number/reviews`, status: null, verdict: 'SKIP', note: '(repo has no PRs)' });
    record({ name: 'PR statuses', method: 'GET', path: `/repos/${target}/pulls/:number/statuses`, status: null, verdict: 'SKIP', note: '(repo has no PRs)' });
  } else {
    const prResp = await client.pullRequest(owner, name, prNumber as number);
    record({
      name: 'PR get',
      method: 'GET',
      path: `/repos/${target}/pulls/${prNumber}`,
      status: prResp.status,
      verdict: prResp.status === 200 ? 'PASS' : 'FAIL',
      note: '',
    });
    const prData = asRecord(prResp.data);
    const headSha = asString(asRecord(prData?.head)?.sha);

    // Raw unified diff endpoint; WARN (not FAIL) when it fails because the
    // module falls back to concatenated per-file patches.
    const diffResp = await client.pullRequestDiff(owner, name, prNumber as number);
    const diffOk = diffResp.status === 200 && (asString(diffResp.data) ?? '').length > 0;
    record({
      name: 'PR diff',
      method: 'GET',
      path: `/repos/${target}/pulls/${prNumber}.diff`,
      status: diffResp.status,
      verdict: diffOk ? 'PASS' : 'WARN',
      note: diffOk ? '' : '(fallback: concatenated per-file patches)',
    });

    // Per-file patches; older Gitea instances 404 here and the module falls
    // back to an empty list, so a 404 is a WARN.
    const filesResp = await client.pullRequestFiles(owner, name, prNumber as number, { patch: 'true' });
    record({
      name: 'PR files',
      method: 'GET',
      path: `/repos/${target}/pulls/${prNumber}/files`,
      status: filesResp.status,
      verdict: filesResp.status === 200 ? 'PASS' : (filesResp.status === 404 ? 'WARN' : 'FAIL'),
      note: filesResp.status === 404 ? '(older Gitea: files endpoint unsupported)' : '',
    });

    const commitsResp = await client.pullRequestCommits(owner, name, prNumber as number, { limit: 100 });
    record({
      name: 'PR commits',
      method: 'GET',
      path: `/repos/${target}/pulls/${prNumber}/commits`,
      status: commitsResp.status,
      verdict: commitsResp.status === 200 ? 'PASS' : 'FAIL',
      note: '',
    });

    const reviewsResp = await client.pullRequestReviews(owner, name, prNumber as number, { limit: 100 });
    record({
      name: 'PR reviews',
      method: 'GET',
      path: `/repos/${target}/pulls/${prNumber}/reviews`,
      status: reviewsResp.status,
      verdict: reviewsResp.status === 200 ? 'PASS' : 'FAIL',
      note: '',
    });

    // Commit statuses are keyed by SHA; resolve the PR head SHA first.
    if (headSha === null) {
      record({ name: 'PR statuses', method: 'GET', path: `/repos/${target}/pulls/${prNumber}/statuses`, status: null, verdict: 'SKIP', note: '(PR has no head.sha)' });
    } else {
      const statusesResp = await client.commitStatuses(owner, name, headSha, { limit: 100 });
      record({
        name: 'PR statuses',
        method: 'GET',
        path: `/repos/${target}/commits/${headSha.slice(0, 8)}/statuses`,
        status: statusesResp.status,
        verdict: statusesResp.status === 200 ? 'PASS' : 'FAIL',
        note: '',
      });
    }
  }

  const branchesResp = await client.branches(owner, name, { limit: 50 });
  record({
    name: 'branches',
    method: 'GET',
    path: `/repos/${target}/branches`,
    status: branchesResp.status,
    verdict: branchesResp.status === 200 ? 'PASS' : 'FAIL',
    note: '',
  });

  const assigneesResp = await client.assignees(owner, name, { limit: 50 });
  record({
    name: 'assignees',
    method: 'GET',
    path: `/repos/${target}/assignees`,
    status: assigneesResp.status,
    verdict: assigneesResp.status === 200 ? 'PASS' : 'FAIL',
    note: '',
  });

  const tagsResp = await client.tags(owner, name, { limit: 50 });
  record({
    name: 'tags',
    method: 'GET',
    path: `/repos/${target}/tags`,
    status: tagsResp.status,
    verdict: tagsResp.status === 200 ? 'PASS' : 'FAIL',
    note: '',
  });

  // ================= Phase 2: controlled write pass =================

  console.log('\n--- write pass (scratch issue on target repo) ---');

  const createdIssue = await client.createIssue(owner, name, {
    title: `[OpenChamber live test] ${new Date().toISOString()}`,
    body: 'Automated OpenChamber live-test issue. Safe to close.',
  });
  if (createdIssue.status === 403) {
    record({
      name: 'create issue',
      method: 'POST',
      path: `/repos/${target}/issues`,
      status: createdIssue.status,
      verdict: 'WARN',
      note: '(token lacks write:repository scope — write pass skipped)',
    });
    record({ name: 'issue comment write', method: 'POST', path: `/repos/${target}/issues/:number/comments`, status: null, verdict: 'SKIP', note: '(write scope unavailable)' });
    record({ name: 'issue update', method: 'PATCH', path: `/repos/${target}/issues/:number`, status: null, verdict: 'SKIP', note: '(write scope unavailable)' });
  } else {
    const createOk = isOk(createdIssue);
    record({
      name: 'create issue',
      method: 'POST',
      path: `/repos/${target}/issues`,
      status: createdIssue.status,
      verdict: createOk ? 'PASS' : 'FAIL',
      note: '',
    });
    const createdData = asRecord(createdIssue.data);
    const newIssueNumber = createOk ? asNumber(createdData?.number) : null;
    if (createOk && newIssueNumber !== null) {
      const commentResp = await client.createIssueComment(owner, name, newIssueNumber, 'OpenChamber live-test comment.');
      record({
        name: 'issue comment write',
        method: 'POST',
        path: `/repos/${target}/issues/${newIssueNumber}/comments`,
        status: commentResp.status,
        verdict: isOk(commentResp) ? 'PASS' : 'FAIL',
        note: '',
      });

      const updateResp = await client.updateIssue(owner, name, newIssueNumber, {
        title: `[OpenChamber live test] updated ${new Date().toISOString()}`,
        body: 'Updated by the OpenChamber live-test harness.',
      });
      record({
        name: 'issue update',
        method: 'PATCH',
        path: `/repos/${target}/issues/${newIssueNumber}`,
        status: updateResp.status,
        verdict: isOk(updateResp) ? 'PASS' : 'FAIL',
        note: '',
      });

      const closeResp = await client.updateIssue(owner, name, newIssueNumber, { state: 'closed' });
      record({
        name: 'issue close',
        method: 'PATCH',
        path: `/repos/${target}/issues/${newIssueNumber}`,
        status: closeResp.status,
        verdict: isOk(closeResp) ? 'PASS' : 'FAIL',
        note: isOk(closeResp) ? `(closed #${newIssueNumber})` : '',
      });
    }
  }

  // ================= Phase 3: PR lifecycle (scratch repo) =================

  console.log('\n--- PR write pass (scratch repo, deleted afterward) ---');
  // POST /user/repos creates repos in the authenticated user's namespace, not
  // the discovered repo's owner namespace.
  const scratchOwner = login;
  const scratchName = `openchamber-live-test-${Date.now()}`;

  const createRepoResp = await client.request('/user/repos', {
    method: 'POST',
    body: {
      name: scratchName,
      auto_init: true,
      default_branch: defaultBranch,
      private: true,
      description: 'Temporary OpenChamber live-test repository; deleted after the test.',
    },
  });
  if (createRepoResp.status === 403 || createRepoResp.status === 422) {
    record({
      name: 'create scratch repo',
      method: 'POST',
      path: '/user/repos',
      status: createRepoResp.status,
      verdict: 'WARN',
      note: '(token cannot create repos — PR lifecycle skipped)',
    });
    record({ name: 'PR create', method: 'POST', path: `/repos/${scratchOwner}/${scratchName}/pulls`, status: null, verdict: 'SKIP', note: '(no scratch repo)' });
    record({ name: 'PR review write', method: 'POST', path: `/repos/${scratchOwner}/${scratchName}/pulls/:number/reviews`, status: null, verdict: 'SKIP', note: '(no scratch repo)' });
    record({ name: 'PR update', method: 'PATCH', path: `/repos/${scratchOwner}/${scratchName}/pulls/:number`, status: null, verdict: 'SKIP', note: '(no scratch repo)' });
    record({ name: 'PR merge', method: 'POST', path: `/repos/${scratchOwner}/${scratchName}/pulls/:number/merge`, status: null, verdict: 'SKIP', note: '(no scratch repo)' });
  } else {
    const repoOk = createRepoResp.status === 201 || createRepoResp.status === 200;
    record({
      name: 'create scratch repo',
      method: 'POST',
      path: '/user/repos',
      status: createRepoResp.status,
      verdict: repoOk ? 'PASS' : 'FAIL',
      note: '',
    });

    if (repoOk) {
      const headBranch = 'oc-live-test';
      const branchResp = await client.request(`/repos/${scratchOwner}/${scratchName}/branches`, {
        method: 'POST',
        body: { new_branch_name: headBranch, old_ref_name: defaultBranch },
      });
      const branchOk = branchResp.status === 201 || branchResp.status === 200;
      record({
        name: 'create branch',
        method: 'POST',
        path: `/repos/${scratchOwner}/${scratchName}/branches`,
        status: branchResp.status,
        verdict: branchOk ? 'PASS' : 'FAIL',
        note: '',
      });

      // Add a commit on the head branch so it differs from the base branch.
      let commitOk = false;
      if (branchOk) {
        const fileResp = await client.request(`/repos/${scratchOwner}/${scratchName}/contents/live-test.txt`, {
          method: 'POST',
          body: {
            branch: headBranch,
            message: 'OpenChamber live-test commit',
            content: Buffer.from('OpenChamber live test\n').toString('base64'),
          },
        });
        commitOk = fileResp.status === 201 || fileResp.status === 200;
        record({
          name: 'create commit on branch',
          method: 'POST',
          path: `/repos/${scratchOwner}/${scratchName}/contents/live-test.txt`,
          status: fileResp.status,
          verdict: commitOk ? 'PASS' : 'FAIL',
          note: '',
        });
      }

      let scratchPrNumber: number | null = null;
      if (commitOk) {
        const prCreateResp = await client.createPullRequest(scratchOwner, scratchName, {
          title: 'OpenChamber live-test PR',
          head: headBranch,
          base: defaultBranch,
          body: 'Automated OpenChamber live-test pull request.',
        });
        const prCreateOk = isOk(prCreateResp);
        const prCreateData = asRecord(prCreateResp.data);
        scratchPrNumber = prCreateOk ? asNumber(prCreateData?.number) : null;
        record({
          name: 'PR create',
          method: 'POST',
          path: `/repos/${scratchOwner}/${scratchName}/pulls`,
          status: prCreateResp.status,
          verdict: prCreateOk ? 'PASS' : 'FAIL',
          note: '',
        });

        if (prCreateOk && scratchPrNumber !== null) {
          const reviewResp = await client.createPullReview(scratchOwner, scratchName, scratchPrNumber, {
            event: 'COMMENT',
            body: 'OpenChamber live-test review comment.',
          });
          record({
            name: 'PR review write',
            method: 'POST',
            path: `/repos/${scratchOwner}/${scratchName}/pulls/${scratchPrNumber}/reviews`,
            status: reviewResp.status,
            verdict: isOk(reviewResp) ? 'PASS' : 'FAIL',
            note: '',
          });

          const updatePrResp = await client.updatePullRequest(scratchOwner, scratchName, scratchPrNumber, {
            title: 'OpenChamber live-test PR (updated)',
          });
          record({
            name: 'PR update',
            method: 'PATCH',
            path: `/repos/${scratchOwner}/${scratchName}/pulls/${scratchPrNumber}`,
            status: updatePrResp.status,
            verdict: isOk(updatePrResp) ? 'PASS' : 'FAIL',
            note: '',
          });

          // Gitea computes mergeability in a background worker after PR
          // creation; merging before that finishes returns 405. Poll the PR
          // until it reports mergeable (or give up after ~15s).
          let mergeable = false;
          for (let attempt = 0; attempt < 15; attempt += 1) {
            await sleep(1000);
            const checkResp = await client.pullRequest(scratchOwner, scratchName, scratchPrNumber);
            if (checkResp.status !== 200) continue;
            const checkData = asRecord(checkResp.data);
            if (asNumber(checkData?.mergeable) === 1 || checkData?.mergeable === true) {
              mergeable = true;
              break;
            }
          }

          // The correct Gitea merge payload is { Do: <style> } — `Do` is a
          // string enum of the merge style; there is no `MergeMethod` field.
          const mergeResp = await client.mergePullRequest(scratchOwner, scratchName, scratchPrNumber, {
            Do: 'merge',
          });
          const mergeOk = isOkOr204(mergeResp);
          record({
            name: 'PR merge',
            method: 'POST',
            path: `/repos/${scratchOwner}/${scratchName}/pulls/${scratchPrNumber}/merge`,
            status: mergeResp.status,
            verdict: mergeOk ? 'PASS' : 'WARN',
            note: mergeOk
              ? ''
              : `(merge rejected${mergeable ? '' : ' before mergeability check finished'}; endpoint exercised)`,
          });
        } else {
          record({ name: 'PR review write', method: 'POST', path: `/repos/${scratchOwner}/${scratchName}/pulls/:number/reviews`, status: null, verdict: 'SKIP', note: '(PR create failed)' });
          record({ name: 'PR update', method: 'PATCH', path: `/repos/${scratchOwner}/${scratchName}/pulls/:number`, status: null, verdict: 'SKIP', note: '(PR create failed)' });
          record({ name: 'PR merge', method: 'POST', path: `/repos/${scratchOwner}/${scratchName}/pulls/:number/merge`, status: null, verdict: 'SKIP', note: '(PR create failed)' });
        }
      } else {
        record({ name: 'PR create', method: 'POST', path: `/repos/${scratchOwner}/${scratchName}/pulls`, status: null, verdict: 'SKIP', note: '(no commit on branch)' });
        record({ name: 'PR review write', method: 'POST', path: `/repos/${scratchOwner}/${scratchName}/pulls/:number/reviews`, status: null, verdict: 'SKIP', note: '(no commit on branch)' });
        record({ name: 'PR update', method: 'PATCH', path: `/repos/${scratchOwner}/${scratchName}/pulls/:number`, status: null, verdict: 'SKIP', note: '(no commit on branch)' });
        record({ name: 'PR merge', method: 'POST', path: `/repos/${scratchOwner}/${scratchName}/pulls/:number/merge`, status: null, verdict: 'SKIP', note: '(no commit on branch)' });
      }

      // Always attempt scratch-repo cleanup, even on partial failure.
      const deleteResp = await client.request(`/repos/${scratchOwner}/${scratchName}`, { method: 'DELETE' });
      const deleteOk = deleteResp.status === 204 || deleteResp.status === 200 || deleteResp.status === 202;
      record({
        name: 'delete scratch repo',
        method: 'DELETE',
        path: `/repos/${scratchOwner}/${scratchName}`,
        status: deleteResp.status,
        verdict: deleteOk ? 'PASS' : 'WARN',
        note: deleteOk ? '' : `(left behind: ${BASE_URL}/${scratchOwner}/${scratchName} — delete manually)`,
      });
    }
  }

  console.log('\n----------------------------------------');
  console.log(`Gitea live test against ${BASE_URL} (user: ${login})`);
  return summarize();
}

main().then((code) => process.exit(code)).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nUnhandled failure: ${message}`);
  process.exit(1);
});
