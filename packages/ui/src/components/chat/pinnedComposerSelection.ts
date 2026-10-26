import React from 'react';
import type { Session } from '@/lib/opencode/model';
import type { BtwSelection } from '@/stores/useBtwStore';
import { useSelectionStore } from '@/sync/selection-store';
import { useSession } from '@/sync/sync-context';

/**
 * What a pinned composer sends with: the picks saved for its session first,
 * then the session record, which is what OpenCode 2 runs the next prompt on.
 * An effort saved for the picked agent and model wins over the record's; an
 * effort saved as `null` is an explicit "Default".
 */
export const resolvePinnedComposerSelection = ({ savedAgent, savedModel, savedVariant, record }: {
    savedAgent: string | null;
    savedModel: { providerId: string; modelId: string } | null;
    savedVariant: string | null | undefined;
    record: Pick<Session, 'agent' | 'model'> | undefined;
}): BtwSelection => {
    const recordModel = record?.model?.providerID && record.model.id
        ? { providerId: record.model.providerID, modelId: record.model.id }
        : null;
    return {
        agent: savedAgent ?? (record?.agent?.trim() || undefined),
        model: savedModel ?? recordModel,
        variant: savedVariant !== undefined ? savedVariant : record?.model?.variant?.trim() || undefined,
    };
};

/**
 * The model, agent and effort a pinned column's composer (a chat open in the
 * side panel) sends with. The app-wide current model belongs to the main
 * chat, so a pinned composer keeps its own: what was picked in it, saved for
 * its session the way the `/btw` composer saves its picks, and otherwise what
 * the session record names. Null outside a pinned column.
 */
export const usePinnedComposerSelection = ({ enabled, sessionId, directory }: {
    enabled: boolean;
    sessionId: string | null;
    directory: string | null;
}): BtwSelection | null => {
    const key = enabled ? sessionId : null;
    const record = useSession(key ?? undefined, directory ?? undefined);
    const savedAgent = useSelectionStore((state) => (key ? state.sessionAgentSelections.get(key) ?? null : null));
    const savedModel = useSelectionStore((state) => (key ? state.sessionModelSelections.get(key) ?? null : null));
    const base = resolvePinnedComposerSelection({ savedAgent, savedModel, savedVariant: undefined, record });
    const savedVariant = useSelectionStore((state) => (key && base.agent && base.model
        ? state.getAgentModelVariantForSession(key, base.agent, base.model.providerId, base.model.modelId)
        : undefined));
    const { agent, model, variant } = resolvePinnedComposerSelection({ savedAgent, savedModel, savedVariant, record });
    const providerId = model?.providerId;
    const modelId = model?.modelId;
    return React.useMemo(() => {
        if (!key) return null;
        return {
            agent,
            model: providerId && modelId ? { providerId, modelId } : null,
            variant,
        };
    }, [agent, key, modelId, providerId, variant]);
};
