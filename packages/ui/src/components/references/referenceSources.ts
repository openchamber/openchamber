/**
 * Where the picker's lists and previews come from, one cache per kind of
 * answer. Cache keys carry the runtime, the account and the project, so a
 * different account or host never sees another one's list.
 *
 * Repository items are read with the project's read context: the account its
 * binding names, or the current account of the host for a repository nobody
 * bound, the same one the Git view reads with. A GitLab project lists through
 * the same rows and preview as a GitHub one (`gitlabReferences.ts`).
 */

import * as React from 'react';

import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type {
    GitHubPullReference,
    GitHubPullStatus,
    GitHubReference,
    GitHubReferenceDetail,
    GitHubReferenceFilter,
    GitHubReferenceKind,
    LinearAPI,
    LinearIssue,
    LinearIssueSummary,
    SourceControlIdentity,
    SourceControlProvider,
    SourceControlReadContext,
} from '@/lib/api/types';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { GITHUB_SOURCE_CONTROL_IDENTITY, resolveSourceControlIdentity } from '@/lib/source-control/identity';
import { getSourceControlAuthKey, useSourceControlAuthStore } from '@/stores/useSourceControlAuthStore';
import { useRepositoryBinding } from '@/lib/source-control/repository-binding';
import { useLinearAuthStore } from '@/stores/useLinearAuthStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { normalizeProjectPath, resolveProjectForSessionDirectory } from '@/lib/projectResolution';
import {
    rememberedRepositoryProvider,
    rememberRepositoryProvider,
    subscribeRepositoryProviderMemory,
} from '@/lib/source-control/repositoryProviderMemory';


import { fetchGitLabReferenceDetail, fetchGitLabReferencePage } from './gitlabReferences';
import { createListCache, createValueCache, useCachedList, useCachedValue, type CachedValue, type ListPage } from './referenceCache';
import type { LinearReferenceFilter } from './referencePickerItems';

const githubLists = createListCache<GitHubReference>();
const linearLists = createListCache<LinearIssueSummary>();
const linearDetails = createValueCache<LinearIssue>();
const githubDetails = createValueCache<GitHubReferenceDetail>();

export type ReferenceSourceStatus = 'ready' | 'disconnected' | 'unsupported';

const BUILT_IN_IDENTITIES: SourceControlIdentity[] = [
    GITHUB_SOURCE_CONTROL_IDENTITY,
    { provider: 'gitlab', instance: 'https://gitlab.com' },
];

/**
 * The project's binding and every host it lives on: the providers it is bound
 * to and the hosts its remotes point at, whether or not an account there works.
 */
function useRepositoryHosts(directory: string | null) {
    const { sourceControl } = useRuntimeAPIs();
    const binding = useRepositoryBinding(directory, sourceControl, Boolean(directory));
    const knownIdentities = useSourceControlAuthStore((state) => state.identities);
    const hosts = React.useMemo(() => {
        const read = binding.read;
        if (!read) return [];
        const found = new Map<string, SourceControlIdentity>();
        const add = (identity: SourceControlIdentity) => found.set(getSourceControlAuthKey(identity), identity);
        for (const provider of read.binding?.providers ?? []) add({ provider: provider.provider, instance: provider.instance });
        const identities = [...knownIdentities, ...BUILT_IN_IDENTITIES];
        for (const remote of read.repository.remotes) {
            const identity = resolveSourceControlIdentity(
                { name: remote.name, fetchUrl: remote.fetch.displayUrl, pushUrl: remote.push.displayUrl },
                identities,
            );
            if (identity) add(identity);
        }
        return [...found.values()];
    }, [binding.read, knownIdentities]);
    return { binding, hosts };
}

/**
 * The host whose account reads the project: its read context's, else the host
 * its remotes point at, GitHub first. Known even while no account there works,
 * so a surface can name GitLab and ask for that account instead of GitHub's.
 * Null while the binding loads or when the project lives on neither.
 */
export function useRepositoryHost(directory: string | null): SourceControlIdentity | null {
    const { binding, hosts } = useRepositoryHosts(directory);
    const context = binding.contexts[0] ?? null;
    const provider = context?.provider ?? null;
    const instance = context?.instance ?? null;
    return React.useMemo(() => {
        if (provider && instance) return { provider, instance };
        return hosts.find((host) => host.provider === 'github') ?? hosts.find((host) => host.provider === 'gitlab') ?? null;
    }, [hosts, instance, provider]);
}

