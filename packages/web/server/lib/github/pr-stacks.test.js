import { describe, expect, test } from 'bun:test';

import { findStackParent, inferChain, mergeStackBottom, registerPullStack, resolvePullStack, resolveStackMembership, selectStackParent } from './pr-stacks.js';

const pull = (number, head, base, extra = {}) => ({
  number,
  title: `PR ${number}`,
  html_url: `https://github.com/acme/app/pull/${number}`,
  draft: false,
  head: { ref: head, sha: `sha-${number}`, repo: { full_name: 'acme/app' } },
  base: { ref: base, repo: { full_name: 'acme/app', default_branch: 'main' } },
  ...extra,
});

const fakeOctokit = ({ open = [], closed = [], native = null, nativeStatus = 404, summaries = true, compare = 0, aheadShas = [] } = {}) => {
  const calls = [];
  const octokit = {
    calls,
    rest: {
      pulls: {
        list: async ({ state, head, base }) => {
          calls.push(['list', state, head ?? null]);
          if (state === 'open') return { data: open };
          if (base) return { data: closed.filter((entry) => entry.base.ref === base) };
          return { data: closed.filter((entry) => `acme:${entry.head.ref}` === head) };
        },
        update: async (args) => { calls.push(['update', args.pull_number, args.base]); return { data: {} }; },
        merge: async (args) => { calls.push(['merge', args.pull_number, args.merge_method, args.sha]); return { data: { merged: true } }; },
      },
      repos: {
        compareCommitsWithBasehead: async () => ({ data: { behind_by: compare, commits: aheadShas.map((sha) => ({ sha })) } }),
      },
    },
    request: async (route, args) => {
      calls.push([route, args.pull_requests ?? args.pull_request ?? null]);
      if (route === 'GET /repos/{owner}/{repo}/stacks') {
        if (native) return { data: [native] };
        throw Object.assign(new Error('Not Found'), { status: nativeStatus });
      }
      if (route === 'POST /repos/{owner}/{repo}/stacks') return { data: { number: 7 } };
      if (route.includes('/merge-async')) return { data: { status: 'merged', details: { message: 'ok', sha: 'x' } } };
      throw new Error(`unexpected ${route}`);
    },
    graphql: async (_query, variables) => {
      if (!summaries) throw new Error('graphql down');
      const data = {};
      for (const key of Object.keys(variables).filter((name) => name.startsWith('p'))) {
        const index = key.slice(1);
        data[`a${index}`] = { pullRequest: {
          number: variables[key], title: `PR ${variables[key]}`, state: 'OPEN', isDraft: false,
          mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', headRefOid: `sha-${variables[key]}`,
          baseRefName: open.find((entry) => entry.number === variables[key])?.base.ref ?? 'main',
          commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
        } };
      }
      return data;
    },
  };
  return octokit;
};

