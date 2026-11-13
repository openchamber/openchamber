/**
 * Which diff a code comment was written on. A comment on uncommitted changes
 * needs none: its lines are the files on disk. A comment on a commit, a branch
 * comparison or a change request names lines the checkout may not have, so the
 * model is told where they come from, and the chip shows it too.
 */

import { z } from 'zod';
import { sourceControlProviderIdSchema } from '@/lib/source-control/providers/descriptor';
import { readSourceControlProvider } from '@/lib/source-control/providers/registry';
import { formatChangeRequestReference } from '@/lib/source-control/providers/terminology';
import type { SourceControlProvider } from '@/lib/source-control/types';
import type { WalkthroughSource, WalkthroughTarget } from '@/lib/walkthrough/types';

export const diffCommentOriginSchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('commit'), hash: z.string().min(1) }),
    z.object({ kind: z.literal('branch'), baseRef: z.string().min(1), headRef: z.string().min(1) }),
    z.object({
        kind: z.literal('change-request'),
        /** Absent when the surface did not know its host; read as a plain pull request. */
        provider: sourceControlProviderIdSchema.optional(),
        number: z.number().int().positive(),
        /** `owner/repo` when the change request lives outside the bound repository. */
        repository: z.string().min(1).optional(),
        /** The head commit the diff was read at, when known. */
        revision: z.string().min(1).optional(),
    }),
]);

export type DiffCommentOrigin = z.infer<typeof diffCommentOriginSchema>;

const shortHash = (hash: string) => hash.slice(0, 10);

/**
 * The origin of a comparison a surface shows. Uncommitted changes have none.
 * `revision` is the change request's head when the surface knows it.
 */
export function diffCommentOriginFromSource(
    source: WalkthroughSource | null | undefined,
    changeRequest?: { provider?: SourceControlProvider | null; revision?: string | null },
): DiffCommentOrigin | undefined {
    if (!source) return undefined;
    switch (source.kind) {
        case 'working-tree':
            return undefined;
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

/** Identity for matching drafts to the surface they were written on. */
export function diffCommentOriginKey(origin: DiffCommentOrigin | undefined): string {
    if (!origin) return '';
    switch (origin.kind) {
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

/** The short name a chip shows beside the file: `#5543`, `a1b2c3d4e5`, `feature`. */
function diffCommentOriginLabel(origin: DiffCommentOrigin): string {
    switch (origin.kind) {
        case 'commit':
            return shortHash(origin.hash);
        case 'branch':
            return origin.headRef;
        case 'change-request':
            return changeRequestReference(origin);
    }
}

/** English for the model: where the commented lines come from. */
export function describeDiffCommentOrigin(origin: DiffCommentOrigin): string {
    switch (origin.kind) {
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

/** A file name as chips show it, with the diff it came from when not on disk: `app.ts (#5543)`. */
export function fileWithDiffCommentOrigin(file: string, origin: DiffCommentOrigin | undefined): string {
    return origin ? `${file} (${diffCommentOriginLabel(origin)})` : file;
}

/** The origin of what a walkthrough reads. */
export function diffCommentOriginFromTarget(target: WalkthroughTarget): DiffCommentOrigin | undefined {
    return 'context' in target
        ? diffCommentOriginFromSource(target.source, { provider: target.context.provider })
        : diffCommentOriginFromSource(target.source);
}
