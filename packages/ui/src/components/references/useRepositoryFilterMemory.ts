/** The repository filter a folder last used, remembered per repository and tab. */

import * as React from 'react';

import type { RepositoryReferenceFilter, RepositoryReferenceKind } from '@/lib/api/types';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import {
    rememberRepositoryFilter,
    repositoryFilterKey,
    savedRepositoryFilter,
} from '@/lib/source-control/repositoryFilterMemory';
import { projectOfBinding } from '@/lib/source-control/repositoryProject';
import { useSourceControlProviders } from '@/lib/source-control/providers/registry';
import { useRepositoryBinding } from '@/lib/source-control/repository-binding';
import { useSourceControlAuthStore } from '@/stores/useSourceControlAuthStore';

import { useRepositoryReadContext } from './referenceSources';

/**
 * The persisted filter of the repository a folder's items are read from, for
 * one tab. `key` is null while the binding and accounts still load, or for a
 * folder that names no readable project, and then nothing is read or written.
 * The repository is resolved exactly as the label reader resolves it, so the
 * labels a fork clone reads belong to the same entry as its upstream.
 */
export function useRepositoryFilterMemory(
    enabled: boolean,
    directory: string | null,
    kind: RepositoryReferenceKind,
) {
    const { sourceControl } = useRuntimeAPIs();
    const context = useRepositoryReadContext(enabled ? directory : null);
    const binding = useRepositoryBinding(enabled ? directory : null, sourceControl, enabled && Boolean(directory));
    const identities = useSourceControlAuthStore((state) => state.identities);
    const descriptors = useSourceControlProviders();
    const readable = context && context !== 'missing' ? context : null;
    const project = React.useMemo(
        () => projectOfBinding(binding.read, readable?.provider ?? null, readable?.instance ?? null, identities, descriptors),
        [binding.read, descriptors, identities, readable?.instance, readable?.provider],
    );
    const key = readable && project ? repositoryFilterKey(readable.provider, readable.instance, project, kind) : null;
    const saved = React.useMemo(() => (key ? savedRepositoryFilter(key) : null), [key]);
    const remember = React.useCallback((filter: RepositoryReferenceFilter) => {
        if (key) rememberRepositoryFilter(key, filter);
    }, [key]);
    return { key, saved, remember };
}