describe('inferChain', () => {
  test('orders the chain bottom to top and lists side branches', () => {
    const pulls = [pull(3, 'c', 'b'), pull(1, 'a', 'main'), pull(2, 'b', 'a'), pull(4, 'd', 'a')];
    const result = inferChain(pulls, 'acme', 'app', 3);
    expect(result.chain.map((entry) => entry.number)).toEqual([1, 2, 3]);
    expect(result.branches.map((entry) => entry.number)).toEqual([4]);
  });

  test('ignores a fork head that happens to share the base name', () => {
    const fork = pull(1, 'a', 'main', { head: { ref: 'a', sha: 'f', repo: { full_name: 'someone/app' } } });
    const result = inferChain([fork, pull(2, 'b', 'a')], 'acme', 'app', 2);
    expect(result.chain.map((entry) => entry.number)).toEqual([2]);
  });

  test.each([1, 2])('keeps unrelated fork and local branches separate from anchor %i', (number) => {
    const fork = pull(1, 'a', 'main', { head: { ref: 'a', sha: 'f', repo: { full_name: 'someone/app' } } });
    const result = inferChain([fork, pull(2, 'b', 'a'), pull(3, 'c', 'a')], 'acme', 'app', number);
    expect(result.chain.map((entry) => entry.number)).toEqual([number]);
    expect(result.branches).toEqual([]);
  });

  test.each([1, 2])('compares the actual base repository from anchor %i', (number) => {
    const child = pull(2, 'b', 'a', { base: { ref: 'a', repo: { full_name: 'someone/app' } } });
    const result = inferChain([pull(1, 'a', 'main'), child], 'acme', 'app', number);
    expect(result.chain.map((entry) => entry.number)).toEqual([number]);
    expect(result.branches).toEqual([]);
  });

  test('keeps only repository-matched side branches', () => {
    const foreignBase = pull(4, 'd', 'a', { base: { ref: 'a', repo: { full_name: 'someone/app' } } });
    const fork = pull(5, 'e', 'a', { head: { ref: 'e', sha: 'f', repo: { full_name: 'someone/app' } } });
    const result = inferChain([pull(1, 'a', 'main'), pull(2, 'b', 'a'), pull(3, 'c', 'a'), foreignBase, fork], 'acme', 'app', 2);
    expect(result.chain.map((entry) => entry.number)).toEqual([1, 2]);
    expect(result.branches.map((entry) => entry.number)).toEqual([3]);
  });

  test('compares repository names case-insensitively and branch names exactly', () => {
    const parent = pull(1, 'a', 'main', { head: { ref: 'a', sha: 's1', repo: { full_name: 'ACME/APP' } } });
    const child = pull(2, 'b', 'a', { base: { ref: 'a', repo: { full_name: 'Acme/App' } } });
    const result = inferChain([parent, child, pull(3, 'c', 'A')], 'acme', 'app', 2);
    expect(result.chain.map((entry) => entry.number)).toEqual([1, 2]);
    expect(result.branches).toEqual([]);
  });

  test('rejects incomplete membership when an inferred chain exceeds the member budget', () => {
    // Given a chain longer than the supported read budget.
    const pulls = Array.from({ length: 21 }, (_, index) => pull(index + 1, `branch-${index + 1}`, index === 0 ? 'main' : `branch-${index}`));

    // When inferring membership from the bottom anchor.
    const resolve = () => inferChain(pulls, 'acme', 'app', 1);

    // Then partial membership cannot be reported as the complete stack.
    expect(resolve).toThrow('exceeds the read budget');
  });
});

