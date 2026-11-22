import React from 'react';
import { toast } from '@/components/ui';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Icon } from '@/components/icon/Icon';
import { ModelPickerList, type ModelPickerEntry } from '@/components/model-picker/ModelPickerList';
import { useModelLists } from '@/hooks/useModelLists';
import { formatMessage, useI18n, useI18nStore } from '@/lib/i18n';
import type { SubagentPolicy } from '@/lib/opencode/model';
import {
    createSubagentPolicyWriter,
    splitSubagentPolicyModels,
    toggleSubagentModel,
} from '@/lib/opencode/subagentPolicy';
import { useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSubsessionDraftStore } from '@/stores/useSubsessionDraftStore';
import { useSessionSelector } from '@/sync/sync-context';
import { updateSessionSubagentPolicy } from '@/sync/session-actions';
import { cn } from '@/lib/utils';

interface SubsessionModelsControlProps {
    sessionId: string | null;
    directory?: string;
    /** A new-session draft is open: the selection is held for its create call. */
    draftOpen?: boolean;
    footerIconButtonClass: string;
    iconSizeClass: string;
    withTooltip?: boolean;
}

const selectSessionPolicy = (session: { subagentPolicy?: SubagentPolicy } | undefined) => session?.subagentPolicy;

const entryRef = (entry: ModelPickerEntry) => `${entry.providerID}/${entry.modelID}`;

/**
 * "Subsession models" picker, beside the composer's model picker.
 *
 * It is the composer's model list (`ModelPickerList`: search, keyboard
 * navigation, favorites, recents, provider order and collapsed sections)
 * with several models chosen at once. Choosing a row, by click or Enter,
 * checks or unchecks it and keeps the menu open. Route pools
 * (`opencode-route/<pool-id>`) are ordinary catalog entries, so they are
 * selectable like any other exact ref.
 *
 * On a session it edits the session's `subagentPolicy.models`. Each toggle
 * PATCHes the session with the whole updated policy, preserving
 * `excludedModels` and `agentOverrides` as loaded. Toggles made while a save
 * is in flight queue behind it and show at once; when the last save settles,
 * the checked state comes from the re-read session record again. Policy
 * entries that are not exact refs (`provider/*`, `provider/model#variant`)
 * were set through config or the API: they show as read-only rows above the
 * list and are preserved verbatim on save.
 *
 * In a new-session draft there is no session to PATCH, so the selection is
 * held in `useSubsessionDraftStore` and sent as `subagentPolicy` on create.
 */
