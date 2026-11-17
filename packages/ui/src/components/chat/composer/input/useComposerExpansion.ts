import { useChatColumnExpandedInput } from '../../chatColumnSession';



export function useComposerExpansion(isBtwActive: boolean, isMobile: boolean) {
    const { expanded: persistedExpandedInput, setExpanded: setExpandedInput } = useChatColumnExpandedInput();

    const isExpandedInput = !isBtwActive && persistedExpandedInput;
    const isDesktopExpanded = isExpandedInput && !isMobile;

    const isMobileExpanded = isExpandedInput && isMobile;

    const isComposerExpanded = isDesktopExpanded || isMobileExpanded;

    return {
        setExpandedInput, isExpandedInput, isDesktopExpanded, isMobileExpanded, isComposerExpanded,
    };
}