describe('resolvePullStack', () => {
  test('infers a stack when GitHub has no native one', async () => {
    const octokit = fakeOctokit({ open: [pull(1, 'a', 'main'), pull(2, 'b', 'a')], compare: 2 });
    const stack = await resolvePullStack({ octokit, owner: 'acme', repo: 'app', number: 2 });
    expect(stack.source).toBe('inferred');
    expect(stack.trunk).toBe('main');
    expect(stack.members.map((member) => [member.number, member.summary, member.behindBase])).toEqual([[1, 'ok', 2], [2, 'ok', 2]]);
    expect(stack.nativeUnavailable).toBe(false);
  });

  test('a lone PR is not a stack', async () => {
    const octokit = fakeOctokit({ open: [pull(1, 'a', 'main')] });
    expect(await resolvePullStack({ octokit, owner: 'acme', repo: 'app', number: 1 })).toBeNull();
  });

  test.each([1, 2])('does not resolve an unrelated fork collision as a stack from anchor %i', async (number) => {
    const fork = pull(1, 'a', 'main', { head: { ref: 'a', sha: 'f', repo: { full_name: 'someone/app' } } });
    const octokit = fakeOctokit({ open: [fork, pull(2, 'b', 'a'), pull(3, 'c', 'a')] });
    expect(await resolvePullStack({ octokit, owner: 'acme', repo: 'app', number })).toBeNull();
  });

  test.each(['head', 'base'])('rejects unknown %s repository identity instead of inferring membership', async (side) => {
    for (const repo of [null, undefined, {}, { full_name: '' }]) {
      const unknown = pull(2, 'b', 'a');
      unknown[side].repo = repo;
      const octokit = fakeOctokit({ open: [pull(1, 'a', 'main'), unknown] });
      await expect(resolvePullStack({ octokit, owner: 'acme', repo: 'app', number: 2 })).rejects.toThrow('repository identity');
    }
  });

  test('native membership stays authoritative while inferred side branches match repositories', async () => {
    const fork = pull(1, 'a', 'main', { head: { ref: 'a', sha: 'f', repo: { full_name: 'someone/app' } } });
    const native = { number: 5, open: true, pull_requests: [fork, pull(4, 'd', 'main')] };
    const octokit = fakeOctokit({ open: [fork, pull(2, 'b', 'a'), pull(3, 'c', 'a'), pull(4, 'd', 'main')], native });
    const stack = await resolvePullStack({ octokit, owner: 'acme', repo: 'app', number: 1 });
    expect(stack.source).toBe('native');
    expect(stack.members.map((member) => member.number)).toEqual([1, 4]);
    expect(stack.branches).toEqual([]);
  });

  test('a failed summary read leaves members unknown instead of green', async () => {
    const octokit = fakeOctokit({ open: [pull(1, 'a', 'main'), pull(2, 'b', 'a')], summaries: false });
    const stack = await resolvePullStack({ octokit, owner: 'acme', repo: 'app', number: 1 });
    expect(stack.members.every((member) => member.summary === 'unknown' && member.checks === null)).toBe(true);
  });

  test('a failed open-PR read throws instead of answering "not stacked"', async () => {
    const octokit = fakeOctokit();
    octokit.rest.pulls.list = async () => { throw Object.assign(new Error('boom'), { status: 500 }); };
    await expect(resolvePullStack({ octokit, owner: 'acme', repo: 'app', number: 1 })).rejects.toThrow('boom');
  });

  test('rejects an unknown native read when inference cannot establish a stack', async () => {
    // Given a lone PR and a failed native membership read.
    const octokit = fakeOctokit({ open: [pull(1, 'a', 'main')], nativeStatus: 500 });

    // When resolving its stack.
    const result = resolvePullStack({ octokit, owner: 'acme', repo: 'app', number: 1 });

    // Then unavailable native membership cannot become authoritative null.
    await expect(result).rejects.toThrow('native stack membership is unavailable');
  });

  test('rejects malformed open members when inference would otherwise drop them', async () => {
    // Given a provider list containing a malformed member.
    const octokit = fakeOctokit({ open: [pull(1, 'a', 'main'), { number: 2 }] });

    // When resolving the anchor.
    const result = resolvePullStack({ octokit, owner: 'acme', repo: 'app', number: 1 });

    // Then malformed data cannot reduce membership to an unstacked success.
    await expect(result).rejects.toThrow('invalid pull request');
  });

  test('keeps malformed native membership unavailable when it cannot be inferred', async () => {
    // Given a malformed native stack and no inferable chain.
    const octokit = fakeOctokit({ native: { number: 5, pull_requests: [{}] } });

    // When resolving the linked anchor.
    const result = resolvePullStack({ octokit, owner: 'acme', repo: 'app', number: 1 });

    // Then malformed membership cannot become a successful null snapshot.
    await expect(result).rejects.toThrow('native stack membership is unavailable');
  });

  test('rejects a possibly truncated open list when the read budget is exhausted', async () => {
    // Given three full pages, which cannot establish complete membership.
    const octokit = fakeOctokit({ open: Array.from({ length: 100 }, (_, index) => pull(index + 1, `b${index}`, 'main')) });

    // When resolving the anchor.
    const result = resolvePullStack({ octokit, owner: 'acme', repo: 'app', number: 1 });

    // Then the incomplete list remains a read failure.
    await expect(result).rejects.toThrow('may be incomplete');
  });

  test('the native stack wins and keeps merged members in order', async () => {
    const native = {
      number: 5, open: true, base: { ref: 'main' },
      pull_requests: [
        { number: 1, state: 'closed', draft: false, merged_at: '2026-10-01T00:00:00Z', head: { ref: 'a', sha: 's1' } },
        { number: 2, state: 'open', draft: false, merged_at: null, head: { ref: 'b', sha: 's2' } },
      ],
    };
    const octokit = fakeOctokit({ open: [pull(2, 'b', 'main')], native });
    const stack = await resolvePullStack({ octokit, owner: 'acme', repo: 'app', number: 2 });
    expect(stack.source).toBe('native');
    expect(stack.nativeNumber).toBe(5);
    expect(stack.members.map((member) => [member.number, member.state])).toEqual([[1, 'merged'], [2, 'open']]);
  });

  test('a bottom PR whose parent merged is marked for retargeting', async () => {
    const octokit = fakeOctokit({
      open: [pull(2, 'b', 'a'), pull(3, 'c', 'b')],
      closed: [pull(1, 'a', 'main', { merged_at: '2026-10-01T00:00:00Z' })],
    });
    const stack = await resolvePullStack({ octokit, owner: 'acme', repo: 'app', number: 3 });
    expect(stack.members[0]).toMatchObject({ number: 2, retargetTo: 'main' });
  });
});