export const SubsessionModelsControl: React.FC<SubsessionModelsControlProps> = React.memo(({
    sessionId,
    directory,
    draftOpen = false,
    footerIconButtonClass,
    iconSizeClass,
    withTooltip = false,
}) => {
    const { t } = useI18n();
    const providers = useConfigStore((state) => state.providers);
    const hiddenModels = useUIStore((state) => state.hiddenModels);
    const providerOrder = useUIStore((state) => state.providerOrder);
    const setProviderOrder = useUIStore((state) => state.setProviderOrder);
    const isFavoriteModel = useUIStore((state) => state.isFavoriteModel);
    const toggleFavoriteModel = useUIStore((state) => state.toggleFavoriteModel);
    const reorderFavoriteModel = useUIStore((state) => state.reorderFavoriteModel);
    const { favoriteModelsList, recentModelsList } = useModelLists();
    const draftModels = useSubsessionDraftStore((state) => state.models);
    const setDraftModels = useSubsessionDraftStore((state) => state.setModels);
    const savedPolicy = useSessionSelector(sessionId ?? undefined, directory, selectSessionPolicy);
    const [open, setOpen] = React.useState(false);
    const [searchQuery, setSearchQuery] = React.useState('');
    // The policy being saved, kept with the session it belongs to so a save
    // still settling for one session never shows in another.
    const [pending, setPending] = React.useState<{ sessionId: string; policy: SubagentPolicy } | null>(null);

    const isDraft = draftOpen && !sessionId;

    const writer = React.useMemo(() => {
        if (!sessionId) return null;
        return createSubagentPolicyWriter({
            write: async (policy) => {
                await updateSessionSubagentPolicy(sessionId, directory, policy);
            },
            onPendingChange: (policy) => setPending((previous) => {
                if (policy) return { sessionId, policy };
                return previous?.sessionId === sessionId ? null : previous;
            }),
            onError: (error) => {
                console.error('[SubsessionModelsControl] Failed to update subsession models:', error);
                toast.error(formatMessage(useI18nStore.getState().dictionary, 'chat.subsessionModels.saveFailed'));
            },
        });
    }, [directory, sessionId]);

    const handleOpenChange = React.useCallback((nextOpen: boolean) => {
        setOpen(nextOpen);
        if (!nextOpen) setSearchQuery('');
    }, []);

    const policy = pending && pending.sessionId === sessionId ? pending.policy : savedPolicy;
    const { exact, readOnly } = isDraft
        ? { exact: draftModels, readOnly: [] }
        : splitSubagentPolicyModels(policy);
    const checkedCount = exact.length + readOnly.length;
    const hasModels = providers.some((provider) => (Array.isArray(provider.models) ? provider.models : []).some((model) => (
        !hiddenModels.some((item) => item.providerID === provider.id && item.modelID === model.id)
    )));

    const labels = React.useMemo(() => ({
        searchPlaceholder: t('chat.modelControls.searchModels'),
        list: t('chat.subsessionModels.title'),
        noResults: hasModels ? t('chat.modelControls.noModelsFound') : t('chat.subsessionModels.empty'),
        favorites: t('chat.modelControls.favorites'),
        recent: t('chat.modelControls.recent'),
        keyboardHint: t('chat.modelControls.keyboardHintNavigate'),
        favorite: t('chat.modelControls.favoriteAria'),
        unfavorite: t('chat.modelControls.unfavoriteAria'),
        provider: t('chat.modelControls.provider'),
        capabilities: t('chat.modelControls.capabilities'),
        capabilityToolCalling: t('chat.modelControls.capability.toolCalling'),
        capabilityReasoning: t('chat.modelControls.capability.reasoning'),
        input: t('chat.modelControls.input'),
        output: t('chat.modelControls.output'),
        costPerMillion: t('chat.modelControls.costPerMillion'),
    }), [hasModels, t]);

    if (!isDraft && !sessionId) return null;

    const handleSelect = (entry: ModelPickerEntry) => {
        const ref = entryRef(entry);
        const checked = !exact.includes(ref);
        if (isDraft) {
            setDraftModels(toggleSubagentModel({ models: draftModels }, ref, checked).models ?? []);
            return;
        }
        writer?.toggle(savedPolicy, ref, checked);
    };

    const label = t('chat.subsessionModels.button');
    const button = (
        <button
            type="button"
            className={footerIconButtonClass}
            aria-label={label}
            aria-pressed={checkedCount > 0}
            {...(withTooltip ? {} : { title: label })}
        >
            <Icon name="node-tree" className={cn(iconSizeClass, 'text-current')} aria-hidden="true" />
        </button>
    );

    return (
        <DropdownMenu open={open} onOpenChange={handleOpenChange}>
            {withTooltip ? (
                <Tooltip>
                    <TooltipTrigger asChild>
                        <DropdownMenuTrigger asChild>{button}</DropdownMenuTrigger>
                    </TooltipTrigger>
                    <TooltipContent>{label}</TooltipContent>
                </Tooltip>
            ) : (
                <DropdownMenuTrigger asChild>{button}</DropdownMenuTrigger>
            )}
            <DropdownMenuContent
                side="top"
                align="start"
                className="w-[min(380px,calc(100vw-2rem))] p-0 flex flex-col overflow-hidden"
                constrainToMain
                collisionAvoidance={{ side: 'none', align: 'shift' }}
            >
                <div className="px-3 pt-2.5 pb-2 border-b border-border/40">
                    <div className="typography-meta font-medium text-foreground">
                        {t('chat.subsessionModels.title')}
                    </div>
                    <p className="typography-micro text-muted-foreground">
                        {t('chat.subsessionModels.hint')}
                    </p>
                    {readOnly.map((selector) => (
                        <div
                            key={selector}
                            className="mt-1 flex items-center gap-2"
                            title={t('chat.subsessionModels.readOnly')}
                        >
                            <Icon name="check" className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" aria-hidden="true" />
                            <span dir="ltr" className="min-w-0 flex-1 truncate typography-meta text-muted-foreground">{selector}</span>
                            <span className="shrink-0 typography-micro text-muted-foreground">
                                {t('chat.subsessionModels.readOnly')}
                            </span>
                        </div>
                    ))}
                </div>
                <ModelPickerList
                    providers={providers}
                    favoriteModels={favoriteModelsList}
                    recentModels={recentModelsList}
                    searchQuery={searchQuery}
                    onSearchQueryChange={setSearchQuery}
                    onSelect={handleSelect}
                    labels={labels}
                    isModelSelected={(entry) => exact.includes(entryRef(entry))}
                    hiddenModels={hiddenModels}
                    isFavorite={(entry) => isFavoriteModel(entry.providerID, entry.modelID)}
                    onToggleFavorite={(entry) => toggleFavoriteModel(entry.providerID, entry.modelID)}
                    onReorderFavorite={(active, over) => reorderFavoriteModel(
                        active.providerID,
                        active.modelID,
                        over.providerID,
                        over.modelID,
                    )}
                    reorderFavoriteAriaLabel={t('chat.modelControls.reorderFavoriteAria')}
                    reorderFavoriteTitle={t('chat.modelControls.reorderFavoriteTitle')}
                    providerOrder={providerOrder}
                    onReorderProvider={setProviderOrder}
                    reorderProviderTitle={t('chat.modelControls.reorderProviderTitle')}
                    maxHeightClassName="max-h-[min(400px,calc(var(--available-height)-8rem))] flex-1"
                    tooltipsEnabled={open}
                    onEscape={() => handleOpenChange(false)}
                />
            </DropdownMenuContent>
        </DropdownMenu>
    );
});
