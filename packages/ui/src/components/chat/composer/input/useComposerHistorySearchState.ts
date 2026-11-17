import React from 'react';



export function useComposerHistorySearchState(composerFormRef: React.RefObject<HTMLFormElement | null>) {
    const [promptHistorySearch, setPromptHistorySearch] = React.useState<{
        identity: string;
        initialQuery: string;
        olderRequest: number;
    } | null>(null);

    const [promptHistorySearchOwner, setPromptHistorySearchOwner] = React.useState<HTMLFormElement | null>(null);

    const [historyFocusPending, setHistoryFocusPending] = React.useState(false);

    const setPromptHistorySearchForm = React.useCallback((node: HTMLFormElement | null) => {
        composerFormRef.current = node;
        setPromptHistorySearchOwner(node);
    }, [composerFormRef]);

    return {
    promptHistorySearch, setPromptHistorySearch, promptHistorySearchOwner, historyFocusPending,
    setHistoryFocusPending, setPromptHistorySearchForm,
    };
}