describe('merged parent', () => {
  test('a PR moved onto the trunk that still carries a squashed parent names it', async () => {
    const octokit = fakeOctokit({
      open: [pull(2, 'b', 'main')],
      closed: [pull(1, 'a', 'main', { merged_at: '2026-10-01T00:00:00Z' })],
      aheadShas: ['sha-1', 'sha-2'],
    });
    const stack = await resolvePullStack({ octokit, owner: 'acme', repo: 'app', number: 2 });
    expect(stack.members).toHaveLength(1);
    expect(stack.members[0].mergedParent).toEqual({ number: 1, head: 'a', headSha: 'sha-1' });
  });

  test('a lone PR whose commits hold no merged head is not a stack', async () => {
    const octokit = fakeOctokit({
      open: [pull(2, 'b', 'main')],
      closed: [pull(1, 'a', 'main', { merged_at: '2026-10-01T00:00:00Z' })],
      aheadShas: ['sha-2'],
    });
    expect(await resolvePullStack({ octokit, owner: 'acme', repo: 'app', number: 2 })).toBeNull();
  });
});

describe('stack writes', () => {
  test('register creates a native stack from the chain below', async () => {
    const octokit = fakeOctokit({ open: [pull(1, 'a', 'main'), pull(2, 'b', 'a')], nativeStatus: 404 });
    // 404 on the stacks read means "none yet" here, so the stack is created.
    const result = await registerPullStack({ octokit, owner: 'acme', repo: 'app', number: 2 });
    expect(result).toEqual({ registered: true, nativeNumber: 7 });
    expect(octokit.calls).toContainEqual(['POST /repos/{owner}/{repo}/stacks', [1, 2]]);
  });

  test('register reports unavailable stacks without failing', async () => {
    const octokit = fakeOctokit({ open: [pull(1, 'a', 'main'), pull(2, 'b', 'a')], nativeStatus: 500 });
    const result = await registerPullStack({ octokit, owner: 'acme', repo: 'app', number: 2 });
    expect(result).toMatchObject({ registered: false, reason: 'unavailable' });
  });

  test('only the bottom PR merges, and the next one moves onto the trunk', async () => {
    const octokit = fakeOctokit({ open: [pull(1, 'a', 'main'), pull(2, 'b', 'a')] });
    await expect(mergeStackBottom({ octokit, owner: 'acme', repo: 'app', number: 2, method: 'squash' })).rejects.toThrow('bottom');
    const result = await mergeStackBottom({ octokit, owner: 'acme', repo: 'app', number: 1, method: 'squash' });
    expect(result).toEqual({ merged: true, status: 'merged', retargeted: 2 });
    expect(octokit.calls).toContainEqual(['merge', 1, 'squash', 'sha-1']);
    expect(octokit.calls).toContainEqual(['update', 2, 'main']);
  });
});

