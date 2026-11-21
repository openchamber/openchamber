import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';

import { isVSCodeRuntime } from '@/lib/desktop';


export function useComposerRuntime() {
    const { git: runtimeGit, vscode: vscodeApi, trackers: runtimeTrackers } = useRuntimeAPIs();
    const isVSCode = isVSCodeRuntime();

    return {
        runtimeGit, vscodeApi, runtimeTrackers, isVSCode,
    };
}
