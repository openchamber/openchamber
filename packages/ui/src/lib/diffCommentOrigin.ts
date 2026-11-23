
import { z } from 'zod';
import { sourceControlProviderIdSchema } from '@/lib/source-control/providers/descriptor';
import { readSourceControlProvider } from '@/lib/source-control/providers/registry';
import { formatChangeRequestReference } from '@/lib/source-control/providers/terminology';
import type { SourceControlProvider } from '@/lib/source-control/types';
import type { WalkthroughSource, WalkthroughTarget } from '@/lib/walkthrough/types';

export const diffCommentOriginSchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('working-tree'), staged: z.boolean().optional() }),
    z.object({ kind: z.literal('turn'), turnId: z.string().min(1).optional() }),
    z.object({ kind: z.literal('commit'), hash: z.string().min(1) }),
    z.object({ kind: z.literal('branch'), baseRef: z.string().min(1), headRef: z.string().min(1) }),
    z.object({
        kind: z.literal('change-request'),
        provider: sourceControlProviderIdSchema.optional(),
        number: z.number().int().positive(),
        repository: z.string().min(1).optional(),
        revision: z.string().min(1).optional(),
    }),
]);

export type DiffCommentOrigin = z.infer<typeof diffCommentOriginSchema>;

const shortHash = (hash: string) => hash.slice(0, 10);

export function diffCommentOriginFromSource(
    source: WalkthroughSource | null | undefined,
    changeRequest?: { provider?: SourceControlProvider | null; revision?: string | null },
): DiffCommentOrigin | undefined {
    if (!source) return undefined;
    switch (source.kind) {
        case 'working-tree':
            return { kind: 'working-tree', staged: source.scope === 'staged' ? true : undefined };
        case 'commit':
            return { kind: 'commit', hash: source.hash };
        case 'branch':
            return { kind: 'branch', baseRef: source.baseRef, headRef: source.headRef };
        case 'pr': {
            const origin: DiffCommentOrigin = { kind: 'change-request', number: source.number };
            if (changeRequest?.provider) origin.provider = changeRequest.provider;
            if (source.sourceRepo) origin.repository = `${source.sourceRepo.owner}/${source.sourceRepo.repo}`;
            const revision = source.revision ?? changeRequest?.revision;
            if (revision) origin.revision = revision;
            return origin;
        }
    }
}

export function diffCommentOriginKey(origin: DiffCommentOrigin | undefined): string {
    if (!origin) return '';
    switch (origin.kind) {
        case 'working-tree':
            return origin.staged ? 'worktree:staged' : 'worktree';
        case 'turn':
            return `turn:${origin.turnId ?? ''}`;
        case 'commit':
            return `commit:${origin.hash}`;
        case 'branch':
            return `branch:${origin.baseRef}...${origin.headRef}`;
        case 'change-request':
            return `cr:${origin.provider ?? ''}:${origin.repository ?? ''}:${origin.number}`;
    }
}

const changeRequestReference = (origin: Extract<DiffCommentOrigin, { kind: 'change-request' }>) => (
    origin.provider ? formatChangeRequestReference(readSourceControlProvider(origin.provider), origin.number) : `#${origin.number}`
);

function diffCommentOriginLabel(origin: DiffCommentOrigin): string | null {
    switch (origin.kind) {
        case 'working-tree':
        case 'turn':
            return null;
        case 'commit':
            return shortHash(origin.hash);
        case 'branch':
            return origin.headRef;
        case 'change-request':
            return changeRequestReference(origin);
    }
}

export function describeDiffCommentOrigin(origin: DiffCommentOrigin): string {
    switch (origin.kind) {
        case 'working-tree':
            return origin.staged
                ? 'in the staged changes, not committed yet'
                : 'in the uncommitted changes in the working tree';
        case 'turn':
            return 'in the changes an agent turn made, as recorded for that turn (the files may have changed since)';
        case 'commit':
            return `in commit ${shortHash(origin.hash)}`;
        case 'branch':
            return `in the changes of branch \`${origin.headRef}\` compared with \`${origin.baseRef}\``;
        case 'change-request': {
            const descriptor = origin.provider ? readSourceControlProvider(origin.provider) : null;
            const noun = descriptor ? `${descriptor.label} ${descriptor.terminology.promptNoun}` : 'pull request';
            const repository = origin.repository ? ` in ${origin.repository}` : '';
            const revision = origin.revision ? ` at commit ${shortHash(origin.revision)}` : '';
            return `in ${noun} ${changeRequestReference(origin)}${repository}${revision}`;
        }
    }
}

export function fileWithDiffCommentOrigin(file: string, origin: DiffCommentOrigin | undefined): string {
    const label = origin ? diffCommentOriginLabel(origin) : null;
    return label ? `${file} (${label})` : file;
}

export function diffCommentOriginFromTarget(target: WalkthroughTarget): DiffCommentOrigin | undefined {
    return 'context' in target
        ? diffCommentOriginFromSource(target.source, { provider: target.context.provider })
        : diffCommentOriginFromSource(target.source);
}
