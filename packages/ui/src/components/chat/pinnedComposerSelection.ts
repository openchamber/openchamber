import React from 'react';
import type { Session } from '@/lib/opencode/model';
import type { BtwSelection } from '@/stores/useBtwStore';
import { useSelectionStore } from '@/sync/selection-store';
import { useSession } from '@/sync/sync-context';

const isNoEffort = (variant: string) => variant === 'default';

const recordVariant = (record: Pick<Session, 'model'> | undefined): string | undefined => {
    const variant = record?.model?.variant?.trim();
    return variant && !isNoEffort(variant) ? variant : undefined;
};

const savedPick = (variant: string | null): string | null => (
    variant !== null && isNoEffort(variant.trim()) ? null : variant
);

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
        variant: savedVariant !== undefined ? savedPick(savedVariant) : recordVariant(record),
    };
};

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