/**
 * The read context a project's issues and change requests come from, once its
 * binding has been read: GitHub's when the project has one, else GitLab's.
 * Null while the binding or an account on one of its hosts is still loading,
 * and `missing` when no account can read it: no remote on a supported host, or
 * none of its hosts has a working account.
 */
export function useGitHubReadContext(directory: string | null): SourceControlReadContext | 'missing' | null {
    const { binding, hosts } = useRepositoryHosts(directory);
    const hostPending = useSourceControlAuthStore((state) => hosts
        .some((host) => !state.entries[getSourceControlAuthKey(host)]?.hasChecked));
    const context = binding.contexts.find((candidate) => candidate.provider === 'github')
        ?? binding.contexts.find((candidate) => candidate.provider === 'gitlab')
        ?? null;
    if (context) return context;
    if (binding.status === 'error') return 'missing';
    return binding.status === 'ready' && !hostPending ? 'missing' : null;
}

/**
 * The host a project's items come from.
 *
 * Read contexts name it once the binding and the accounts have both loaded,
 * but either can still be loading, and a binding nobody watches goes stale
 * with no contexts. The project's remotes say where it lives in all of those
 * moments, so they answer meanwhile; GitHub only when nothing says otherwise.
 * GitHub wins over GitLab when a project has both, as the read context does.
 */
export function useRepositoryReferenceProvider(directory: string | null): SourceControlProvider {
    const { binding, hosts } = useRepositoryHosts(directory);
    // A worktree shares its project's host, so the answer is kept per project.
    const projects = useProjectsStore((state) => state.projects);
    const worktreesByProject = useSessionUIStore((state) => state.availableWorktreesByProject);
    const projectPath = React.useMemo(() => {
        if (!directory) return null;
        const project = resolveProjectForSessionDirectory(projects, worktreesByProject, directory);
        return normalizeProjectPath(project?.path ?? directory);
    }, [directory, projects, worktreesByProject]);
    const runtimeKey = getRuntimeKey();
    const remembered = React.useSyncExternalStore(
        subscribeRepositoryProviderMemory,
        () => rememberedRepositoryProvider(runtimeKey, projectPath),
    );
    // What the project itself says, or null while nothing has loaded that could.
    const known = React.useMemo((): SourceControlProvider | null => {
        const providers = new Set<SourceControlProvider>(binding.contexts.map((context) => context.provider));
        if (!providers.size) for (const host of hosts) providers.add(host.provider);
        if (providers.has('github')) return 'github';
        return providers.has('gitlab') ? 'gitlab' : null;
    }, [binding.contexts, hosts]);
    React.useEffect(() => {
        if (known) rememberRepositoryProvider(runtimeKey, projectPath, known);
    }, [known, projectPath, runtimeKey]);
    return known ?? remembered ?? 'github';
}

/**
 * Whether the project's issues and change requests can be listed. A project
 * that lives on GitHub or GitLab but no account there can read it is
 * disconnected, and so is a project with no remote at all while no account is
 * connected anywhere.
 */
export function useGitHubSourceStatus(directory: string | null): ReferenceSourceStatus {
    const { runtime } = useRuntimeAPIs();
    const context = useGitHubReadContext(directory);
    const { hosts } = useRepositoryHosts(directory);
    const anyConnected = useSourceControlAuthStore((state) => Object.values(state.entries)
        .some((entry) => entry.status?.connected === true));
    const githubChecked = useSourceControlAuthStore((state) => Boolean(
        state.entries[getSourceControlAuthKey(GITHUB_SOURCE_CONTROL_IDENTITY)]?.hasChecked,
    ));
    if (runtime.isVSCode) return 'unsupported';
    if (context !== 'missing') return 'ready';
    return hosts.length > 0 || (githubChecked && !anyConnected) ? 'disconnected' : 'ready';
}

export function useLinearSourceStatus(): ReferenceSourceStatus {
    const { linear } = useRuntimeAPIs();
    const checked = useLinearAuthStore((state) => state.hasChecked);
    const connected = useLinearAuthStore((state) => state.status?.connected === true);
    if (!linear) return 'unsupported';
    return checked && !connected ? 'disconnected' : 'ready';
}

/**
 * Everything about a read context that changes what it answers: provider,
 * host, account, the bound repository and remote, and the binding revision.
 * Rebinding the directory moves to a new key, so an answer still in flight for
 * the old binding fills only the old key and never the new list.
 */
const readContextCacheKey = (context: SourceControlReadContext): unknown[] => [
    context.provider,
    context.instance,
    context.accountId,
    context.directory,
    context.repositoryId,
    context.primaryRemote,
    context.bindingRevision,
];

