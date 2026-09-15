type UserMessageModelFields = {
    providerID?: string;
    modelID?: string;
    variant?: string;
};

type NestedUserModel = {
    providerID?: string;
    modelID?: string;
    variant?: string;
};

type UserMessageModelSource = {
    providerID?: string;
    modelID?: string;
    variant?: string;
    model?: NestedUserModel | string | number | boolean | null;
};

const parseNonEmptyString = (value: string | undefined): string | undefined => {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
};

const readNestedUserModel = (model: UserMessageModelSource['model']): NestedUserModel | undefined => {
    if (model === null || model === undefined) return undefined;
    if (Array.isArray(model)) return undefined;
    if (model instanceof Object) return model;
    return undefined;
};

/**
 * Read providerID, modelID, and variant from a user message.
 *
 * Server-confirmed user messages nest these under `model`. Optimistic user
 * messages set the same fields at the top level and set `model` to a
 * "provider/model" string. Non-object `model` values are ignored so the
 * top-level fallback wins.
 *
 * `extractUserModelChoice` in `lib/messages/userModelChoice.ts` reads the same
 * message shape for composer restore; keep both in step if that shape changes.
 * This one stays separate because it also falls back to the top level for an
 * unconfirmed optimistic message, which composer restore does not want.
 */
export const readUserMessageModelFields = (info: UserMessageModelSource): UserMessageModelFields => {
    const nested = readNestedUserModel(info.model);
    return {
        providerID: parseNonEmptyString(nested?.providerID) ?? parseNonEmptyString(info.providerID),
        modelID: parseNonEmptyString(nested?.modelID) ?? parseNonEmptyString(info.modelID),
        variant: parseNonEmptyString(nested?.variant) ?? parseNonEmptyString(info.variant),
    };
};