describe('stack parent of a new branch', () => {
  const base = { owner: 'acme', repo: 'app', branch: 'three', trunk: 'main', capped: false, createdFrom: null };

  test('picks the open PR whose head is the nearest of the branch commits', () => {
    const pulls = [pull(3, 'one', 'main'), pull(4, 'two', 'one')];
    const result = selectStackParent({ ...base, pulls, ownCommits: ['own', 'sha-4', 'sha-3'] });
    expect(result).toEqual({ status: 'found', via: 'ancestry', parent: { number: 4, head: 'two', title: 'PR 4', url: 'https://github.com/acme/app/pull/4' } });
  });

  test('breaks a tie on the same commit with the reflog parent, otherwise reports ambiguity', () => {
    const pulls = [pull(4, 'two', 'one'), pull(7, 'copy', 'main', { head: { ref: 'copy', sha: 'sha-4', repo: { full_name: 'acme/app' } } })];
    expect(selectStackParent({ ...base, pulls, ownCommits: ['own', 'sha-4'], createdFrom: 'copy' }))
      .toMatchObject({ status: 'found', parent: { number: 7 } });
    expect(selectStackParent({ ...base, pulls, ownCommits: ['own', 'sha-4'] }))
      .toMatchObject({ status: 'ambiguous', candidates: [{ number: 4 }, { number: 7 }] });
  });

  test('falls back to the reflog parent when that PR got commits after the branch was created', () => {
    const pulls = [pull(4, 'two', 'one')];
    expect(selectStackParent({ ...base, pulls, ownCommits: ['own', 'older-two'], createdFrom: 'two' }))
      .toMatchObject({ status: 'found', via: 'created-from', parent: { number: 4 } });
  });

  test('ignores fork heads, the branch itself and the trunk', () => {
    const pulls = [
      pull(5, 'two', 'main', { head: { ref: 'two', sha: 'sha-5', repo: { full_name: 'someone/app' } } }),
      pull(6, 'three', 'main'),
      pull(8, 'main', 'release'),
    ];
    expect(selectStackParent({ ...base, pulls, ownCommits: ['sha-6', 'sha-5', 'sha-8'], createdFrom: 'two' })).toEqual({ status: 'none' });
  });

  test('a capped commit list without a match is incomplete, never none', () => {
    expect(selectStackParent({ ...base, pulls: [pull(3, 'one', 'main')], ownCommits: ['own'], capped: true })).toEqual({ status: 'incomplete' });
  });

  test('a failed open PR read throws instead of answering none', async () => {
    const octokit = { rest: { pulls: { list: async () => { throw Object.assign(new Error('boom'), { status: 500 }); } } } };
    await expect(findStackParent({
      octokit, owner: 'acme', repo: 'app', branch: 'three', remote: 'origin',
      listOwnCommits: async () => ({ commits: [], capped: false }), readCreatedFrom: async () => null,
    })).rejects.toThrow('boom');
  });

  test('answers unavailable without a remote for the target or a local trunk ref', async () => {
    const octokit = fakeOctokit({ open: [pull(3, 'one', 'main')] });
    const input = { octokit, owner: 'acme', repo: 'app', branch: 'three', readCreatedFrom: async () => null };
    expect(await findStackParent({ ...input, remote: null, listOwnCommits: async () => null })).toEqual({ status: 'unavailable' });
    expect(await findStackParent({ ...input, remote: 'origin', listOwnCommits: async () => null })).toEqual({ status: 'unavailable' });
    expect(await findStackParent({ ...input, remote: 'origin', listOwnCommits: async ({ trunk }) => (trunk === 'main' ? { commits: ['sha-3'], capped: false } : null) }))
      .toMatchObject({ status: 'found', parent: { number: 3 } });
  });
});

describe('stack membership of several PRs', () => {
  test('answers in a stack, not in one, and unknown for PRs that are not open, from one list read', async () => {
    const octokit = fakeOctokit({ open: [pull(3, 'one', 'main'), pull(4, 'two', 'one'), pull(5, 'lone', 'main')] });
    expect(await resolveStackMembership({ octokit, owner: 'acme', repo: 'app', numbers: [3, 4, 5, 9] }))
      .toEqual({ 3: true, 4: true, 5: false, 9: null });
    expect(octokit.calls.filter(([kind]) => kind === 'list')).toHaveLength(1);
  });

  test('a failed list read throws instead of answering not stacked', async () => {
    const octokit = { rest: { pulls: { list: async () => { throw Object.assign(new Error('boom'), { status: 500 }); } } } };
    await expect(resolveStackMembership({ octokit, owner: 'acme', repo: 'app', numbers: [3] })).rejects.toThrow('boom');
  });
});