export function useGitHubReferenceList(options: {
    enabled: boolean;
    directory: string | null;
    kind: GitHubReferenceKind;
    filter: GitHubReferenceFilter;
    query: string;
}) {
    const { sourceControl } = useRuntimeAPIs();
    const { enabled, directory, kind, filter, query } = options;
    const context = useGitHubReadContext(enabled ? directory : null);
    const text = query.trim();
    const scope = context && context !== 'missing' ? readContextCacheKey(context) : 'missing';
    const key = enabled && directory && context
        ? JSON.stringify([getRuntimeKey(), scope, directory, kind, filter, text])
        : null;
    const fetchPage = React.useCallback(async (cursor: string | null): Promise<ListPage<GitHubReference>> => {
        if (!context || context === 'missing') return { kind: 'unavailable', reason: 'no-repo' };
        if (context.provider === 'gitlab') return fetchGitLabReferencePage(sourceControl, context, kind, text, cursor);
        const result = await sourceControl.githubReferences(context, { kind, filter, query: text, cursor });
        if (!result.connected) return { kind: 'unavailable', reason: 'disconnected' };
        if (!result.repo) return { kind: 'unavailable', reason: 'no-repo' };
        return { kind: 'page', items: result.items, cursor: result.cursor, hasMore: result.hasMore };
    }, [context, filter, kind, sourceControl, text]);
    return useCachedList(githubLists, key, fetchPage);
}

export function useLinearReferenceList(options: { enabled: boolean; filter: LinearReferenceFilter; query: string }) {
    const { linear } = useRuntimeAPIs();
    const workspace = useLinearAuthStore((state) => state.status?.organization?.id ?? '');
    const { enabled, filter, query } = options;
    const text = query.trim();
    const key = enabled && linear ? JSON.stringify([getRuntimeKey(), workspace, filter, text]) : null;
    const fetchPage = React.useCallback(async (cursor: string | null): Promise<ListPage<LinearIssueSummary>> => {
        if (!linear) return { kind: 'unavailable', reason: 'disconnected' };
        const result = await linear.issuesList({
            query: text || undefined,
            cursor: cursor ?? undefined,
            assignee: filter === 'assigned' ? 'me' : 'any',
        });
        if (result.connected === false) return { kind: 'unavailable', reason: 'disconnected' };
        return { kind: 'page', items: result.issues ?? [], cursor: result.cursor ?? null, hasMore: Boolean(result.hasMore) };
    }, [filter, linear, text]);
    return useCachedList(linearLists, key, fetchPage);
}

/**
 * Comments of the previewed issue or PR, and a PR's size and review. A cached
 * answer shows at once; GitHub is asked only once `settled` says the
 * highlight stopped on the item.
 */
export function useGitHubReferenceDetail(directory: string | null, reference: GitHubReference | null, settled: boolean) {
    const { sourceControl } = useRuntimeAPIs();
    const context = useGitHubReadContext(reference ? directory : null);
    const owner = reference?.sourceRepo.owner ?? '';
    const repo = reference?.sourceRepo.repo ?? '';
    const number = reference?.number ?? 0;
    // GitLab numbers issues and merge requests separately: #1 and !1 differ.
    const kind = reference?.kind ?? 'issue';
    const key = directory && reference && context && context !== 'missing'
        ? JSON.stringify([getRuntimeKey(), readContextCacheKey(context), directory, kind, owner, repo, number])
        : null;
    const fetch = React.useCallback(async (): Promise<GitHubReferenceDetail> => {
        if (!context || context === 'missing' || !reference) throw new Error('GitHub is not available here');
        if (context.provider === 'gitlab') return fetchGitLabReferenceDetail(sourceControl, context, reference);
        const result = await sourceControl.githubReferenceDetail(context, { owner, repo, number });
        if (!result.connected) throw new Error('GitHub is not connected');
        if (!result.detail) throw new Error('Not found');
        return result.detail;
    }, [context, number, owner, reference, repo, sourceControl]);
    return useCachedValue(githubDetails, key, fetch, settled);
}

// A key per PR and head commit: a push asks again, a page loaded later
// reuses what the earlier pages already answered.
const githubPullStatuses = createValueCache<GitHubPullStatus | null>(200);
// The server's limit: one listed page.
const PULL_STATUS_BATCH = 30;
const IDLE: CachedValue<GitHubPullStatus | null> = { status: 'idle' };

