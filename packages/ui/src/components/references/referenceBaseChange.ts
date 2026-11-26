export const canChangeReferenceBase = (input: {
    linked?: boolean;
    branchWriteAccess?: boolean | undefined;
    baseChange: boolean;
    hasContext: boolean;
    hasOnChanged: boolean;
}): boolean => input.linked !== true
    && input.branchWriteAccess !== false
    && input.baseChange
    && input.hasContext
    && input.hasOnChanged;
