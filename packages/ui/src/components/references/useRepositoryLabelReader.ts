/** Reads the labels of the repository the reference browser points at. */

import * as React from 'react';

import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { projectOfBinding } from '@/lib/source-control/repositoryProject';
import { useSourceControlProviders } from '@/lib/source-control/providers/registry';
import { useRepositoryBinding } from '@/lib/source-control/repository-binding';
import { useSourceControlAuthStore } from '@/stores/useSourceControlAuthStore';

import { useRepositoryReadContext } from './referenceSources';

/**
 * Reads the labels of the repository the browser points at, when its filter
 * opens. Disabled on a tracker or a discussion, where the filter is not shown.
 * `ready` says the read can be attempted: it is false while the folder's
 * binding and accounts still load, and the returned read then fails on its own
 * message.
 */
export function useRepositoryLabelReader(
    enabled: boolean,
    directory: string | null,
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
    const read = React.useMemo(() => async () => {
        if (!readable || !project) throw new Error('The repository could not be identified');
        return sourceControl.referenceLabels(readable, project);
    }, [project, readable, sourceControl]);
    return { ready: context !== null, read };
}