/** An open PR, draft or not: its preview shows checks, and a ready one is coloured by them. */
const needsPullStatus = (reference: GitHubReference): reference is GitHubPullReference => (
    reference.kind === 'pull' && reference.state === 'open'
);

const samePull = (status: GitHubPullStatus, pull: GitHubPullReference) => (
    status.number === pull.number
    && status.owner.toLowerCase() === pull.sourceRepo.owner.toLowerCase()
    && status.repo.toLowerCase() === pull.sourceRepo.repo.toLowerCase()
);

/**
 * Checks and mergeability of the open PRs a list shows, asked after the list
 * in batches of a page, so they colour like the sidebar. GitHub only: a GitLab
 * project's items, issues and closed PRs ask nothing and answer `idle`. A ready
 * null is a PR GitHub could not resolve.
 */
export function useGitHubPullStatuses(directory: string | null, references: readonly GitHubReference[]) {
    const { sourceControl } = useRuntimeAPIs();
    const context = useGitHubReadContext(directory);
    const github = context && context !== 'missing' && context.provider === 'github' ? context : null;
    const scope = github ? JSON.stringify([getRuntimeKey(), readContextCacheKey(github), directory]) : null;
    const keyOf = React.useCallback(
        (pull: GitHubPullReference) => `${scope}|${pull.sourceRepo.owner}/${pull.sourceRepo.repo}#${pull.number}@${pull.headSha}`,
        [scope],
    );
    const pulls = React.useMemo(() => (scope ? references.filter(needsPullStatus) : []), [references, scope]);
    const keys = React.useMemo(() => pulls.map(keyOf), [keyOf, pulls]);

    const [, bump] = React.useReducer((count: number) => count + 1, 0);
    React.useEffect(() => {
        const stops = keys.map((key) => githubPullStatuses.subscribe(key, bump));
        return () => stops.forEach((stop) => stop());
    }, [keys]);

    React.useEffect(() => {
        if (!github || pulls.length === 0) return;
        const byKey = new Map(pulls.map((pull) => [keyOf(pull), pull]));
        githubPullStatuses.ensureMany(keys, async (batch) => {
            const asked = batch.flatMap((key) => byKey.get(key) ?? []);
            const result = await sourceControl.githubPullStatuses(
                github,
                asked.map((pull) => ({ owner: pull.sourceRepo.owner, repo: pull.sourceRepo.repo, number: pull.number })),
            );
            if (!result.connected) throw new Error('GitHub is not connected');
            const answers = new Map<string, GitHubPullStatus | null>(batch.map((key) => [key, null]));
            for (const pull of asked) {
                answers.set(keyOf(pull), result.statuses.find((status) => samePull(status, pull)) ?? null);
            }
            return answers;
        }, PULL_STATUS_BATCH);
    }, [github, keyOf, keys, pulls, sourceControl]);

    return (reference: GitHubReference): CachedValue<GitHubPullStatus | null> => {
        if (!scope || !needsPullStatus(reference)) return IDLE;
        return githubPullStatuses.read(keyOf(reference)) ?? IDLE;
    };
}

const linearDetailKey = (workspace: string, issueId: string) => JSON.stringify([getRuntimeKey(), workspace, issueId]);

const fetchLinearIssue = async (linear: LinearAPI, issueId: string): Promise<LinearIssue> => {
    const result = await linear.issueGet(issueId);
    if (result.connected === false) throw new Error('Linear is not connected');
    if (!result.issue) throw new Error('Issue not found');
    return result.issue;
};

/**
 * A Linear issue with its description and comments, from the same cache the
 * preview fills: attaching an issue that was previewed asks Linear nothing.
 */
export function readLinearIssueDetail(linear: LinearAPI, issueId: string): Promise<LinearIssue> {
    const workspace = useLinearAuthStore.getState().status?.organization?.id ?? '';
    return linearDetails.ensure(linearDetailKey(workspace, issueId), () => fetchLinearIssue(linear, issueId));
}

/** The previewed Linear issue's description and comments; asked once `settled`, like GitHub's. */
export function useLinearIssueDetail(issueId: string | null, settled: boolean) {
    const { linear } = useRuntimeAPIs();
    const workspace = useLinearAuthStore((state) => state.status?.organization?.id ?? '');
    const key = issueId && linear ? linearDetailKey(workspace, issueId) : null;
    const fetch = React.useCallback(async () => {
        if (!linear || !issueId) throw new Error('Linear is not available here');
        return fetchLinearIssue(linear, issueId);
    }, [issueId, linear]);
    return { detail: useCachedValue(linearDetails, key, fetch, settled) };
}
